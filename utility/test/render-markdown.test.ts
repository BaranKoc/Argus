import assert from 'node:assert/strict';
import test from 'node:test';

import { renderAnalysisInlineMarkdown, renderAnalysisMarkdown } from '../render-markdown.ts';

test('renders canonical headings, lists and inline emphasis', () => {
  const html = renderAnalysisMarkdown('### Ana İstek\n\n- **Kritik** toplantı');
  assert.match(html, /<h3>Ana İstek<\/h3>/);
  assert.match(html, /<li><strong>Kritik<\/strong> toplantı<\/li>/);
});

test('neutralizes raw HTML before marked parses it', () => {
  const html = renderAnalysisMarkdown('- <script>alert(1)</script>');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('renders inline markdown without wrapping it in a paragraph', () => {
  assert.equal(renderAnalysisInlineMarkdown('**Karar:** Kabul edildi.'), '<strong>Karar:</strong> Kabul edildi.');
});
