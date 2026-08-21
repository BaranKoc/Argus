// HTML rendering for the PDF export, preview and print paths (export-render.ts). Mirrors
// the section structure of toMarkdown in export.ts, as a printable document styled to match
// the app: the same steel-blue brand ramp on the header, the same warm-neutral paper, and
// the same card treatment the analysis sections use on screen.

import type { MeetingDetail } from './meetings.ts';
// The leaf, not the engine index: this is pure text shaping over segments, and the index
// would drag the whole transcribe/analyze orchestration into the export path.
import { segmentsToTranscriptText } from '../../engine/transcribe/dialogue.ts';
import { renderAnalysisMarkdown } from '../../utility/render-markdown.ts';
import { splitTranscriptTurns } from '../../utility/transcript-turns.ts';

// Rendered from the segments at export time rather than taken from the meeting's stored
// `text`, which is only ever a rendering of those same segments — and a frozen one. A
// meeting recorded before the transcript gained the local/remote labels still carries the
// per-segment flags, so re-rendering is what lets it export the way the Döküm card on
// screen already shows it. Falls back to the stored text for a meeting whose segments
// were never persisted.
export function transcriptText(m: MeetingDetail): string {
  const fromSegments = m.segments?.length ? segmentsToTranscriptText(m.segments) : '';
  return fromSegments || m.text || '';
}

// dd.MM.yyyy HH:mm in the local timezone — the same human label the list shows. Lives here
// rather than in export.ts (which re-exports it) so this module stays a leaf: export.ts
// already imports renderHtml from here, and the other direction would be a cycle.
export function formatDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// serializeAnalysisMarkdown emits `### Title` + a bullet list per section, so marked gives
// back a flat run of <h3>/<ul> siblings. Splitting before each <h3> regroups them into one
// element per section, which is what lets each section become a card that can be kept off
// a page break as a unit.
function analysisSections(markdown: string): string {
  const html = renderAnalysisMarkdown(markdown);
  const chunks = html.split(/(?=<h3)/).filter((chunk) => chunk.trim().length > 0);
  if (chunks.length === 0) return '';
  return chunks.map((chunk) => `<section class="section">${chunk}</section>`).join('');
}

function brandMark(): string {
  return '<span class="logo-text">ARGUS</span>';
}

export function renderHtml(m: MeetingDetail): string {
  // Same turn-per-line shape as the on-screen Döküm card — without it the whole transcript
  // prints as one unreadable block of prose.
  const turns = splitTranscriptTurns(transcriptText(m));
  const transcript = turns.length > 0 ? turns.join('\n') : '(döküm yok)';
  const speakerNote = m.speakersDegraded
    ? `<p class="note">Konuşmacı etiketleri bu oturumda kullanılamadı.</p>`
    : '';
  const analysis = m.analysis ? analysisSections(m.analysis.markdown) : '';

  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<title>${escapeHtml(m.name)}</title>
<style>
  /* Palette mirrors src/renderer/styles/tokens.css so an exported page and the app read as one
     product. Warm-neutral paper, steel-blue accents, no pure #fff or #000. */
  :root {
    --brand-900: #1a2c3c;
    --brand-800: #243c51;
    --brand-600: #3d6485;
    --brand-500: #4d7ba1;
    --brand-300: #a9c1d6;
    --brand-100: #e7eef4;
    --surface-0: #fdfdfc;
    --surface-1: #f8f7f5;
    --surface-2: #f2f1ee;
    --ink: #2b2926;
    --ink-soft: #5f5c56;
    --ink-faint: #9b978f;
    --line: #e7e5e0;
  }

  @page { size: A4; margin: 0; }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    font-family: "Segoe UI", -apple-system, Arial, sans-serif;
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--ink);
    background: var(--surface-1);
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* Full-bleed header band. The wordmark is white-on-transparent, so it needs this dark
     plate to be visible at all — the same reason the sidebar and record panel are dark. */
  .masthead {
    padding: 26px 34px 22px;
    background:
      radial-gradient(120% 120% at 0% 0%, rgba(77, 123, 161, 0.35) 0%, transparent 62%),
      linear-gradient(160deg, var(--brand-800) 0%, var(--brand-900) 100%);
    color: #fff;
  }
  .brand { display: flex; align-items: flex-end; gap: 12px; }
  .logo { display: block; width: 128px; height: 40px; object-fit: contain; object-position: left bottom; }
  .logo-text { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; line-height: 1; }
  .brand-name {
    font-size: 8px;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    color: rgba(210, 223, 234, 0.72);
    padding-bottom: 4px;
  }
  .doc-title {
    margin: 18px 0 0;
    font-size: 19px;
    font-weight: 600;
    line-height: 1.3;
  }
  .doc-meta {
    margin: 6px 0 0;
    font-size: 10px;
    color: rgba(210, 223, 234, 0.75);
  }

  .content { padding: 26px 34px 34px; }

  h2.block {
    margin: 0 0 12px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--brand-600);
  }
  h2.block + * { margin-top: 0; }
  .block-group + .block-group { margin-top: 26px; }

  /* One card per analysis section, accented on the left like the detail header on screen.
     break-inside keeps a section from being split across pages when it can fit whole. */
  .section {
    break-inside: avoid;
    background: var(--surface-0);
    border: 1px solid var(--line);
    border-left: 3px solid var(--brand-500);
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 10px;
  }
  .section h3 {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--brand-900);
  }
  .section ul { margin: 0; padding-left: 16px; }
  .section li { margin-bottom: 3px; color: var(--ink); }
  .section li::marker { color: var(--brand-300); }
  .section p { margin: 0; }

  .transcript {
    white-space: pre-wrap;
    margin: 0;
    padding: 14px 16px;
    background: var(--surface-0);
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--ink);
  }

  .note {
    margin: 10px 0 0;
    padding: 8px 12px;
    background: var(--brand-100);
    border-radius: 6px;
    font-size: 10px;
    color: var(--brand-600);
  }

  .colophon {
    margin-top: 26px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
    font-size: 9px;
    color: var(--ink-faint);
    display: flex;
    justify-content: space-between;
  }
</style>
</head>
<body>
  <header class="masthead">
    <div class="brand">${brandMark()}<span class="brand-name">Kararları Görür</span></div>
    <h1 class="doc-title">${escapeHtml(m.name)}</h1>
    <p class="doc-meta">${escapeHtml(formatDate(m.createdAt))}</p>
  </header>

  <main class="content">
    ${
      analysis
        ? `<div class="block-group"><h2 class="block">Analiz</h2>${analysis}</div>`
        : ''
    }
    <div class="block-group">
      <h2 class="block">Döküm</h2>
      <p class="transcript">${escapeHtml(transcript)}</p>
      ${speakerNote}
    </div>
    <div class="colophon">
      <span>Argus · Kararları Görür</span>
      <span>${escapeHtml(formatDate(new Date().toISOString()))}</span>
    </div>
  </main>
</body>
</html>`;
}
