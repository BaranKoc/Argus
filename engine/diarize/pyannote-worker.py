"""Isolated local Pyannote Community-1 diarization worker.

argv: <audio path> <local model directory> [device]. device is auto|cuda|cpu and
defaults to cpu, which is what the shipped runtime can actually do — its torch is the
CPU wheel. The parent reads the result marker line and, if present, a stats marker
line; all failures deliberately exit non-zero so transcription can continue
speaker-less.

Community-1's own pipeline decides speaker identity from one embedding per 10s
sliding window. On short meetings whose turns alternate every few seconds that
window straddles both speakers, the segmentation model reports a single local
speaker, and every window yields the same blended embedding — so clustering sees
one speaker no matter how distinct the voices are. We therefore keep the
pipeline's speech timeline (its VAD is accurate) but re-derive speaker identity
from short uniform windows, scored through the model's own PLDA/VBx machinery.
Any failure in that path falls back to the pipeline's own labels.
"""

import json
import os
import sys
import time
import wave

MARKER = "__DIAR_RESULT__"
STATS_MARKER = "__DIAR_STATS__"

# Long enough for a stable speaker embedding, short enough to sit inside one turn.
WINDOW_SEC = 1.5
HOP_SEC = 0.75
# Shorter windows straddle a speaker change by less, so they place the boundary more
# precisely — but they are too noisy to cluster from scratch, which is why they are
# only ever scored against centroids the coarse pass has already settled.
FINE_WINDOW_SEC = 0.75
FINE_HOP_SEC = 0.15
# How far either side of a coarse speaker change the fine pass may move it.
REFINE_RADIUS_SEC = 1.0
# Reference windows sampled per speaker to anchor the fine pass.
FINE_REFERENCE_MAX = 24
# Resolution at which window votes are resolved back into speaker segments.
FRAME_SEC = 0.05
MIN_SEGMENT_SEC = 0.25
# A speaker holding less than this much of the meeting is a clustering artifact —
# whispered, coughed or crosstalk windows that embed unlike anything else. Folding
# them into the nearest real speaker costs little and avoids inventing a speaker.
MIN_SPEAKER_SEC = 5.0
# Community-1 tunes clustering for one embedding per 10s window. Our windows are
# 1.5s, so each carries less evidence: the AHC cut has to be looser and VBx's
# acoustic scale higher, or the prior swamps the acoustics and merges everyone.
AHC_THRESHOLD = 0.70
VBX_FA = 0.20
# The coarse pass embeds every window of the meeting. On CPU that is one stack the
# allocator can spill to RAM; on an 8 GB GPU a 25-minute meeting is ~1600 windows and
# the ResNet forward would OOM, so CUDA runs in slices. CPU keeps the single stack so
# its timing stays comparable with every measurement taken before this split existed.
EMBED_BATCH_CUDA = 64
MIN_EMBED_BATCH = 4


def resolve_device(requested: str):
    """Turn auto|cuda|cpu into a torch.device, plus the reason we did not honour it.

    'cuda' is strict and raises when there is no GPU. Speaker separation is a GPU-only
    product feature: CPU took 11.7 min on a 24.5 min meeting against 1.0 min on a GPU, so
    a silent fallback would hand the user a result so slow it reads as a hang. Failing
    instead lets the parent finish the transcript without speakers, which is the honest
    outcome. 'auto' keeps the old lenient behaviour for the benchmark.
    """
    import torch

    requested = (requested or "cpu").strip().lower()
    if requested not in ("auto", "cuda", "cpu"):
        raise RuntimeError(f"unknown device '{requested}' (expected auto|cuda|cpu)")

    if requested == "cpu":
        return torch.device("cpu"), None
    if torch.cuda.is_available():
        return torch.device("cuda"), None
    if requested == "cuda":
        raise RuntimeError(f"CUDA required but unavailable (torch {torch.__version__})")

    # English, like every other message here: stderr goes to whatever console the parent
    # has, and a cp1252 one raises UnicodeEncodeError on Turkish characters — which would
    # kill the worker on the very path that exists to keep it alive.
    reason = f"CUDA not available (torch {torch.__version__}); running on CPU."
    print(f"[pyannote-worker] {reason}", file=sys.stderr)
    return torch.device("cpu"), reason


