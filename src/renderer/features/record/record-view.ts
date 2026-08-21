// The Record focus panel: a full-screen, Gemini-style view whose background gradient,
// center text, and control buttons are a pure function of the live pipeline state. The
// state machine itself is unchanged from the engine's live seam —
//
//   idle → recording ⇄ paused → finalizing → analyzing → done   (+ error)
//
// — this module only re-targets it onto the focus DOM. `state` is driven by the
// live:status push for every transition except 'done', which arrives via live:result
// (the event that also carries the saved meetingId for "Sonuçları Gör").

import { Recorder } from './recorder.ts';
import type { MeetingLanguage, MeetingScope } from '../../../preload/index.ts';
import { onViewChange } from '../../app/router.ts';

type LiveState = 'idle' | 'recording' | 'paused' | 'finalizing' | 'analyzing' | 'done' | 'error';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface RecordViewDeps {
  // Navigate to the just-finished meeting's detail (or the list if the save failed).
  onViewResults: (meetingId: string | null) => void;
}

// Per-state CSS token on #recordView (drives the gradient). `finalizing` is the
// engine's diarization/transcript-finishing phase — UI_01 calls it "transcribing".
const STATE_CLASS: Record<LiveState, string> = {
  idle: 'state-idle',
  recording: 'state-recording',
  paused: 'state-paused',
  finalizing: 'state-transcribing',
  analyzing: 'state-analyzing',
  done: 'state-done',
  error: 'state-error',
};

// Canonical center text per UI_01. The engine's no transcription-percentage, so
// "Yazıya Dökülüyor" stays indeterminate (no %).
function centerText(s: LiveState): string {
  switch (s) {
    case 'idle':
      return 'Hazır olunca kaydı başlatabilirsiniz';
    case 'recording':
      return 'Kaydediliyor…';
    case 'paused':
      return 'Mola Verildi';
    case 'finalizing':
      return 'Yazıya Dökülüyor…';
    case 'analyzing':
      return 'Yapay Zeka Analiz Ediyor…';
    case 'done':
      return 'Tamamlandı / İncelenebilir';
    case 'error':
      return 'Bir hata oluştu.';
  }
}

