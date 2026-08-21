# AGENTS.md

Project instructions for Codex. Follow these exactly.

## After adding an engine feature — manual verification

When you add or change a feature in the engine (`engine/`, e.g. `transcribe/transcriber.ts`,
`analyze/analyzer.ts`, `transcribe/align.ts`, `transcribe/dedup.ts`, `index.ts`), you MUST
eyeball the real output against the control group before considering the work done.
The engine is organized into concern folders — `transcribe/`, `diarize/`, `analyze/`,
`live/`, `download/`, `bench/`, `test/` — with `index.ts`, `models.ts`, `diarization-config.ts`
at the `engine/` root; see `docs/architecture.md`. Steps:

**1. ASK THE USER WHICH SCENARIO(S) TO TEST — always, before running anything.**
Use `AskUserQuestion` while still planning. **Never pick the file yourself** and never assume
"the last one" or "the obvious one": a run costs real minutes of CPU, and the scenario decides
what the result even means. Offer the scenarios your change plausibly affects, with a one-line reason each. At least one
scenario is required; the user may pick more than one (e.g. to check both `C` and `F` variants,
or several scenarios the change could touch) — run each one they pick, not just the first.

**2. Run the manual test for each scenario the user picked.**
```
printf '<file>.mp3\n<işlem>\n<nasıl>\n<diarization>\n' | npm run test-run -w engine
```
The tool is **interactive** and asks up to five questions in sequence: filename, then işlem
(`1` transcribe · `2` analyze · `3` both), then — skipped entirely for analyze, since it never
touches audio — nasıl (`1` static · `2` live), then — same skip — Pyannote diarization on/off
(`e`/`h`), and finally — for analyze only — the source transcript (blank = that scenario's
control-group reference). Pipe every answer that will actually be asked. Run from the repo
root; `test_media/`, `output/` and `temp/` all live there.

- Transcriber-side change → transcribe + static (or both + static if you also want the
  analysis): `printf '<file>.mp3\n1\n1\nh\n'` / `printf '<file>.mp3\n3\n1\nh\n'`.
- Analyzer-side change → analyze: `printf '<file>.mp3\n2\n\n'`. The trailing blank line takes
  that scenario's control-group transcript as the source, so you **don't re-transcribe** to
  test the analyzer. A scenario with no audio (S9, S10) never gets asked işlem at all —
  `printf 'S9\n\n'`. Analyze-only runs compute no metrics, so they write **no `summary.md`**;
  compare the analysis text itself.
- Change spanning both layers → both + static: `printf '<file>.mp3\n3\n1\nh\n'`.
- Diarizer-side change → transcribe + live + diarization **on**: `printf '<file>.mp3\n1\n2\ne\n'`
  — the direct speaker test, no LLM cost. A broader live-pipeline change → both + live:
  `printf '<file>.mp3\n3\n2\nh\n'`.
- Multiple scenarios picked → repeat the command once per scenario (each run gets its own
  timestamped output folder, so nothing collides).

Output lands **flat** in `output/test_run/<timestamp>/` as `<base>_transcribe.json` and
`<base>_analyze.json` (`live-` infixed for live runs — `<base>_live-transcribe.json`), plus a
`summary.md`. Every run gets its own dated folder and **nothing is ever overwritten**.

**3. Compare against the control group.** The tool already did the arithmetic: `summary.md`
carries `wer` (divergence from the reference), `domainRecall`, duplicate/overlap flags and the
hallucination count. Which file it compared against is **not** in `summary.md` — it is the
output JSON's `metrics.referencePath` (repo-relative, forward slashes). A
`wer` of `n/a` means that scenario has **no reference yet** — your run is the first, which is
fine; say so and skip the comparison. Read the actual text too: the numbers are a signal, not
the verdict. Decide: did the feature improve the output, leave it unchanged, or regress it?

Exception: **transcribe + live + diarization on** has no `wer`/control-group comparison by
design (every reference was produced with diarization off, so there is nothing to diff against).
Judge it from `summary.md`'s speaker table and the `<scenario>_live-dialogue.txt` dump instead —
speaker count vs. the scenario's expected count, and whether attribution reads coherent on a
human pass through the dialogue.

**4. If the new result is worse,** append a dated note to `docs/engine-regressions.md`:
the feature/branch, the scenario tested, and the concrete regression (what got worse, with
before/after snippets). This is the only doc this workflow writes to.

**5. No cleanup step. Never delete anything under `output/`.** Runs are meant to accumulate —
that's the history. If your result deserves to become the new reference, that is a separate and
**explicit** act: promote it with `npm run promote -w engine -- <output/…/{transcribe,analyze}/…json>`,
which copies the file into the local `control-group/` folder and rewrites that scenario's row
in `control-group/control-group.md`. Ask the user first; promoting a reference is their call, not
yours. The one sanctioned exception to "never delete" is the `prune-test-run` tool below, and even
that requires the user's explicit go-ahead.