def clock(device):
    """perf_counter, but only after the GPU has actually finished.

    CUDA kernels are queued asynchronously, so an un-synchronised timestamp measures
    how fast Python got to the next line, not how long the work took.
    """
    import torch

    if device.type == "cuda":
        torch.cuda.synchronize()
    return time.perf_counter()


def peak_rss_mb():
    """Peak working set of this process, or None where we cannot ask for it."""
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        # restype/argtypes are not decoration: without them ctypes passes the -1 pseudo
        # handle as a 32-bit int, the x64 callee reads a 64-bit HANDLE of 0x00000000FFFFFFFF,
        # and the call fails silently — which is how this first returned None.
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.GetCurrentProcess.argtypes = []
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]

        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        ok = psapi.GetProcessMemoryInfo(
            kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb
        )
        return round(counters.PeakWorkingSetSize / (1024 ** 2), 1) if ok else None

    try:
        import resource
    except ImportError:
        return None
    # ru_maxrss is KB on Linux, bytes on macOS.
    maximum = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(maximum / (1024 ** 2 if sys.platform == "darwin" else 1024), 1)


def load_recorded_wav(audio_path: str):
    """Return the app's 16-bit PCM WAV as Pyannote's in-memory audio shape.

    The renderer deliberately produces this constrained format. Supplying the
    waveform avoids TorchCodec/FFmpeg discovery inside the packaged Python
    environment, while keeping every meeting sample on the local machine.
    """
    with wave.open(audio_path, "rb") as wav:
        if wav.getcomptype() != "NONE" or wav.getsampwidth() != 2:
            raise RuntimeError("expected uncompressed 16-bit PCM WAV")
        channels = wav.getnchannels()
        sample_rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())

    if channels < 1 or sample_rate < 1:
        raise RuntimeError("invalid WAV format")

    import torch

    samples = torch.frombuffer(memoryview(frames), dtype=torch.int16).clone()
    waveform = samples.to(dtype=torch.float32).reshape(-1, channels).transpose(0, 1) / 32768.0
    return {"waveform": waveform, "sample_rate": sample_rate}


def plan_windows(regions, duration):
    """Uniform analysis windows over speech, as (crop start, mask start, mask end).

    A region shorter than WINDOW_SEC still gets a full-length crop so the batch stays
    rectangular; the mask restricts the embedding to the speech part, and the embedder
    returns NaN when what is left is too short to score.
    """
    windows = []
    for start, end in regions:
        span = end - start
        if span >= WINDOW_SEC:
            position = start
            while position + WINDOW_SEC <= end + 1e-6:
                windows.append((position, position, position + WINDOW_SEC))
                position += HOP_SEC
            # Cover a tail the fixed hop would otherwise leave unscored.
            if end - (position - HOP_SEC + WINDOW_SEC) > 0.3:
                windows.append((end - WINDOW_SEC, end - WINDOW_SEC, end))
        else:
            crop = min(max(start - (WINDOW_SEC - span) / 2, 0.0), max(duration - WINDOW_SEC, 0.0))
            windows.append((crop, start, end))
    return windows


def embed_batch_size(embedder, total):
    """How many windows to hand the embedder at once.

    Read off the embedder rather than threaded through every caller: its own `.device`
    is the thing that decides whether a stack has to fit in VRAM. ENGINE_DIARIZE_EMBED_BATCH
    overrides it for tuning without touching code.
    """
    device = getattr(embedder, "device", None)
    if device is None or getattr(device, "type", "cpu") != "cuda":
        return total
    override = os.environ.get("ENGINE_DIARIZE_EMBED_BATCH")
    if override and override.isdigit() and int(override) > 0:
        return int(override)
    return EMBED_BATCH_CUDA


