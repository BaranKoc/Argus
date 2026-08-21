import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const USER_VISIBLE_SOURCES = [
  'src/renderer/index.html',
  'src/renderer/features/dashboard/dashboard-view.ts',
  'src/renderer/features/settings/advanced/advanced-settings-view.ts',
  'src/renderer/features/settings/model/model-settings.ts',
  'src/renderer/features/settings/model/model-settings-view.ts',
  'engine/analyze/llm/catalog.ts',
  'src/main/settings.ts',
  'src/main/meeting-scope.ts',
  'src/main/model-config.ts',
  'src/main/dialogs.ts',
  'engine/test/manual-run.ts',
];
const MOJIBAKE = /[ÃÄÅÂâð]/;

const html = (): string => fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');

describe('user-visible Turkish text encoding', () => {
  it('does not contain common UTF-8 double-decoding signatures', () => {
    for (const relativePath of USER_VISIBLE_SOURCES) {
      const text = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
      assert.equal(MOJIBAKE.test(text), false, `${relativePath} contains a mojibake signature`);
    }
  });

  it('names every file it claims to guard', () => {
    for (const relativePath of USER_VISIBLE_SOURCES) {
      assert.ok(fs.existsSync(path.join(ROOT, relativePath)), `${relativePath} no longer exists`);
    }
  });
});

describe('application structure', () => {
  // A view whose root is missing from the markup
  // renders as a blank window with no error, which is the failure this catches.
  it('keeps every router root in the rendered HTML', () => {
    for (const id of ['recordView', 'userShellView']) {
      assert.match(html(), new RegExp(`id="${id}"`), id);
    }
  });

  it('opens as a single-user product without login or role panels', () => {
    const markup = html();
    assert.doesNotMatch(markup, /homeView|authView|adminView|loginUsername|futureUsername/);
    assert.match(markup, /id="recordView"/);
  });

  it('uses a text-only Argus identity', () => {
    const markup = html();
    assert.ok((markup.match(/ARGUS/g) ?? []).length >= 2);
    assert.doesNotMatch(markup, /<img|wordmark\.png/);
  });

  it('keeps speaker and analysis model settings on one tabbed page', () => {
    const markup = html();
    assert.match(markup, /id="settingsAdvancedPane"/);
    assert.match(markup, /id="settingsModelPane"/);
    assert.match(markup, /data-settings-page="advanced"/);
    assert.match(markup, /data-settings-page="model"/);
    assert.match(markup, /id="llmPresetGrid"/);
    assert.match(markup, /id="llmApiKey"/);
  });

  // The master switch is gone: .env no longer competes with the admin screen, so there is
  // nothing to switch between and a leftover toggle would be a lie.
  it('has no leftover "use this selection" switch', () => {
    assert.doesNotMatch(html(), /id="llmEnabled"/);
  });

});

describe('renderer-facing surface', () => {
  it('shows one logical meeting without original/edited provenance chrome', () => {
    const markup = html();
    assert.doesNotMatch(markup, /id="detailTypeBadge"/);
    assert.doesNotMatch(markup, /<th>Durum<\/th>/);
    assert.match(markup, /id="detailUndoEditBtn"/);
    assert.match(markup, /Yapılan Değişiklikleri Geri Al/);
    assert.match(markup, /id="detailActions"[\s\S]*id="detailReanalyzeBtn"[\s\S]*id="detailUndoEditBtn"/);
    assert.match(markup, /id="reanalyzeModal"/);
    assert.match(markup, /id="reanalyzeIncludeSpeakers"/);
    assert.match(markup, /id="analysisIncludeSpeakers"/);
  });

  it('does not expose Pyannote installation or a token field to end users', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'src/preload/index.ts'), 'utf8');
    const ipc = fs.readFileSync(path.join(ROOT, 'src/main/ipc.ts'), 'utf8');
    assert.doesNotMatch(html(), /pyannoteInstall|pyannoteToken/i);
    assert.doesNotMatch(preload, /installPyannote/);
    assert.doesNotMatch(ipc, /settings:installPyannote/);
  });

  // The API key is stored in main and shown as hasApiKey + a masked hint. A key field on
  // the view type crossing IPC would be a leak.
  it('keeps the analysis API key out of the renderer-facing surface', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'src/preload/index.ts'), 'utf8');
    const view = preload.slice(preload.indexOf('interface ModelConfigView'));
    assert.doesNotMatch(view.slice(0, view.indexOf('}')), /apiKey\s*:/);
  });
});
