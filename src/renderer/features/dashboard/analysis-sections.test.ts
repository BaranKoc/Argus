import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_SECTION_TEXT,
  emptyAnalysisDraft,
  parseAnalysisMarkdown,
  serializeAnalysisMarkdown,
} from '../../../../engine/analyze/sections.ts';
import {
  analysisSectionThemeClass,
  analysisSectionViews,
  replaceAnalysisSection,
} from './analysis-sections.ts';

test('analysis cards always expose the nine fixed sections and empty state', () => {
  const views = analysisSectionViews();

  assert.equal(views.length, 9);
  assert.ok(views.every((section) => section.empty && section.count === 0));
  assert.match(serializeAnalysisMarkdown(emptyAnalysisDraft()), new RegExp(`- ${EMPTY_SECTION_TEXT}`));
});

test('editing rebuilds canonical markdown and replaces only the selected section', () => {
  const initial = emptyAnalysisDraft();
  initial.mainRequest = ['İlk amaç'];
  initial.detectedValues = ['180 bin euro'];

  const result = replaceAnalysisSection(initial, 'actionItems', [
    '  Hukuk ekibine gönderilecek.  ',
    '',
  ]);
  const parsed = parseAnalysisMarkdown(result.markdown);

  assert.deepEqual(parsed.mainRequest, ['İlk amaç']);
  assert.deepEqual(parsed.actionItems, ['Hukuk ekibine gönderilecek.']);
  assert.deepEqual(parsed.detectedValues, ['180 bin euro']);
});

test('all nine analysis sections have distinct color themes', () => {
  const classes = analysisSectionViews().map((section) => analysisSectionThemeClass(section.key));
  assert.equal(new Set(classes).size, 9);
  assert.ok(classes.every((className) => className.startsWith('theme-')));
});