def run_embedder(embedder, crops, masks, batch):
    """Embed in slices of `batch`, halving on CUDA OOM until it fits or we give up."""
    import numpy as np
    import torch

    if not crops:
        return np.empty((0, 0))

    while True:
        try:
            chunks = [
                np.asarray(embedder(torch.stack(crops[start:start + batch]),
                                    masks=torch.stack(masks[start:start + batch])))
                for start in range(0, len(crops), batch)
            ]
            return np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
        except torch.cuda.OutOfMemoryError:
            if batch <= MIN_EMBED_BATCH:
                raise
            batch = max(MIN_EMBED_BATCH, batch // 2)
            torch.cuda.empty_cache()
            print(f"[pyannote-worker] CUDA OOM; embed batch reduced to {batch}.", file=sys.stderr)


def embed_windows(waveform, sample_rate, embedder, windows, window_sec=None):
    """Embed (crop start, mask start, mask end) windows, dropping any the model rejects."""
    import numpy as np
    import torch

    size = int((window_sec or WINDOW_SEC) * sample_rate)
    crops, masks = [], []
    for crop_start, mask_start, mask_end in windows:
        offset = int(crop_start * sample_rate)
        chunk = waveform[:, offset:offset + size]
        if chunk.shape[1] < size:
            chunk = torch.nn.functional.pad(chunk, (0, size - chunk.shape[1]))
        mask = torch.zeros(size)
        mask[max(0, int((mask_start - crop_start) * sample_rate)):int((mask_end - crop_start) * sample_rate)] = 1.0
        crops.append(chunk)
        masks.append(mask)

    with torch.no_grad():
        embeddings = run_embedder(embedder, crops, masks, embed_batch_size(embedder, len(crops)))
    usable = ~np.isnan(embeddings).any(axis=1)
    return embeddings[usable], usable


def embed_spans(waveform, sample_rate, embedder, spans, window_sec):
    embedded, usable = embed_windows(
        waveform, sample_rate, embedder, [(start, start, end) for start, end in spans], window_sec
    )
    return embedded, [span for span, keep in zip(spans, usable) if keep], usable


def cluster_windows(clustering, embeddings):
    """Label each window using Community-1's own AHC-initialised VBx clustering."""
    import numpy as np
    from pyannote.audio.pipelines.clustering import cluster_vbx
    from scipy.cluster.hierarchy import fcluster, linkage

    if len(embeddings) < 2:
        return np.zeros(len(embeddings), dtype=int)

    normed = embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True)
    initial = fcluster(
        linkage(normed, method="centroid", metric="euclidean"),
        AHC_THRESHOLD,
        criterion="distance",
    ) - 1
    _, initial = np.unique(initial, return_inverse=True)

    responsibilities, presence = cluster_vbx(
        initial,
        clustering.plda(embeddings),
        clustering.plda.phi,
        Fa=VBX_FA,
        Fb=clustering.Fb,
        maxIters=20,
    )
    return np.argmax(responsibilities[:, presence > 1e-7], axis=1)


def drop_marginal_speakers(labels, embeddings, regions, windows, duration):
    """Fold under-represented clusters into their nearest neighbour, smallest first."""
    import numpy as np

    normed = embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True)
    while True:
        turns = windows_to_turns(regions, windows, labels, duration)
        spoken = {}
        for start, end, label in turns:
            spoken[label] = spoken.get(label, 0.0) + end - start
        if len(spoken) <= 1:
            return labels, turns
        weakest = min(spoken, key=spoken.get)
        if spoken[weakest] >= MIN_SPEAKER_SEC:
            return labels, turns

        centroids = {label: normed[labels == label].mean(axis=0) for label in set(labels.tolist())}
        others = [label for label in centroids if label != weakest]
        if weakest not in centroids or not others:
            return labels, turns
        nearest = max(others, key=lambda label: float(centroids[label] @ centroids[weakest]))
        labels = np.where(labels == weakest, nearest, labels)


def speech_mask(regions, duration):
    import numpy as np

    frames = int(np.ceil(duration / FRAME_SEC))
    speech = np.zeros(frames, dtype=bool)
    for start, end in regions:
        speech[int(start / FRAME_SEC):int(np.ceil(end / FRAME_SEC))] = True
    return speech


def windows_to_frames(regions, windows, labels, duration):
    """Resolve overlapping window votes into a per-frame speaker label (-1 = silence)."""
    import numpy as np

    speech = speech_mask(regions, duration)
    frames = len(speech)

    num_labels = int(labels.max()) + 1
    votes = np.zeros((frames, num_labels))
    centres = []
    for (_, mask_start, mask_end), label in zip(windows, labels):
        votes[int(mask_start / FRAME_SEC):int(np.ceil(mask_end / FRAME_SEC)), label] += 1.0
        centres.append((mask_start + mask_end) / 2)
    centres = np.asarray(centres)

    assigned = np.full(frames, -1, dtype=int)
    voted = votes.sum(axis=1) > 0
    assigned[voted] = np.argmax(votes[voted], axis=1)
    # Speech too short to embed still belongs to whoever was speaking around it.
    orphans = np.flatnonzero(speech & ~voted)
    if orphans.size and centres.size:
        nearest = np.abs((orphans * FRAME_SEC + FRAME_SEC / 2)[:, None] - centres[None, :]).argmin(axis=1)
        assigned[orphans] = labels[nearest]
    assigned[~speech] = -1
    return assigned


