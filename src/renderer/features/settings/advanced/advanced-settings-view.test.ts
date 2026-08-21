import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { SettingsResponse } from '../../../../preload/index.ts';
import { resolveAnalysisIncludeSpeakers, unavailableHint } from './advanced-settings-view.ts';

const status = { ready: true, message: 'ready' };

test('legacy settings default speaker-aware analysis on when diarization is enabled', () => {
  const response: SettingsResponse = {
    settings: {
      diarization: { enabled: true, provider: 'pyannote-community-1' },
    },
    status,
  };

  assert.equal(resolveAnalysisIncludeSpeakers(response), true);
});

test('speaker-aware analysis stays off when diarization is unavailable', () => {
  const response: SettingsResponse = {
    settings: {
      diarization: { enabled: true, provider: 'pyannote-community-1' },
      analysis: { includeSpeakers: true },
    },
    status: { ready: false, message: 'unavailable' },
  };

  assert.equal(resolveAnalysisIncludeSpeakers(response), false);
});

// A missing runtime is the expected first-run state, not a defect: it is too large to
// ship inside the installer. Telling that user their package is broken would send them to
// support for something working as designed.
test('a missing runtime explains the add-on rather than blaming the package', () => {
  const hint = unavailableHint({ ready: false, message: '', reason: 'no-runtime' });
  assert.match(hint, /NVIDIA/);
  assert.match(hint, /ayrı bir dosyadan/);
  assert.doesNotMatch(hint, /geliştirici/);
});

test('a genuinely incomplete package still points at the developer', () => {
  const hint = unavailableHint({ ready: false, message: '', reason: 'no-model' });
  assert.match(hint, /geliştirici/);
  assert.doesNotMatch(hint, /ayrı bir dosyadan/);
});

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const html = (): string => fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const viewSource = (): string => fs.readFileSync(
  path.join(ROOT, 'src', 'renderer', 'features', 'settings', 'advanced', 'advanced-settings-view.ts'),
  'utf8',
);
// Just the guide card, so a match elsewhere in a 900-line document cannot pass a test
// that is about this card.
function guide(): string {
  const markup = html();
  const start = markup.indexOf('id="diarizationGuide"');
  assert.notEqual(start, -1, 'diarizationGuide markup\'ta yok');
  return markup.slice(start, markup.indexOf('id="diarizationEnabled"', start));
}

// The install button is always on screen, even when the runtime is already there. Hiding
// it made the one action that fixes a disabled feature impossible to find, and main —
// which holds the authoritative status — says "already installed" rather than opening a
// file picker that could re-extract 4.6 GB over a working runtime.
test('the GPU add-on button is offered unconditionally', () => {
  // Matched on the opening tag's attributes rather than an exact string, so restyling or
  // moving the block does not fail a test that is about visibility.
  const openingTag = /<div id="gpuAddonBlock"([^>]*)>/.exec(html());
  assert.notEqual(openingTag, null, 'gpuAddonBlock markup\'ta yok');
  assert.doesNotMatch(openingTag![1], /\bhidden\b/);
  // The view does not touch the block at all any more — there is no state in which it
  // should disappear.
  assert.doesNotMatch(viewSource(), /gpuAddonBlock/);
});

// The card used to be an amber "things to watch out for" box, which read as a defect
// report on a feature that works. It is a guide now: prerequisites, then the buttons that
// satisfy them.
test('the prerequisites read as a guide, not as a warning', () => {
  const card = guide();
  assert.doesNotMatch(card, /bx-error/);
  assert.match(card, /bx-info-circle/);
  assert.match(card, /settings-guide-steps/);
  assert.doesNotMatch(html(), /settings-notice/);
});

// Both prerequisites are actionable from the card. A user who reads "NVIDIA sürücüsü
// gerekir" and has nowhere to go is exactly the dead end this replaced.
test('the guide offers both prerequisites as buttons', () => {
  const card = guide();
  assert.match(card, /id="openNvidiaDriver"/);
  assert.match(card, /id="installGpuAddon"/);
  // The steps come before the buttons: read what it needs, then act.
  assert.ok(card.indexOf('settings-guide-steps') < card.indexOf('id="gpuAddonBlock"'));
  assert.match(viewSource(), /openExternal\('nvidia-driver'\)/);
});

// The driver is the only thing the machine has to supply — the add-on carries its own
// CUDA runtime. Telling the user to install the toolkit would be a multi-GB detour that
// changes nothing.
test('the guide sends the user to the driver and rules out the toolkit', () => {
  const card = guide();
  assert.match(card, /sürücü/i);
  assert.match(card, /CUDA Toolkit kurmanıza gerek yoktur/);
});
