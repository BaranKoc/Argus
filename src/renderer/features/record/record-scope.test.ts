// Structural assertions over the meeting-type selector, for the same reason its language
// twin has them: this suite runs on plain `node --test` with no DOM, so it cannot prove a
// click works — but it does catch the failures that would reach a user silently. A
// data-scope value that drifts from the engine's MeetingScope union makes main throw on
// every recording, and a default that is no longer 'group' would quietly suppress speaker
// separation in meetings that needed it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

describe('meeting scope selector', () => {
  const markup = read('src', 'renderer', 'index.html');
  const view = read('src', 'renderer', 'features', 'record', 'record-view.ts');

  it('offers exactly the two scopes the engine accepts', () => {
    const scopes = [...markup.matchAll(/data-scope="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(scopes, ['group', 'two-party']);
    assert.match(read('engine', 'models.ts'), /MeetingScope = 'group' \| 'two-party'/);
  });

  it('starts on the group meeting, so nothing is suppressed by default', () => {
    assert.match(markup, /class="record-choice-option selected" data-scope="group"/);
    assert.doesNotMatch(markup, /class="[^"]*selected[^"]*" data-scope="two-party"/);
    assert.match(view, /let meetingScope: MeetingScope = 'group'/);
  });

  it('is named the way the user was told it would be', () => {
    assert.match(markup, /data-scope="two-party"[\s\S]{0,80}Online İkili Görüşme/);
  });

  // Same call as its language twin: no standing paragraph under the pills. What picking it
  // does is documented in Ayarlar and docs/kurulum.md, not on the record canvas.
  it('carries no explanatory paragraph', () => {
    assert.doesNotMatch(markup, /recordScopeHint/);
    assert.doesNotMatch(view, /scopeHint/);
  });

  it('travels to main on the start call', () => {
    assert.match(view, /liveStart\(\{ meetingLanguage, meetingScope \}\)/);
  });
});