def frames_to_turns(assigned):
    """Contiguous runs of one speaker, dropping slivers too short to be a real turn."""
    turns, start_frame, frames = [], None, len(assigned)
    for frame in range(frames + 1):
        current = assigned[frame] if frame < frames else -1
        previous = assigned[frame - 1] if frame > 0 else -1
        if frame > 0 and current != previous and previous >= 0:
            turns.append((start_frame * FRAME_SEC, frame * FRAME_SEC, int(previous)))
        if current >= 0 and (frame == 0 or current != previous):
            start_frame = frame
    return [turn for turn in turns if turn[1] - turn[0] >= MIN_SEGMENT_SEC]


def windows_to_turns(regions, windows, labels, duration):
    return frames_to_turns(windows_to_frames(regions, windows, labels, duration))


def fine_centroids(waveform, sample_rate, embedder, assigned, ids):
    """Per-speaker reference embeddings measured at the fine pass's own window length.

    A 0.75s embedding and a 1.5s one do not land in the same place for the same voice,
    so scoring fine windows against the coarse centroids carries a systematic bias that
    can hand a speaker's whole region to the other. Sampling the references from the
    settled interior of each speaker's turns removes the length mismatch.
    """
    import numpy as np

    edge = int(FINE_WINDOW_SEC / FRAME_SEC)
    spans, owners = [], []
    for speaker in ids:
        held = assigned == speaker
        # Interior only: a frame within a window's reach of another speaker would
        # contaminate the reference with the very confusion we are trying to resolve.
        interior = held.copy()
        for shift in range(1, edge + 1):
            interior &= np.roll(held, shift) & np.roll(held, -shift)
        candidates = np.flatnonzero(interior)
        if candidates.size == 0:
            return None
        picks = candidates[np.linspace(0, candidates.size - 1, min(candidates.size, FINE_REFERENCE_MAX)).astype(int)]
        for frame in picks:
            start = max(0.0, frame * FRAME_SEC - FINE_WINDOW_SEC / 2)
            spans.append((start, start + FINE_WINDOW_SEC))
            owners.append(speaker)

    embedded, _, usable = embed_spans(waveform, sample_rate, embedder, spans, FINE_WINDOW_SEC)
    if len(embedded) == 0:
        return None
    embedded = embedded / np.linalg.norm(embedded, axis=1, keepdims=True)
    owners = np.array(owners)[usable]

    centroids = []
    for speaker in ids:
        rows = embedded[owners == speaker]
        if rows.size == 0:
            return None
        centroid = rows.mean(axis=0)
        centroids.append(centroid / np.linalg.norm(centroid))
    return np.array(centroids)