export function initRecordView(deps: RecordViewDeps): void {
  const root = $<HTMLElement>('recordView');
  const textEl = $<HTMLParagraphElement>('recordText');
  const kvkkEl = $<HTMLParagraphElement>('recordKvkk');
  const startBtn = $<HTMLButtonElement>('startBtn');
  const pauseBtn = $<HTMLButtonElement>('pauseBtn');
  const stopBtn = $<HTMLButtonElement>('stopBtn');
  const cancelBtn = $<HTMLButtonElement>('cancelRunBtn');
  const resultsBtn = $<HTMLButtonElement>('resultsBtn');
  // The container, not the two groups inside it: both choices appear and disappear
  // together, so one handle is all the state machine needs.
  const choices = $<HTMLElement>('recordChoices');
  const languageGroup = $<HTMLElement>('recordLanguage');
  const scopeGroup = $<HTMLElement>('recordScope');

  let state: LiveState = 'idle';
  let recorder: Recorder | null = null;
  let chunkSeconds: number | null = null;
  let lastMeetingId: string | null = null;
  let starting = false;
  let cancelling = false;
  // Set when the meeting was saved without its analysis, so refresh() keeps saying so
  // instead of falling back to the plain "Tamamlandı" text on the next repaint.
  let analysisFailed = false;
  // Per-meeting and deliberately not persisted: a stale 'foreign' from last week would
  // quietly transcribe a Turkish meeting with the weaker model.
  let meetingLanguage: MeetingLanguage = 'turkish';
  // Same rule, same reason: a stale 'two-party' would silently suppress speaker separation
  // in a meeting that needed it, and the loss only shows up in the finished transcript.
  let meetingScope: MeetingScope = 'group';

  function selectLanguage(next: MeetingLanguage): void {
    meetingLanguage = next;
    for (const option of languageGroup.querySelectorAll<HTMLButtonElement>('[data-language]')) {
      const active = option.dataset.language === next;
      option.classList.toggle('selected', active);
      option.setAttribute('aria-checked', String(active));
    }
    // Repaint the canvas only. NOT refresh(): that also rewrites the center text from
    // the state, which would wipe the message shown in the 'error' state — where this
    // selector is still visible.
    applyStateClass();
  }

  function selectScope(next: MeetingScope): void {
    meetingScope = next;
    for (const option of scopeGroup.querySelectorAll<HTMLButtonElement>('[data-scope]')) {
      const active = option.dataset.scope === next;
      option.classList.toggle('selected', active);
      option.setAttribute('aria-checked', String(active));
    }
  }

  const show = (el: HTMLElement, visible: boolean): void => {
    el.hidden = !visible;
  };

  // Owns className wholesale, so the language tint has to be applied here or the next
  // state change would drop it.
  function applyStateClass(): void {
    const analysisTint = analysisFailed ? ' analysis-failed' : '';
    root.className = `record-view ${STATE_CLASS[state]} lang-${meetingLanguage}${analysisTint}`;
  }

  // Button/text/gradient visibility as a pure function of state — the single enforcer of
  // the machine documented at the top.
  function refresh(detail?: string): void {
    applyStateClass();
    // `cancelling` outranks the incoming detail: the pipeline keeps pushing status
    // updates while it unwinds, and "Yazıya Dökülüyor…" reappearing after the user
    // confirmed a cancel reads as if the cancel was ignored.
    textEl.textContent = cancelling
      ? 'Toplantı iptal ediliyor…'
      : detail ?? centerText(state);

    const recording = state === 'recording' || state === 'paused';
    // The post-Stop pipeline: the only window where there is work to call off.
    const finalizing = state === 'finalizing' || state === 'analyzing';
    show(startBtn, state === 'idle' || state === 'error');
    // Same predicate as the start button: both choices are locked once a meeting begins,
    // so they disappear exactly when they stop being changeable. Hiding rather than
    // disabling is this file's existing idiom for "not available in this state".
    show(choices, state === 'idle' || state === 'error');
    show(pauseBtn, recording);
    show(stopBtn, recording);
    show(cancelBtn, finalizing && !cancelling);
    show(resultsBtn, state === 'done');

    // KVKK assurance: shown only once done — the audio was deleted before live:result
    // fired (ipc.ts ordering), so the "auto-deleted" claim is true by construction here.
    show(kvkkEl, state === 'done');

    // The one button that changes identity: pause vs. resume.
    if (state === 'paused') {
      pauseBtn.innerHTML = "<i class='bx bx-play-circle'></i> Devam Et";
    } else {
      pauseBtn.innerHTML = "<i class='bx bx-pause-circle'></i> Mola Ver";
    }
  }

  function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  // --- Start / Stop --------------------------------------------------------

  async function startRecording(): Promise<void> {
    if (starting || recorder) return;
    starting = true;
    const nextRecorder = new Recorder();

    // Start both media requests synchronously from the click gesture. In particular,
    // getDisplayMedia would be rejected if an awaited IPC call came first.
    const captureRequest = nextRecorder.acquire();
    const configRequest =
      chunkSeconds == null ? window.api.getLiveConfig() : Promise.resolve({ chunkSeconds });

    try {
      const [capture, config] = await Promise.allSettled([captureRequest, configRequest]);
      if (capture.status === 'rejected') throw capture.reason;
      if (config.status === 'rejected') throw config.reason;

      chunkSeconds = config.value.chunkSeconds;
      lastMeetingId = null;
      nextRecorder.prepare(
        (pcm, envelope) => window.api.livePushChunk(pcm, envelope),
        chunkSeconds,
      );

      // The recorder is prepared but gated, so the engine is ready before any sample can
      // reach it and a permission failure cannot leave an orphan session behind.
      await window.api.liveStart({ meetingLanguage, meetingScope });
      recorder = nextRecorder;
      recorder.begin();
      // state/status now driven by the live:status 'recording' push.
    } catch (e) {
      await nextRecorder.dispose().catch(() => undefined);
      recorder = null;
      state = 'error';
      refresh(`Mikrofona erişilemedi: ${errMsg(e)}`);
    } finally {
      starting = false;
    }
  }

  async function stopRecording(): Promise<void> {
    const rec = recorder;
    recorder = null;

    // Degrade gracefully: if the recorder or the WAV save fails, finalize still runs on
    // the already-computed live segments (audioPath = null → no diarization).
    let audioPath: string | null = null;
    try {
      const wav = await rec!.stop(); // includes + awaits the final pending-chunk flush
      try {
        audioPath = await window.api.saveRecording(wav);
      } catch {
        audioPath = null; // disk hiccup — degraded path, keep the transcript/analysis
      }
    } catch (e) {
      // Keep going: finalize still runs, just without diarization.
      console.error('Kayıt kapatılırken hata:', errMsg(e));
    }

    await window.api.liveStop(audioPath);
    // state/status now driven by live:status (finalizing/analyzing) then live:result.
  }

  // Discard the meeting being finalized. Native confirm, not window.confirm — see
  // main/dialogs.ts for why Chromium's own dialogs are banned here.
  async function cancelRun(): Promise<void> {
    if (cancelling || (state !== 'finalizing' && state !== 'analyzing')) return;
    const confirmed = await window.api.confirmDelete(
      'Bu toplantı iptal edilecek. Döküm ve analiz kaydedilmeyecek, kayıt sesi silinecek. Devam edilsin mi?',
    );
    // The pipeline can finish while the dialog is open; cancelling a meeting that is
    // already saved would be a lie, so re-check the state rather than the click.
    if (!confirmed || (state !== 'finalizing' && state !== 'analyzing')) return;
    cancelling = true;
    refresh();
    try {
      await window.api.liveCancel();
    } catch (e) {
      // Rejects when the session finished in the same tick — the terminal event is
      // already on its way, so let it drive the screen.
      console.warn('Toplantı iptali uygulanamadı:', errMsg(e));
      cancelling = false;
      refresh();
    }
  }

  // Delegated so the options need no individual handles.
  languageGroup.addEventListener('click', (event) => {
    const option = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-language]');
    const next = option?.dataset.language;
    if (next === 'turkish' || next === 'foreign') selectLanguage(next);
  });

  scopeGroup.addEventListener('click', (event) => {
    const option = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-scope]');
    const next = option?.dataset.scope;
    if (next === 'group' || next === 'two-party') selectScope(next);
  });

  startBtn.addEventListener('click', () => void startRecording());
  stopBtn.addEventListener('click', () => void stopRecording());
  cancelBtn.addEventListener('click', () => void cancelRun());

  pauseBtn.addEventListener('click', async () => {
    if (!recorder) return;
    if (state === 'recording') {
      // Flush the pending boundary audio (awaited) BEFORE the session pauses, or the
      // session would drop it as a no-op push.
      await recorder.pause();
      await window.api.livePause();
    } else if (state === 'paused') {
      // Resume the session first, then open the capture gate, so no chunk arrives while
      // the session is still paused.
      await window.api.liveResume();
      recorder.resume();
    }
  });

  resultsBtn.addEventListener('click', () => deps.onViewResults(lastMeetingId));

  // --- Live session push events -------------------------------------------

  window.api.onLiveStatus((e) => {
    state = e.state;
    // A backlog notice (detail) is worth surfacing while recording/finalizing; otherwise
    // the canonical per-state text wins for focus-mode minimalism.
    refresh(e.detail && (state === 'recording' || state === 'finalizing') ? e.detail : undefined);
  });

  // Segments still stream from the engine during recording; the focus view stays minimal
  // and doesn't render them (the transcript is read afterwards in the Dashboard detail).
  window.api.onLiveResult((e) => {
    state = 'done';
    cancelling = false;
    lastMeetingId = e.meetingId;
    // A failed analysis is still a finished meeting: the transcript is on disk and
    // "Sonuçları Gör" opens it, so this says what is missing and where to fix it
    // rather than showing the plain "Tamamlandı".
    analysisFailed = Boolean(e.analysisError);
    refresh(analysisFailed
      ? 'Analiz tamamlanamadı — döküm kaydedildi. Panelden yeniden analiz edebilirsiniz.'
      : undefined);
  });

  window.api.onLiveError((e) => {
    state = 'error';
    cancelling = false;
    refresh(`Hata (${e.phase}): ${e.message}`);
  });

  // Back to the opening screen: a cancelled meeting leaves nothing to review, so there
  // is no terminal state to sit in and no "Sonuçları Gör" to offer.
  window.api.onLiveCancelled(() => {
    state = 'idle';
    cancelling = false;
    lastMeetingId = null;
    analysisFailed = false;
    refresh();
  });

  // Returning to the record view after a finished session must clear the leftover
  // 'done'/'error' state, or "Başlat" stays hidden and the screen is stuck on
  // "Sonuçları Gör" forever. Only the terminal states are reset — an in-progress
  // recording (recording/paused/finalizing/analyzing) must survive a flip to the
  // Dashboard and back.
  onViewChange((view) => {
    if (view !== 'record') return;
    if (state === 'done' || state === 'error') {
      state = 'idle';
      lastMeetingId = null;
      analysisFailed = false;
      // Back to Turkish for the next meeting — the choice is deliberately not remembered.
      selectLanguage('turkish');
      refresh();
    }
  });

  refresh();
}