## Control group = the local reference registry

We have no `test_media/<name>.gt.txt`. Instead **`control-group/control-group.md` names, per
scenario, which output on disk is the reference** — a hand-edited table, one row per scenario,
pointing at a file under the `control-group/` folder (`transcribe/…json` or `analyze/…json`,
`control-group/`-relative with forward slashes). `npm run bench` and `npm run test-run` both read
it via `engine/bench/control-group.ts`.

**Privacy boundary:** `output/` is git-ignored (throwaway `test_run/`/`bench/` runs), and
`control-group/**/*.json` is also git-ignored because real meeting transcripts can contain
personal or company information. The Markdown registry may be published only after its paths and
scenario descriptions have been reviewed; private reference JSONs stay local. A run becomes a
local reference only via an explicit
`npm run promote` (step 5 above), which copies the chosen `output/` run into `control-group/` and
rewrites the row — never a directory scan or a "newest file" guess (that guess broke silently once
filenames gained a `<configId>__` prefix and quietly reported `wer: null`). A scenario with no row
simply reports `n/a`; that is not an error.

Because the reference is the default model's own output, `wer` is **divergence from that
reference**, not absolute accuracy — so **domain-term recall** (a fixed per-scenario checklist)
plus a human eyeball of the diffs are the real accuracy arbiters. Each transcribe output records
the `config` block (model + settings) that produced it and each analyze output records its
`analyzer` block (provider + model + host), so you always know what a reference was run with.

## Pruning orphaned `output/test_run/` folders

`output/test_run/` accumulates a folder per manual run forever (step 5 above), and most of
them never become a reference. `engine/bench/prune-test-run.ts` cleans up the ones the registry
does not point at. Since references are now **copied** into `control-group/` on promote, a
promoted run's `output/test_run/` copy is redundant — so in normal operation **every**
`test_run/` folder is a candidate. (The file-by-file check still stands for a stray hand-edited
row that points back into `test_run/`.) Folders modified in the last 10 minutes are skipped,
since a fresh run is legitimately unreferenced, not orphaned. `control-group/` is never in scope.

Two modes:
```
npm run prune-test-run -w engine                # list candidates only, read-only
npm run prune-test-run -w engine -- --delete     # list, then prompt y/N, then delete on 'y'
```

**Rule for Codex:** the listing mode is read-only and safe to run anytime, including
just to check how much is prunable. The `--delete` mode is destructive and hard to reverse —
run listing mode first, show the user the exact candidate list, and get their explicit
approval for *that* list before running `--delete` and answering its own `y` prompt. Never
chain listing and deletion in one unattended step, and never run `--delete` because a task
seems to imply cleanup would be nice.

## Two test systems, one format

- **`npm run bench -w engine`** — the whole matrix (4 configs × every scenario) in one long,
  non-interactive run. Slow; this is the full picture. → `output/bench/<timestamp>/`
- **`npm run test-run -w engine`** — one scenario, interactive. This is what you run while
  iterating on a feature (step 2 above). → `output/test_run/<timestamp>/`

They write **the same JSON schema and the same metrics** (`engine/bench/metrics.ts`), which is
what lets a promoted run from either land in `control-group/` as a reference.

## Git history privacy gate

After any task that changes tracked files, run both `npm run privacy-check` and
`npm run privacy-check:history` before the final response. The history check scans every local
Git object, including old commits and dangling blobs; a clean working tree is not sufficient.
Never copy a matched name, email, credential, private link, or transcript into chat or a tracked
report—report only the object ID, path, and finding type. History rewrite is destructive and may
run only when the user explicitly requests it, through the backup-first
`npm run privacy-rewrite -- --execute` workflow. Never force-push as an implied part of rewrite;
publishing rewritten refs is a separate explicit action.

## Comment discipline — keep WHY, drop WHAT

This codebase comments the **why**, not the **what**. Follow the same rule when writing or
editing code here:

- **Remove** comments that only restate what the code plainly does — line-by-line narration,
  and redundant "here we do X" section banners that add nothing over the code beneath them.
- **Keep** comments that capture a decision or constraint you cannot recover by reading the
  code: *why* the diarizer runs in a separate process (ORT/native-addon DLL conflict), *why*
  `flagDuplicates` flags instead of deleting, *why* `models.ts`/`diarization-config.ts` stay at
  the `engine/` root (import graph + depth-locked path math), *why* a threshold or ordering is
  what it is. When in doubt, keep it — a lost WHY is expensive; a redundant WHAT is cheap.
- Apply this **opportunistically** in files you're already editing. Do **not** do a repo-wide
  comment sweep — the risk of deleting a load-bearing WHY outweighs the tidiness gain.