def refine_boundaries(waveform, sample_rate, embedder, regions, assigned, labels, embeddings):
    """Re-place speaker changes that fall inside a single unbroken speech region.

    A coarse window straddling a speaker change embeds as one speaker — confidently,
    and not always the dominant one — so the change lands wherever the window grid
    happens to fall. That grid is anchored on VAD region starts, which shift with
    something as small as a 70ms gap appearing or not, making the boundary unstable.
    Where VAD already separates the turns its boundary is exact and nothing is redone;
    only regions that ended up holding two speakers are rescored, against the settled
    centroids, with shorter windows whose votes decay away from their own centre.
    """
    import numpy as np

    ids = sorted(set(labels.tolist()))
    centroids = fine_centroids(waveform, sample_rate, embedder, assigned, ids)
    if centroids is None:
        return assigned

    for region_start, region_end in regions:
        # VAD can place a region edge just past the decoded waveform, so clamp rather
        # than index off the end of the frame grid.
        low = max(0, int(region_start / FRAME_SEC))
        high = min(len(assigned), int(np.ceil(region_end / FRAME_SEC)))
        if region_end - region_start < 2 * FINE_WINDOW_SEC or high - low < 2:
            continue

        # Collected up front: rescoring a zone can introduce a change of its own, and
        # only the coarse pass's boundaries are meant to be reconsidered.
        changes = [
            (frame, int(assigned[frame - 1]), int(assigned[frame]))
            for frame in range(low + 1, high)
            if assigned[frame - 1] >= 0 and assigned[frame] >= 0 and assigned[frame - 1] != assigned[frame]
        ]
        for frame, left, right in changes:
            # Only frames around this one change are up for reconsideration, and only
            # between its own two speakers: a fine window is a sharper instrument than
            # a coarse one but a noisier judge, so it may move a boundary, never
            # relabel a whole region.
            zone_low = max(low, frame - int(REFINE_RADIUS_SEC / FRAME_SEC))
            zone_high = min(high, frame + int(REFINE_RADIUS_SEC / FRAME_SEC))
            pair = [ids.index(left), ids.index(right)]

            spans = []
            position = max(region_start, zone_low * FRAME_SEC - FINE_WINDOW_SEC)
            limit = min(region_end, zone_high * FRAME_SEC + FINE_WINDOW_SEC)
            while position < limit - FRAME_SEC:
                spans.append((position, min(position + FINE_WINDOW_SEC, region_end)))
                position += FINE_HOP_SEC
            if not spans:
                continue
            fine, spans, _ = embed_spans(waveform, sample_rate, embedder, spans, FINE_WINDOW_SEC)
            if len(fine) == 0:
                continue

            fine /= np.linalg.norm(fine, axis=1, keepdims=True)
            similarity = (fine @ centroids.T)[:, pair]
            votes = np.zeros((zone_high - zone_low, 2))
            for (span_start, span_end), row in zip(spans, similarity):
                centre = (span_start + span_end) / 2
                frames = np.arange(
                    max(zone_low, int(span_start / FRAME_SEC)),
                    min(zone_high, int(np.ceil(span_end / FRAME_SEC))),
                )
                if frames.size == 0:
                    continue
                distance = np.abs(frames * FRAME_SEC + FRAME_SEC / 2 - centre) / FINE_WINDOW_SEC
                weight = (row[0] - row[1]) * np.clip(1 - distance, 0, None)
                votes[frames - zone_low, 0 if row[0] > row[1] else 1] += np.abs(weight)

            decided = votes.sum(axis=1) > 0
            zone = assigned[zone_low:zone_high]
            zone[decided] = np.array([left, right])[np.argmax(votes[decided], axis=1)]
            assigned[zone_low:zone_high] = zone
    return assigned


def relabel(turns):
    """Stable SPEAKER_00-style names, numbered by first appearance."""
    names, out = {}, []
    for start, end, label in turns:
        if label not in names:
            names[label] = f"SPEAKER_{len(names):02d}"
        out.append({"start": float(start), "end": float(end), "speaker": names[label]})
    return out


def pipeline_turns(annotation):
    names, out = {}, []
    for turn, _, label in annotation.itertracks(yield_label=True):
        key = str(label)
        if key not in names:
            names[key] = f"SPEAKER_{len(names):02d}"
        out.append({"start": float(turn.start), "end": float(turn.end), "speaker": names[key]})
    return out


def run_diarization(audio, model_dir, device, stats):
    """One full diarization pass on `device`, filling `stats` with per-phase timings."""
    # Timed from before the import: `import pyannote.audio` costs seconds of its own, and
    # leaving it outside loadMs made the phases fail to add up to totalMs.
    started = clock(device)
    import torch
    from pyannote.audio import Pipeline

    pipeline = Pipeline.from_pretrained(model_dir)
    if device.type != "cpu":
        pipeline.to(device)
    stats["loadMs"] = round((clock(device) - started) * 1000)

    mark = clock(device)
    output = pipeline(audio)
    annotation = getattr(output, "exclusive_speaker_diarization", None)
    if annotation is None:
        annotation = output.speaker_diarization
    stats["pipelineMs"] = round((clock(device) - mark) * 1000)

    turns = pipeline_turns(annotation)
    try:
        regions = [(s.start, s.end) for s in annotation.get_timeline().support()]
        if regions:
            duration = audio["waveform"].shape[1] / audio["sample_rate"]
            windows = plan_windows(regions, duration)
            mark = clock(device)
            embeddings, usable = embed_windows(
                audio["waveform"], audio["sample_rate"], pipeline._embedding, windows
            )
            stats["embedMs"] = round((clock(device) - mark) * 1000)
            windows = [window for window, keep in zip(windows, usable) if keep]
            stats["windowCount"] = len(windows)
            if len(windows) >= 2:
                mark = clock(device)
                labels = cluster_windows(pipeline.clustering, embeddings)
                labels, _ = drop_marginal_speakers(labels, embeddings, regions, windows, duration)
                assigned = windows_to_frames(regions, windows, labels, duration)
                stats["clusterMs"] = round((clock(device) - mark) * 1000)

                mark = clock(device)
                assigned = refine_boundaries(
                    audio["waveform"], audio["sample_rate"], pipeline._embedding,
                    regions, assigned, labels, embeddings,
                )
                stats["refineMs"] = round((clock(device) - mark) * 1000)
                refined = frames_to_turns(assigned)
                if refined:
                    turns = relabel(refined)
    # An OOM is the one failure we do NOT absorb: main() retries the whole run on CPU
    # rather than quietly reporting the pipeline's coarser labels as if nothing happened.
    except torch.cuda.OutOfMemoryError:
        raise
    except Exception as error:  # noqa: BLE001 - the pipeline's own labels remain valid
        print(f"[pyannote-worker] window clustering skipped: {error}", file=sys.stderr)
        stats["windowClusteringSkipped"] = str(error)

    return turns


