import { marked } from 'marked';

function escapeRawHtml(markdown: string): string {
  return markdown.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderAnalysisMarkdown(markdown: string): string {
  return marked.parse(escapeRawHtml(markdown), { breaks: true }) as string;
}

export function renderAnalysisInlineMarkdown(markdown: string): string {
  return marked.parseInline(escapeRawHtml(markdown)) as string;
}
