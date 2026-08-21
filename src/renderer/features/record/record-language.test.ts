// The language selector is markup + DOM wiring, and this suite runs on plain
// `node --test` with no DOM. So these are structural assertions over index.html and the
// view module — they cannot prove a click works, but they do catch the two failures that
// would otherwise reach a user silently: a default that is no longer Turkish, and
// data-language values that drift away from the engine's MeetingLanguage union (which
// main rejects at runtime, turning every recording into an error).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

describe('meeting language selector', () => {
  const markup = read('src', 'renderer', 'index.html');
  const view = read('src', 'renderer', 'features', 'record', 'record-view.ts');

  it('offers exactly the two languages the engine accepts', () => {
    const languages = [...markup.matchAll(/data-language="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(languages, ['turkish', 'foreign']);
  });

  it('starts on Turkish', () => {
    assert.match(markup, /class="record-choice-option selected" data-language="turkish"/);
    assert.doesNotMatch(markup, /class="[^"]*selected[^"]*" data-language="foreign"/);
  });

  // The model is locked for the whole meeting, so the control must vanish the moment
  // recording begins — using the same predicate as the start button rather than a
  // second, driftable one.
  // One predicate for the whole choices block — the language group is no longer alone in
  // there, and two separate show() calls would be free to drift apart.
  it('is only offered while a meeting can still be started', () => {
    assert.match(view, /show\(choices, state === 'idle' \|\| state === 'error'\)/);
  });

  it('resets to Turkish instead of remembering the last meeting', () => {
    assert.match(view, /selectLanguage\('turkish'\)/);
    assert.match(view, /let meetingLanguage: MeetingLanguage = 'turkish'/);
  });

  // The explanatory paragraph under the pills was removed on purpose: standing copy on the
  // record canvas read as clutter, and the tint below already says which mode is armed.
  it('carries no explanatory paragraph', () => {
    assert.doesNotMatch(markup, /recordLanguageHint/);
    assert.doesNotMatch(view, /languageHint/);
  });

  // The tint is how the user sees which mode they are about to record in without
  // reading a label. Scoped to the resting canvas: the live-state accents carry their
  // own meaning (recording / paused / done) and must not be overwritten.
  it('tints the resting canvas by language and leaves the live states alone', () => {
    const css = read('src', 'renderer', 'styles', 'record.css');
    // Only foreign is overridden; Turkish keeps the app's ordinary resting blue.
    assert.match(css, /\.record-view\.state-idle\.lang-foreign/);
    assert.doesNotMatch(css, /\.state-recording\.lang-/);
    assert.match(view, /lang-\$\{meetingLanguage\}/);
  });

  // The start button is the exception to the fixed semantic hues: it sits between the
  // tinted pills and the tinted canvas, so it follows the language accent — but only
  // while idle, so stop/done and the live states keep their own meaning.
  it('carries the language tint into the start button, idle only', () => {
    const css = read('src', 'renderer', 'styles', 'record.css');
    assert.match(css, /\.record-view\.state-idle\.lang-foreign \.rc-primary \{/);
    assert.doesNotMatch(css, /\.lang-foreign \.rc-(danger|success)/);
    const override = css.slice(css.indexOf('.record-view.state-idle.lang-foreign .rc-primary {'));
    assert.match(override.slice(0, override.indexOf('}')), /var\(--state-accent\)/);
  });

  // refresh() also rewrites the center text from the state, which would wipe the message
  // shown in 'error' — a state where the selector is still on screen.
  it('repaints without wiping the error message when the language changes', () => {
    const select = view.slice(view.indexOf('function selectLanguage'), view.indexOf('function selectScope'));
    assert.match(select, /applyStateClass\(\)/);
    assert.doesNotMatch(select, /refresh\(/);
  });

  // Status copy, not content. The selection is also what lets the brand lockup be
  // dragged around as a ghost image.
  it('keeps the record canvas chrome unselectable', () => {
    const css = read('src', 'renderer', 'styles', 'record.css');
    for (const block of ['.record-text', '.record-choices']) {
      const start = css.indexOf(`${block} {`);
      assert.notEqual(start, -1, block);
      assert.match(css.slice(start, css.indexOf('}', start)), /user-select: none/, block);
    }
  });
});