def main() -> None:
    if len(sys.argv) not in (3, 4):
        raise RuntimeError("usage: pyannote-worker.py <audioPath> <modelDir> [device]")

    audio_path, model_dir = sys.argv[1], sys.argv[2]
    requested = sys.argv[3] if len(sys.argv) == 4 else "cpu"
    if not os.path.isfile(audio_path):
        raise RuntimeError("audio file not found")
    if not os.path.isdir(model_dir):
        raise RuntimeError("local Pyannote model directory not found")

    # The model is installed into this local directory by the Electron main
    # process. No token and no meeting audio are sent over the network at runtime.
    os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
    os.environ["HF_HUB_OFFLINE"] = "1"
    # Community-1 is downloaded from the authenticated official Hugging Face
    # repository by the developer tool. PyTorch 2.6+ otherwise rejects its trusted
    # Pyannote checkpoint metadata before Pipeline.from_pretrained can load it.
    os.environ["TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD"] = "1"

    import torch

    device, fallback_reason = resolve_device(requested)
    audio = load_recorded_wav(audio_path)

    stats = {
        "requested": (requested or "cpu").strip().lower(),
        "device": device.type,
        "torch": torch.__version__,
        "cudaAvailable": torch.cuda.is_available(),
        "gpuName": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
        "fellBack": fallback_reason is not None,
        "fallbackReason": fallback_reason,
        "audioSec": round(audio["waveform"].shape[1] / audio["sample_rate"], 3),
        "loadMs": None,
        "pipelineMs": None,
        "embedMs": None,
        "clusterMs": None,
        "refineMs": None,
        "windowCount": None,
    }

    started = time.perf_counter()
    try:
        turns = run_diarization(audio, model_dir, device, stats)
    # Only 'auto' rescues an OOM on CPU. Under strict 'cuda' the run has already halved
    # its embed batch down to MIN_EMBED_BATCH and still not fit, and quietly spending
    # eleven minutes on the CPU instead is the outcome this mode exists to prevent.
    except torch.cuda.OutOfMemoryError as error:
        if device.type != "cuda" or stats["requested"] != "auto":
            raise
        print(f"[pyannote-worker] CUDA out of memory; retrying on CPU: {error}", file=sys.stderr)
        torch.cuda.empty_cache()
        device = torch.device("cpu")
        stats["device"] = "cpu"
        stats["fellBack"] = True
        stats["fallbackReason"] = f"CUDA OOM: {error}"
        turns = run_diarization(audio, model_dir, device, stats)

    stats["totalMs"] = round((time.perf_counter() - started) * 1000)
    stats["speakerCount"] = len({turn["speaker"] for turn in turns})
    stats["turnCount"] = len(turns)
    # Read after the retry: max_memory_allocated is a high-water mark that empty_cache
    # does not reset, so it still reports what the CUDA attempt actually needed.
    stats["peakVramMB"] = (
        round(torch.cuda.max_memory_allocated() / (1024 ** 2), 1) if torch.cuda.is_available() else None
    )
    stats["peakRssMB"] = peak_rss_mb()

    print(STATS_MARKER + json.dumps(stats), flush=True)
    print(MARKER + json.dumps(turns), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"[pyannote-worker] {error}", file=sys.stderr)
        sys.exit(1)
