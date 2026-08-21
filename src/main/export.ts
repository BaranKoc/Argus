// Meeting export ("Dışa Aktar"). Reads a saved meeting and writes its transcript +
// analysis to a file the user picks via the native save dialog. Markdown stays
// dependency-free (plain text). PDF is rendered via Electron's own printToPDF
// (export-render.ts) rather than a PDF library, so the offline-first, dependency-free
// guarantee holds for it too.

import { BrowserWindow, dialog, shell, ShareMenu } from 'electron';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readMeeting, type MeetingDetail } from './meetings.ts';
import { renderHtml } from './export-html.ts';
import { printHtml, renderToPdfBuffer } from './export-render.ts';
import type { PrintOutcome } from './print-result.ts';

export type ExportFormat = 'md' | 'pdf';

// Defined in export-html.ts (the leaf) and re-exported here so this stays the module
// callers reach for export concerns.
export { formatDate } from './export-html.ts';
import { transcriptText } from './export-html.ts';

export function toMarkdown(m: MeetingDetail): string {
  let md = `# ${m.name}\n\n`;

  if (m.analysis) {
    md += `## Analiz\n\n${m.analysis.markdown}\n\n`;
  }

  md += `## Döküm\n\n${transcriptText(m) || '(döküm yok)'}\n`;
  if (m.speakersDegraded) {
    md += `\n> Not: Konuşmacı etiketleri bu oturumda kullanılamadı.\n`;
  }
  return md;
}

export interface ExportResult {
  saved: boolean; // false when the user cancelled the dialog
  path?: string;
}

export function extensionFor(format: ExportFormat): string {
  return format;
}

// meeting.name is free text (user-renameable via "Yeniden İsimlendir"), so it can contain
// characters that are illegal in Windows filenames, or trailing dots/spaces Windows strips
// silently. Sanitize it for use as a save-dialog default filename.
function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned.slice(0, 150) || 'toplanti';
}

function filterFor(format: ExportFormat): Electron.FileFilter[] {
  switch (format) {
    case 'md':
      return [{ name: 'Markdown', extensions: ['md'] }];
    case 'pdf':
      return [{ name: 'PDF', extensions: ['pdf'] }];
  }
}

// Produces the file content for a given format. Exported so a future (SMTP-based) email
// export can reuse it without going through the save dialog.
export async function buildExportContent(
  m: MeetingDetail,
  format: ExportFormat,
): Promise<string | Buffer> {
  if (format === 'md') return toMarkdown(m);
  return renderToPdfBuffer(renderHtml(m));
}

// Prompt for a destination and write the meeting in the requested format. Returns
// { saved: false } on cancel so the renderer can stay quiet rather than reporting a
// phantom success.
export async function exportMeeting(
  win: BrowserWindow,
  id: string,
  format: ExportFormat = 'md',
): Promise<ExportResult> {
  const meeting = await readMeeting(id);
  const defaultName = `${sanitizeFileName(meeting.name)}.${extensionFor(format)}`;

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Toplantıyı Dışa Aktar',
    defaultPath: defaultName,
    filters: filterFor(format),
  });
  if (canceled || !filePath) return { saved: false };

  const content = await buildExportContent(meeting, format);
  if (typeof content === 'string') await fs.writeFile(filePath, content, 'utf8');
  else await fs.writeFile(filePath, content);
  return { saved: true, path: filePath };
}

// The PDF bytes for the in-app preview. No dialog and nothing written to disk — the
// renderer turns these into a blob: URL for its viewer.
export async function renderMeetingPdf(id: string): Promise<Uint8Array> {
  const meeting = await readMeeting(id);
  return new Uint8Array(await renderToPdfBuffer(renderHtml(meeting)));
}

export async function printMeeting(id: string): Promise<PrintOutcome> {
  const meeting = await readMeeting(id);
  return printHtml(renderHtml(meeting));
}

// --- "Paylaş" ---------------------------------------------------------------
// One entry point, three platform paths. The PDF is rendered once, up front, because every
// path needs it as a real file on disk; only the handoff differs.
//
// The result means "the share UI opened", never "the document was sent": neither Windows'
// DataTransferManager nor macOS' ShareMenu reports delivery back to us. A dismissed sheet
// is 'cancelled' — a completed interaction, not a failure — and only a genuine failure to
// open throws.

// One stable folder rather than a fresh mkdtemp per click: the share UI reads the file
// after this call returns, and a new random directory per share would litter the temp dir
// with near-identical PDFs of the same meeting.
function shareDir(): string {
  return path.join(os.tmpdir(), 'argus-paylasim');
}

export type ShareOutcome = { method: 'native' | 'cancelled' | 'revealed' };

// The vendored addon's surface, declared here rather than imported, so this file type-checks
// on machines where the package isn't installed at all — it is a Windows-only optional
// dependency (see vendor/electron-native-share/NOTES.md).
interface NativeShare {
  canShare(): boolean;
  share(
    options: { title?: string; text?: string; url?: string; files?: string[] },
    browserWindow?: BrowserWindow,
  ): Promise<{ method: 'native' | 'cancelled' }>;
}

// Windows: the WinRT DataTransferManager, the API Microsoft points desktop apps at. Loaded
// here rather than at module scope precisely because it does not exist on the other two
// platforms. The sheet only appears when the window passed in is the foreground one —
// true for a button click, and why the handle travels down from the caller.
async function shareOnWindows(
  win: BrowserWindow,
  filePath: string,
  title: string,
): Promise<ShareOutcome> {
  const native = createRequire(import.meta.url)('electron-native-share') as NativeShare;
  if (!native.canShare()) {
    throw new Error('Windows paylaşım penceresi bu sistemde kullanılamıyor.');
  }
  return native.share({ title, files: [filePath] }, win);
}

// macOS: Electron's own ShareMenu wraps NSSharingServicePicker, so no second native addon
// has to be built or shipped there. popup() returns as soon as the picker is up.
function shareOnMac(win: BrowserWindow, filePath: string): ShareOutcome {
  new ShareMenu({ filePaths: [filePath] }).popup({ window: win });
  return { method: 'native' };
}

export async function sharePdf(win: BrowserWindow, id: string): Promise<ShareOutcome> {
  const meeting = await readMeeting(id);
  const bytes = await renderToPdfBuffer(renderHtml(meeting));
  const dir = shareDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${sanitizeFileName(meeting.name)}.pdf`);
  await fs.writeFile(filePath, bytes);

  switch (process.platform) {
    case 'win32':
      return shareOnWindows(win, filePath, meeting.name);
    case 'darwin':
      return shareOnMac(win, filePath);
    default:
      // Linux has no system share sheet to call. Handing over the finished file is the
      // honest fallback; the renderer says where it went.
      shell.showItemInFolder(filePath);
      return { method: 'revealed' };
  }
}
