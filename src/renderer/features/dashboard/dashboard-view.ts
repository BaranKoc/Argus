// The Dashboard: a Sneat-styled list of saved meetings plus a split detail view
// (transcript | AI analysis cards).

import {
  EMPTY_SECTION_TEXT,
  emptyAnalysisDraft,
  parseAnalysisMarkdown,
  serializeAnalysisMarkdown,
  type AnalysisDraft,
  type AnalysisSectionKey,
} from '../../../../engine/analyze/sections.ts';
import type { Analysis, Segment } from '../../../../engine/index.ts';
import { renderAnalysisInlineMarkdown, renderAnalysisMarkdown } from '../../../../utility/render-markdown.ts';
import {
  analysisItemsBySpeaker,
  buildSpeakerNameMap,
  speakerLabels,
  speakerNameError,
  speakerSource,
  speakerTranscriptLines,
} from '../../../../utility/speaker-names.ts';
import { splitTranscriptTurns } from '../../../../utility/transcript-turns.ts';
import { ipcErrorMessage } from '../../shared/ipc-error.ts';
import type { MeetingSummary, MeetingDetail } from '../../../main/meetings.ts';
import type { ExportFormat } from '../../../main/export.ts';
import {
  meetingButtonAction,
  meetingRowIntent,
  orderMeetings,
  RenameInteractionState,
  SingleFlightInteractionState,
  type MeetingRowTarget,
} from './dashboard-interactions.ts';
import {
  analysisSectionThemeClass,
  analysisSectionViews,
  replaceAnalysisSection,
} from './analysis-sections.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface DashboardDeps {
  onNewRecording: () => void;
}

function fallbackMeetingName(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// A 1x1 transparent GIF used as the drag image so the browser's washed-out row "ghost"
// never appears — the styled row itself is the only drag visual (see rowNode dragstart).
const TRANSPARENT_DRAG_IMG = new Image();
TRANSPARENT_DRAG_IMG.src =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// The user's manual drag order, persisted as a list of meeting ids so it survives restarts.
// Kept in localStorage (renderer-only) since order is app state, not part of a meeting's record.
const ORDER_STORAGE_KEY = 'meetingOrder';

function loadOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function saveOrder(ids: string[]): void {
  try {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // A full/blocked localStorage just means the order won't persist — not worth surfacing.
  }
}

function meetingRowTarget(target: HTMLElement): MeetingRowTarget {
  if (target.closest('input')) return 'input';
  if (target.closest('.meeting-name')) return 'name';
  if (target.closest('button')) return 'button';
  // The export dropdown's items are <a> tags, not buttons, but must be ignored the same
  // way — a click here fires the tr's own listener before it ever bubbles to tableBody's
  // delegated dropdown handler (tr sits between the target and tableBody), so that
  // handler's stopPropagation() runs too late to stop the row from opening.
  if (target.closest('.dropdown-menu')) return 'button';
  return 'row';
}

// --- Shared render helpers -------------------------------------------------

// Turkish for the capture side a voice came from. 'mixed' is deliberately not "belirsiz":
// it means both sides were audible at once, which is a fact about the meeting, not a
// failure to decide.
const SOURCE_TEXT: Record<NonNullable<Segment['source']>, string> = {
  local: 'Yerel',
  remote: 'Uzak',
  mixed: 'Karışık',
};

function sourceBadge(source: NonNullable<Segment['source']>): HTMLElement {
  const badge = document.createElement('span');
  badge.className = `source-badge source-${source}`;
  badge.textContent = SOURCE_TEXT[source];
  badge.title =
    source === 'local'
      ? 'Mikrofondan, yani bu bilgisayarın bulunduğu odadan'
      : source === 'remote'
        ? 'Sistem sesinden, yani çevrimiçi toplantıdaki karşı taraftan'
        : 'Oda ve toplantı sesi aynı anda duyuldu';
  return badge;
}

function segmentNode(seg: Segment): HTMLElement {
  const el = document.createElement('div');
  el.className = 'segment';
  if (seg.duplicate) el.classList.add('duplicate');
  if (seg.overlap) el.classList.add('overlap');
  if (seg.speaker) {
    const sp = document.createElement('span');
    sp.className = 'speaker';
    sp.textContent = seg.speaker;
    el.appendChild(sp);
  }
  if (seg.source) el.appendChild(sourceBadge(seg.source));
  const txt = document.createElement('span');
  txt.className = 'text';
  // A segment can hold several speaker turns; each gets its own line. They stay inside the
  // one segment node, so the speaker label and the duplicate/overlap styling still apply
  // to the whole of it. The newlines are honoured by .segment .text's white-space.
  txt.textContent = splitTranscriptTurns(seg.text).join('\n');
  el.appendChild(txt);
  return el;
}

// --- Shared edit modal -------------------------------------------------------
type EditModalOptions = {
  title: string;
  items: string[];
  onSave: (items: string[]) => void;
};

const editModalBackdrop = $<HTMLDivElement>('editModal');
const editModalTitleEl = $<HTMLHeadingElement>('editModalTitle');
const editModalBodyEl = $<HTMLDivElement>('editModalBody');
const editModalCountEl = $<HTMLSpanElement>('editModalCount');
const editModalSaveBtn = $<HTMLButtonElement>('editModalSave');
const editModalCancelBtn = $<HTMLButtonElement>('editModalCancel');
const editModalCloseBtn = $<HTMLButtonElement>('editModalClose');

// Set by openEditModal for the currently-open editor; cleared on close. The Kaydet button
// is wired once (below) and just calls whatever is currently pending.
let pendingSave: (() => void) | null = null;

// Exit animations need the element to stay in the DOM until they finish, so closing is:
// mark .is-closing → wait for the backdrop's animation → only then set [hidden] and tear
// the body down. The timer is a fallback for the reduced-motion path and for any case
// where animationend never fires (element removed, animation suppressed) — without it
// the modal would be stranded visible.
function closeModalAnimated(backdrop: HTMLElement, teardown: () => void): void {
  if (backdrop.hidden || backdrop.classList.contains('is-closing')) return;
  backdrop.classList.add('is-closing');

  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    backdrop.removeEventListener('animationend', onEnd);
    backdrop.classList.remove('is-closing');
    backdrop.hidden = true;
    teardown();
  };
  const onEnd = (ev: AnimationEvent): void => {
    if (ev.target === backdrop) finish();
  };

  const timer = setTimeout(finish, 300);
  backdrop.addEventListener('animationend', onEnd);
}

function closeEditModal(): void {
  closeModalAnimated(editModalBackdrop, () => {
    editModalBodyEl.replaceChildren();
    pendingSave = null;
  });
}

// Textareas don't size to their content, so height is recomputed from scrollHeight on
// every input — this is what makes a long row fully readable instead of clipped.
function autoGrow(field: HTMLTextAreaElement): void {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
}

// The row currently being dragged inside the edit modal, or null. Module-scoped for the
// same reason draggingRow is in the list: the dragover handler lives on the container,
// not on the row that started the drag.
let draggingEditRow: HTMLElement | null = null;

function addEditRow(rows: HTMLDivElement, value: string, focus = false): void {
  const row = document.createElement('div');
  row.className = 'edit-row';

  // Drag-to-reorder handle, same contract as the meeting list's: the row only becomes
  // draggable while the pointer is on the handle, so the textarea keeps normal text
  // selection and caret dragging everywhere else.
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'edit-row-handle';
  handle.setAttribute('aria-label', 'Sürükleyerek sırala');
  handle.innerHTML = "<i class='bx bx-grid-vertical'></i>";
  handle.addEventListener('mousedown', () => {
    row.draggable = true;
  });
  const releaseDrag = (): void => {
    row.draggable = false;
  };
  handle.addEventListener('mouseup', releaseDrag);

  const index = document.createElement('span');
  index.className = 'edit-row-index';

  const field = document.createElement('textarea');
  field.className = 'edit-row-field';
  field.rows = 1;
  field.value = value;
  field.addEventListener('input', () => autoGrow(field));

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'icon-btn edit-row-delete';
  del.title = 'Satırı sil';
  del.innerHTML = '<i class="bx bx-trash"></i>';
  del.addEventListener('click', () => {
    row.remove();
    renumberRows(rows);
  });

  row.addEventListener('dragstart', (event) => {
    draggingEditRow = row;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', '');
      event.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMG, 0, 0); // no washed-out ghost
    }
    rows.classList.add('reordering');
    // Deferred one frame: applying the lifted style synchronously would let some engines
    // snapshot the *styled* row for the (now hidden) drag image.
    requestAnimationFrame(() => row.classList.add('dragging'));
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    rows.classList.remove('reordering');
    releaseDrag();
    draggingEditRow = null;
    for (const r of Array.from(rows.children) as HTMLElement[]) {
      r.style.transition = '';
      r.style.transform = '';
    }
    renumberRows(rows);
  });

  const actions = document.createElement('div');
  actions.className = 'edit-row-actions';
  actions.append(del);

  row.append(handle, index, field, actions);
  rows.append(row);
  renumberRows(rows);

  // Only after insertion does the textarea have a layout box to measure.
  autoGrow(field);
  if (focus) field.focus();
}

// FLIP: record each row's position, run the DOM move, then animate the displaced rows from
// their old spot to the new one so they slide instead of teleporting. Same technique the
// meeting list uses for its drag reorder.
function reorderEditRowsWithFlip(rows: HTMLDivElement, place: () => void): void {
  const all = Array.from(rows.children) as HTMLElement[];
  const firstTop = new Map(all.map((r) => [r, r.getBoundingClientRect().top]));
  place();
  for (const r of all) {
    if (r === draggingEditRow) continue; // the grabbed row jumps to the cursor slot
    const delta = (firstTop.get(r) ?? 0) - r.getBoundingClientRect().top;
    if (!delta) continue;
    r.style.transition = 'none';
    r.style.transform = `translateY(${delta}px)`;
    requestAnimationFrame(() => {
      r.style.transition = 'transform 150ms ease';
      r.style.transform = '';
    });
  }
}

// Live reorder while dragging: drop the held row above whichever row the cursor is over the
// top half of (or at the end when past the last one). Only reorder when the target slot
// actually changes, so FLIP doesn't restart on every dragover tick.
function wireEditRowDragging(rows: HTMLDivElement): void {
  rows.addEventListener('dragover', (ev) => {
    const dragged = draggingEditRow;
    if (!dragged || dragged.parentElement !== rows) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    const others = (Array.from(rows.children) as HTMLElement[]).filter((r) => r !== dragged);
    const before =
      others.find((r) => {
        const box = r.getBoundingClientRect();
        return ev.clientY < box.top + box.height / 2;
      }) ?? null;
    if (before === dragged.nextElementSibling) return; // already in this slot — no-op
    reorderEditRowsWithFlip(rows, () => rows.insertBefore(dragged, before));
  });
  rows.addEventListener('drop', (ev) => ev.preventDefault());
}

// Row numbers are positional, so they're recomputed after every insert/remove/reorder
// rather than tracked incrementally.
function renumberRows(rows: HTMLDivElement): void {
  (Array.from(rows.children) as HTMLElement[]).forEach((row, i) => {
    const index = row.querySelector<HTMLElement>('.edit-row-index');
    if (index) index.textContent = String(i + 1);
  });
  rows.dispatchEvent(new CustomEvent('rowschange', { bubbles: true }));
}

function buildRowEditor(initialRows: string[]): { body: HTMLElement; rows: HTMLDivElement } {
  const rows = document.createElement('div');
  rows.className = 'edit-rows';
  wireEditRowDragging(rows);
  initialRows.forEach((value) => addEditRow(rows, value));
  renumberRows(rows);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-sm btn-outline-primary edit-add-row';
  addBtn.innerHTML = '<i class="bx bx-plus"></i> Satır Ekle';
  addBtn.addEventListener('click', () => addEditRow(rows, '', true));

  const body = document.createElement('div');
  body.append(rows, addBtn);
  return { body, rows };
}

function openEditModal(opts: EditModalOptions): void {
  editModalTitleEl.textContent = opts.title;
  editModalBodyEl.replaceChildren();

  const { body, rows } = buildRowEditor(opts.items);
  editModalBodyEl.append(body);

  const showCount = (): void => {
    editModalCountEl.textContent = `${rows.children.length} satır`;
  };
  rows.addEventListener('rowschange', showCount);
  showCount();

  pendingSave = () => {
    const items = Array.from(rows.querySelectorAll<HTMLTextAreaElement>('.edit-row-field'))
      .map((field) => field.value.trim())
      .filter(Boolean);
    opts.onSave(items);
  };

  editModalBackdrop.classList.remove('is-closing');
  editModalBackdrop.hidden = false;

  // Heights measured while the modal was [hidden] all come back 0, so every row is
  // re-measured once it is actually laid out.
  rows.querySelectorAll<HTMLTextAreaElement>('.edit-row-field').forEach(autoGrow);

  // Deliberately NOT focusing the first row: the modal opens for reading as often as for
  // editing, and an auto-focused field puts a caret in existing content before the user
  // has decided to change anything. Clicking a row starts editing; a row added with
  // "Satır Ekle" still takes focus, since creating it *is* the intent to type.
}

// Wired once: the modal is a singleton, reopened with different content per card.
editModalSaveBtn.addEventListener('click', () => {
  pendingSave?.();
  closeEditModal();
});
editModalCancelBtn.addEventListener('click', () => closeEditModal());
editModalCloseBtn.addEventListener('click', () => closeEditModal());
editModalBackdrop.addEventListener('click', (ev) => {
  if (ev.target === editModalBackdrop) closeEditModal();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !editModalBackdrop.hidden) closeEditModal();
});

// --- Viewer modal (Döküm, Özet) ---------------------------------------------
// Read-only sibling of the edit modal above: "Dökümü Gör" / "Özeti Gör" open the card's
// full content here, behind the same blurred backdrop, instead of the old inline
// collapsible. Singleton like editModal — only one can be open at a time.
const viewerModalBackdrop = $<HTMLDivElement>('viewerModal');
const viewerModalTitleEl = $<HTMLHeadingElement>('viewerModalTitle');
const viewerModalBodyEl = $<HTMLDivElement>('viewerModalBody');
const viewerModalCloseBtn = $<HTMLButtonElement>('viewerModalClose');

function closeViewerModal(): void {
  closeModalAnimated(viewerModalBackdrop, () => viewerModalBodyEl.replaceChildren());
}

// --- PDF preview modal -------------------------------------------------------
// Shows the same document the PDF export writes, rendered in the main process and handed
// over as bytes. İndir / Paylaş / Yazdır all act on the meeting id rather than on these
// bytes, so each one re-renders from what is currently saved.

const pdfModalBackdrop = $<HTMLDivElement>('pdfModal');
const pdfModalTitleEl = $<HTMLHeadingElement>('pdfModalTitle');
const pdfModalStatusEl = $<HTMLDivElement>('pdfModalStatus');
const pdfModalFrame = $<HTMLIFrameElement>('pdfModalFrame');
const pdfDownloadBtn = $<HTMLButtonElement>('pdfDownloadBtn');
const pdfShareBtn = $<HTMLButtonElement>('pdfShareBtn');
const pdfPrintBtn = $<HTMLButtonElement>('pdfPrintBtn');
const pdfModalCloseBtn = $<HTMLButtonElement>('pdfModalClose');
const pdfModalNotice = $<HTMLDivElement>('pdfModalNotice');

// Chromium's PDF plugin draws its own 56px toolbar (file name, page count, zoom, sidebar,
// download, print) at the top of the frame — a second, foreign top bar sitting right under
// the modal header. `toolbar=0` + `navpanes=0` suppress both it and the thumbnail sidebar,
// leaving the modal header as the only chrome; İndir / Paylaş / Yazdır cover what they did.
// `view=FitH` then fills the freed width with the page. Verified against Electron 33's
// bundled viewer for both file: and blob: sources.
const PDF_VIEWER_PARAMS = '#toolbar=0&navpanes=0&view=FitH';

let pdfMeetingId: string | null = null;
let pdfMeetingName = '';
// Held so it can be revoked on close — a blob: URL keeps its bytes alive until it is.
let pdfObjectUrl: string | null = null;
// Bumped on every open so a slow render that resolves after the user closed (or opened
// another meeting) can tell it is stale and drop its result.
let pdfRenderToken = 0;

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// IPC rejections arrive as "Error invoking remote method 'x': Error: real message". The
// prefix is noise for the user and buries the part that actually says what went wrong.
function cleanIpcError(e: unknown): string {
  return errorText(e)
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '');
}

function closePdfModal(): void {
  pdfRenderToken += 1;
  closeModalAnimated(pdfModalBackdrop, () => {
    pdfModalFrame.hidden = true;
    pdfModalFrame.removeAttribute('src');
    if (pdfObjectUrl) URL.revokeObjectURL(pdfObjectUrl);
    pdfObjectUrl = null;
    pdfMeetingId = null;
    pdfModalNotice.hidden = true;
  });
}

// The failure state is a real message plus a retry, not a dead end: a PDF render can fail
// for transient reasons (a busy GPU surface, a locked temp dir) where retrying just works.
function showPdfError(message: string): void {
  pdfModalStatusEl.hidden = false;
  pdfModalStatusEl.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'pdf-modal-error';

  const icon = document.createElement('i');
  icon.className = 'bx bx-error-circle';

  const title = document.createElement('p');
  title.className = 'pdf-modal-error-title';
  title.textContent = 'PDF oluşturulamadı';

  const detail = document.createElement('p');
  detail.className = 'pdf-modal-error-detail';
  detail.textContent = message;

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn-sm btn-primary';
  retry.innerHTML = '<i class="bx bx-refresh"></i> Tekrar Dene';
  retry.addEventListener('click', () => {
    if (pdfMeetingId) void openPdfModal(pdfMeetingId, pdfMeetingName);
  });

  wrap.append(icon, title, detail, retry);
  pdfModalStatusEl.append(wrap);
}

async function openPdfModal(id: string, name: string): Promise<void> {
  pdfMeetingId = id;
  pdfMeetingName = name;
  pdfModalTitleEl.textContent = name;
  pdfModalFrame.hidden = true;
  pdfModalFrame.removeAttribute('src');
  pdfModalStatusEl.hidden = false;
  pdfModalStatusEl.replaceChildren('PDF hazırlanıyor…');
  pdfModalNotice.hidden = true;
  pdfModalBackdrop.classList.remove('is-closing');
  pdfModalBackdrop.hidden = false;
  // A selection made before the modal opened (a Ctrl+A on the list, say) already spans the
  // modal's markup, and the CSS rule above only keeps it from painting over the viewer —
  // the range itself is still there. Drop it so nothing behind the modal stays highlighted.
  window.getSelection()?.removeAllRanges();

  const token = ++pdfRenderToken;
  try {
    // Guards the stale-bundle case explicitly: if the running app still has the old
    // preload, this method is simply absent and the generic catch would blame the PDF.
    if (typeof window.api.renderMeetingPdf !== 'function') {
      throw new Error(
        'Uygulama güncel değil (window.api.renderMeetingPdf yok). Uygulamayı kapatıp yeniden başlatın.',
      );
    }
    const bytes = await window.api.renderMeetingPdf(id);
    if (token !== pdfRenderToken) return; // superseded or closed while rendering
    if (pdfObjectUrl) URL.revokeObjectURL(pdfObjectUrl);
    // Copied into a standalone ArrayBuffer rather than passed straight to Blob: the IPC
    // value is a Uint8Array view, and handing Blob the view's underlying buffer would
    // include anything outside its byteOffset/byteLength window.
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    // pdfObjectUrl stays the bare blob: URL — revokeObjectURL does not accept the fragment.
    pdfObjectUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' }));
    pdfModalFrame.src = pdfObjectUrl + PDF_VIEWER_PARAMS;
    pdfModalFrame.hidden = false;
    pdfModalStatusEl.hidden = true;
  } catch (e) {
    if (token !== pdfRenderToken) return;
    console.error('PDF önizleme başarısız:', e);
    showPdfError(cleanIpcError(e));
  }
}

pdfModalCloseBtn.addEventListener('click', () => closePdfModal());
pdfModalBackdrop.addEventListener('click', (ev) => {
  if (ev.target === pdfModalBackdrop) closePdfModal();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !pdfModalBackdrop.hidden) closePdfModal();
});

// Every action here is async and can fail in the main process. They used to only
// console.error, which from the outside is indistinguishable from a dead button — so each
// one now disables while it runs and reports failure through the native alert.
async function runPdfAction(
  btn: HTMLButtonElement,
  label: string,
  run: () => Promise<unknown>,
): Promise<void> {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await run();
  } catch (e) {
    console.error(`${label} başarısız:`, e);
    await window.api.showAlert(`${label} başarısız oldu:\n\n${cleanIpcError(e)}`);
  } finally {
    btn.disabled = false;
  }
}

pdfDownloadBtn.addEventListener('click', () => {
  const id = pdfMeetingId;
  if (!id) return;
  void runPdfAction(pdfDownloadBtn, 'PDF indirme', () => window.api.exportMeeting(id, 'pdf'));
});

pdfPrintBtn.addEventListener('click', () => {
  const id = pdfMeetingId;
  if (!id) return;
  void runPdfAction(pdfPrintBtn, 'Yazdırma', async () => {
    pdfModalNotice.hidden = true;
    const result = await window.api.printMeeting(id);
    if (result.reason !== 'unavailable') return;
    const message = pdfModalNotice.querySelector('span');
    if (message) {
      message.textContent =
        'Windows yazdırma hizmeti kullanılamıyor. PDF indirmek veya paylaşmak için yukarıdaki düğmeleri kullanabilirsiniz.';
    }
    pdfModalNotice.hidden = false;
  });
});

// One action, wherever it is triggered from — the modal's Paylaş button and the export
// menu's Paylaş item both land here. Dismissing the sheet comes back as 'cancelled' rather
// than an error, so only the no-share-sheet platforms have anything to report.
export async function sharePdfFor(id: string): Promise<void> {
  const { method } = await window.api.sharePdf(id);
  if (method === 'revealed') {
    await window.api.showAlert(
      'Bu sistemde paylaşım penceresi yok. PDF dosya gezgininde gösterildi.',
    );
  }
}

pdfShareBtn.addEventListener('click', () => {
  const id = pdfMeetingId;
  if (!id) return;
  void runPdfAction(pdfShareBtn, 'Paylaşma', () => sharePdfFor(id));
});

function openViewerModal(title: string, node: Node): void {
  viewerModalTitleEl.textContent = title;
  viewerModalBodyEl.replaceChildren(node);
  viewerModalBackdrop.classList.remove('is-closing');
  viewerModalBackdrop.hidden = false;
}

viewerModalCloseBtn.addEventListener('click', () => closeViewerModal());
viewerModalBackdrop.addEventListener('click', (ev) => {
  if (ev.target === viewerModalBackdrop) closeViewerModal();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !viewerModalBackdrop.hidden) closeViewerModal();
});

export function initDashboard(deps: DashboardDeps): {
  refreshList: () => Promise<void>;
  openMeeting: (id: string) => Promise<void>;
  showList: () => void;
  hidePanes: () => void;
} {
  const listPane = $<HTMLDivElement>('listPane');
  const detailPane = $<HTMLDivElement>('detailPane');
  const tableBody = $<HTMLTableSectionElement>('meetingTableBody');
  const listEmpty = $<HTMLDivElement>('listEmpty');
  const topbarTitle = $<HTMLSpanElement>('topbarTitle');

  const detailTitle = $<HTMLHeadingElement>('detailTitle');
  const detailActions = $<HTMLDivElement>('detailActions');
  const detailReanalyzeBtn = $<HTMLButtonElement>('detailReanalyzeBtn');
  const detailNameSpeakersBtn = $<HTMLButtonElement>('detailNameSpeakersBtn');
  const detailUndoEditBtn = $<HTMLButtonElement>('detailUndoEditBtn');
  const detailTranscript = $<HTMLDivElement>('detailTranscript');
  const analysisSectionCards = $<HTMLDivElement>('analysisSectionCards');
  const detailNoAnalysis = $<HTMLDivElement>('detailNoAnalysis');
  const detailExportMenu = $<HTMLUListElement>('detailExportMenu');
  const backToList = $<HTMLButtonElement>('backToList');
  const newRecordingBtn = $<HTMLButtonElement>('newRecordingBtn');

  // The meeting currently open in the detail pane (for its export button).
  let openId: string | null = null;
  let openMeetingHasEdited = false;
  let openMeetingHasSpeakers = false;
  let currentAnalysisDraft: AnalysisDraft = emptyAnalysisDraft();
  // The open meeting's ACTIVE segments — what the naming panel reads. After a naming they
  // carry the assigned names, which is what lets the panel be reopened to rename again.
  let currentSegments: Segment[] = [];
  let currentMeetings: MeetingSummary[] = [];
  // The <tr> being dragged for reorder, or null when no drag is in progress.
  let draggingRow: HTMLTableRowElement | null = null;
  const buttonStates = new WeakMap<HTMLButtonElement | HTMLAnchorElement, SingleFlightInteractionState>();

  // Buttons use the native `disabled` property; the export dropdown's <a> items have no
  // such property, so they're disabled via the same `.disabled` class Bootstrap already
  // styles dropdown-items with.
  function setDisabled(el: HTMLButtonElement | HTMLAnchorElement, disabled: boolean): void {
    if (el instanceof HTMLButtonElement) el.disabled = disabled;
    else el.classList.toggle('disabled', disabled);
  }

  async function runButtonOnce(
    button: HTMLButtonElement | HTMLAnchorElement,
    action: () => Promise<void>,
  ): Promise<void> {
    let state = buttonStates.get(button);
    if (!state) {
      state = new SingleFlightInteractionState();
      buttonStates.set(button, state);
    }
    if (!state.begin()) return;
    setDisabled(button, true);
    try {
      await action();
    } catch (error) {
      console.error('Buton işlemi başarısız:', error);
    } finally {
      state.finish();
      if (button.isConnected) setDisabled(button, false);
    }
  }

  async function saveAnalysisEdit(markdown: string): Promise<void> {
    if (!openId) return;
    const sourceId = openId;
    const analysis: Analysis = {
      status: 'success',
      markdown,
    };

    try {
      if (typeof window.api.saveMeetingEdit !== 'function') {
        throw new Error('Ana süreç eski bir uygulama sürümünü çalıştırıyor.');
      }
      await window.api.saveMeetingEdit(sourceId, analysis);
      await openMeeting(sourceId);
    } catch (error) {
      console.error('Düzenleme kaydedilemedi:', error);
      await window.api.showAlert('Düzenleme kaydedilemedi. Uygulamayı tamamen kapatıp yeniden açın.');
      await openMeeting(sourceId);
    }
  }

  const transcriptViewBtn = $<HTMLButtonElement>('transcriptViewBtn');
  const transcriptMeta = $<HTMLParagraphElement>('transcriptMeta');

  transcriptViewBtn.addEventListener('click', () => {
    const list = document.createElement('div');
    list.className = 'segment-list';
    list.append(...Array.from(detailTranscript.children, (n) => n.cloneNode(true)));
    openViewerModal('Döküm', list);
  });

  const analysisFullViewBtn = $<HTMLButtonElement>('analysisFullViewBtn');
  const analysisFullMeta = $<HTMLParagraphElement>('analysisFullMeta');

  analysisFullViewBtn.addEventListener('click', () => {
    const body = document.createElement('div');
    body.className = 'analysis-full';
    // Rendered from the live draft, not the saved markdown, so a card edit shows here
    // immediately — renderAnalysisCards() runs before the save round-trip completes.
    body.innerHTML = renderAnalysisMarkdown(serializeAnalysisMarkdown(currentAnalysisDraft));
    openViewerModal('Detaylı Analiz', body);
  });

  function analysisSectionTableNode(items: string[]): HTMLElement {
    const table = document.createElement('table');
    table.className = 'table analysis-section-table mb-0';
    const body = document.createElement('tbody');
    const visibleItems = items.length > 0 ? items : [EMPTY_SECTION_TEXT];
    body.append(
      ...visibleItems.map((item) => {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.innerHTML = renderAnalysisInlineMarkdown(item);
        if (items.length === 0) cell.classList.add('analysis-section-empty');
        row.append(cell);
        return row;
      }),
    );
    table.append(body);
    return table;
  }

  function editAnalysisSection(key: AnalysisSectionKey, title: string, items: string[]): void {
    openEditModal({
      title,
      items,
      onSave: (nextItems) => {
        const result = replaceAnalysisSection(currentAnalysisDraft, key, nextItems);
        currentAnalysisDraft = result.draft;
        renderAnalysisCards();
        void saveAnalysisEdit(result.markdown);
      },
    });
  }

  function renderAnalysisCards(): void {
    const views = analysisSectionViews(serializeAnalysisMarkdown(currentAnalysisDraft));

    const filled = views.filter((section) => !section.empty);
    const totalItems = filled.reduce((sum, section) => sum + section.count, 0);
    analysisFullMeta.textContent = filled.length === 0
      ? 'İçerik yok'
      : `${filled.length} bölüm · ${totalItems} madde`;

    analysisSectionCards.replaceChildren(
      ...views.map((section) => {
        const card = document.createElement('div');
        card.className = `card analysis-section-card ${analysisSectionThemeClass(section.key)}`;

        const header = document.createElement('div');
        header.className = 'card-header d-flex justify-content-between align-items-center';
        const heading = document.createElement('h6');
        heading.className = 'mb-0';
        heading.textContent = section.title;
        const edit = document.createElement('button');
        edit.type = 'button';
        // tooltip-end because the button sits at the card's right edge and the card is
        // overflow:hidden — a centered tooltip would be clipped mid-word.
        edit.className =
          'btn btn-icon btn-sm btn-text-secondary rounded-pill edit-btn has-tooltip tooltip-end';
        edit.dataset.tooltip = 'Düzenle';
        edit.setAttribute('aria-label', 'Düzenle');
        edit.innerHTML = '<i class="bx bx-edit"></i>';
        edit.addEventListener('click', () =>
          editAnalysisSection(section.key, section.title, section.items),
        );
        header.append(heading, edit);

        const body = document.createElement('div');
        body.className = 'card-body view-card-body';
        const meta = document.createElement('p');
        meta.className = 'view-card-meta';
        meta.textContent = section.empty ? 'İçerik yok' : `${section.count} madde`;
        const view = document.createElement('button');
        view.type = 'button';
        view.className = 'btn btn-outline-primary btn-sm';
        view.innerHTML = '<i class="bx bx-show"></i> Görüntüle';
        view.addEventListener('click', () =>
          openViewerModal(section.title, analysisSectionTableNode(section.items)),
        );
        body.append(meta, view);
        card.append(header, body);
        return card;
      }),
    );
  }


  // The detail pane's scroller — everything below the fixed head. Held here so opening a
  // meeting can rewind it (see openMeeting).
  const detailScroll = detailPane.querySelector<HTMLElement>('.detail-scroll');

  function showList(): void {
    listPane.hidden = false;
    detailPane.hidden = true;
    topbarTitle.textContent = 'Toplantı Kayıtları';
  }

  function showDetail(): void {
    listPane.hidden = true;
    detailPane.hidden = false;
  }

  // Both meeting panes off, for when another pane of the shell (Settings) takes the stage.
  function hidePanes(): void {
    listPane.hidden = true;
    detailPane.hidden = true;
  }

  function rowNode(m: MeetingSummary): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.className = 'meeting-row';
    tr.tabIndex = 0;
    tr.dataset.id = m.id;
    const renameState = new RenameInteractionState();
    let suppressNextRowOpen = false;

    // Drag-to-reorder handle. The row is only made draggable while the pointer is on the
    // handle, so row text stays selectable and click-to-open keeps working elsewhere.
    // The handle is a <button>, so meetingRowTarget classifies it as 'button' -> the row
    // click never opens the meeting from here.
    const handleTd = document.createElement('td');
    handleTd.className = 'drag-cell';
    const handle = document.createElement('button');
    handle.className = 'drag-handle';
    handle.type = 'button';
    handle.setAttribute('aria-label', 'Sürükleyerek sırala');
    handle.innerHTML = "<i class='bx bx-grid-vertical'></i>";
    handle.addEventListener('mousedown', () => {
      tr.draggable = true;
    });
    const releaseDrag = (): void => {
      tr.draggable = false;
    };
    handle.addEventListener('mouseup', releaseDrag);
    handleTd.append(handle);
    tr.addEventListener('dragstart', (event) => {
      draggingRow = tr;
      event.dataTransfer?.setData('text/plain', m.id);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMG, 0, 0); // no washed-out ghost
      }
      // Suppress Bootstrap's per-row :hover grey for the duration of the drag, so the only
      // highlight is the held row (.dragging) — not whatever row the cursor passes over.
      tableBody.classList.add('reordering');
      // Defer the lifted style one frame: applying it synchronously would let some engines
      // snapshot the *styled* row for the (now hidden) drag image.
      requestAnimationFrame(() => tr.classList.add('dragging'));
    });
    tr.addEventListener('dragend', () => {
      tr.classList.remove('dragging');
      tableBody.classList.remove('reordering');
      releaseDrag();
      draggingRow = null;
      // Drop the FLIP inline styles so nothing lingers after the drag settles.
      for (const row of tableBody.querySelectorAll<HTMLTableRowElement>('tr[data-id]')) {
        row.style.transition = '';
        row.style.transform = '';
      }
      persistRowOrder();
    });

    const syncRenamePhase = (): void => {
      tr.dataset.renamePhase = renameState.phase;
    };
    syncRenamePhase();

    const nameTd = document.createElement('td');
    const name = document.createElement('span');
    name.className = 'meeting-name';
    name.textContent = m.name || fallbackMeetingName(m.createdAt);
    name.tabIndex = 0;
    name.role = 'button';
    const pencil = document.createElement('button');
    pencil.className = 'btn btn-sm btn-icon-only rename-btn has-tooltip';
    pencil.type = 'button';
    pencil.dataset.tooltip = 'Yeniden İsimlendir';
    pencil.setAttribute('aria-label', 'Yeniden İsimlendir');
    pencil.innerHTML = "<i class='bx bx-pencil'></i>";

    const startRename = (): void => {
      if (!renameState.begin()) return;
      syncRenamePhase();
      const displayName = m.name || fallbackMeetingName(m.createdAt);
      const editableName = displayName;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'form-control form-control-sm d-inline-block meeting-name-input';
      input.value = editableName;
      let finished = false;

      const restore = (): void => {
        if (input.isConnected) input.replaceWith(name);
        pencil.disabled = false;
        renameState.reset();
        syncRenamePhase();
      };
      const commit = async (): Promise<void> => {
        if (finished || !renameState.beginSave()) return;
        finished = true;
        syncRenamePhase();
        const value = input.value.trim();
        if (!value || value === editableName) {
          restore();
          return;
        }
        try {
          await window.api.renameMeeting(m.id, value);
          await refreshList();
        } catch (error) {
          console.error('Yeniden adlandırma başarısız:', error);
          restore();
        }
      };

      name.replaceWith(input);
      pencil.disabled = true;
      input.focus();
      input.select();
      input.addEventListener('blur', () => void commit());
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finished = true;
          restore();
        }
      });
    };

    pencil.addEventListener('click', (event) => {
      event.stopPropagation();
      startRename();
    });
    name.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      startRename();
    });
    nameTd.append(name);
    // Sibling of the name rather than a cell of its own: it is an annotation ON the
    // meeting, and it appears on a minority of rows, so an always-empty column would
    // cost every row width for nothing. A sibling also survives the rename swap, which
    // replaces only the name span.
    if (m.status === 'transcript-only') {
      const badge = document.createElement('span');
      badge.className = 'meeting-badge meeting-badge-pending';
      badge.textContent = 'Analiz bekliyor';
      badge.title = 'Bu toplantının dökümü kaydedildi ama analizi yok. Açıp Yeniden Analiz Et diyebilirsiniz.';
      nameTd.append(badge);
    }

    // Icon-only, right-aligned, in fixed order: Dışa Aktar · Yeniden İsimlendir · Sil.
    // "Görüntüle" is gone — clicking the row already opens the meeting, so it was a second
    // control for an action the row itself performs.
    const actionsTd = document.createElement('td');
    actionsTd.className = 'meeting-actions';
    actionsTd.innerHTML = `
      <div class="btn-group">
        <button
          class="btn btn-sm btn-outline-secondary btn-icon-only dropdown-toggle has-tooltip"
          type="button"
          data-bs-toggle="dropdown"
          aria-expanded="false"
          aria-label="Dışa Aktar"
          data-tooltip="Dışa Aktar"
        >
          <i class='bx bx-export'></i>
        </button>
        <ul class="dropdown-menu dropdown-menu-end">
          <li>
            <a class="dropdown-item" href="#" data-id="${m.id}" data-action="pdf-preview">
              <i class='bx bx-file'></i> PDF Göster
            </a>
          </li>
          <li>
            <a class="dropdown-item" href="#" data-id="${m.id}" data-action="share">
              <i class='bx bx-share-alt'></i> Paylaş
            </a>
          </li>
          <li><hr class="dropdown-divider" /></li>
          <li>
            <a class="dropdown-item" href="#" data-id="${m.id}" data-format="md">
              <i class='bx bx-download'></i> Markdown (.md)
            </a>
          </li>
          <li>
            <a class="dropdown-item" href="#" data-id="${m.id}" data-format="pdf">
              <i class='bx bx-download'></i> PDF (.pdf)
            </a>
          </li>
        </ul>
      </div>`;
    actionsTd.append(pencil);
    actionsTd.insertAdjacentHTML(
      'beforeend',
      `<button
        class="btn btn-sm btn-outline-danger btn-icon-only has-tooltip"
        data-action="delete"
        data-id="${m.id}"
        aria-label="Sil"
        data-tooltip="Sil"
      ><i class='bx bx-trash'></i></button>`,
    );

    tr.append(handleTd, nameTd, actionsTd);
    tr.addEventListener('pointerdown', (event) => {
      if (
        renameState.phase === 'editing' &&
        meetingRowTarget(event.target as HTMLElement) === 'row'
      ) {
        suppressNextRowOpen = true;
      }
    });
    tr.addEventListener('click', (event) => {
      const intent = meetingRowIntent(
        meetingRowTarget(event.target as HTMLElement),
        renameState.phase,
        suppressNextRowOpen,
      );
      suppressNextRowOpen = false;
      if (intent === 'rename') startRename();
      else if (intent === 'open') void openMeeting(m.id);
    });
    tr.addEventListener('keydown', (event) => {
      if (event.target !== tr || event.key !== 'Enter') return;
      if (meetingRowIntent('row', renameState.phase) === 'open') void openMeeting(m.id);
    });
    return tr;
  }

  async function refreshList(): Promise<void> {
    const meetings = await window.api.listMeetings();
    const ordered = orderMeetings(meetings, loadOrder());
    saveOrder(ordered.map((m) => m.id)); // persist the reconciled order (new rows folded in, deleted pruned)
    currentMeetings = ordered;
    tableBody.replaceChildren(...ordered.map(rowNode));
    listEmpty.hidden = ordered.length > 0;
    showList();
  }

  async function openMeeting(id: string): Promise<void> {
    closeEditModal();
    closeViewerModal();
    closeSpeakerNamesModal();

    const m: MeetingDetail = await window.api.readMeeting(id);
    openId = m.id;
    openMeetingHasEdited = m.hasEdited;
    openMeetingHasSpeakers = m.hasOriginalSpeakers;
    currentSegments = m.segments;
    detailTitle.textContent = m.name || fallbackMeetingName(m.createdAt);
    detailActions.classList.toggle('has-edited', m.hasEdited);
    detailUndoEditBtn.setAttribute('aria-hidden', String(!m.hasEdited));
    detailUndoEditBtn.tabIndex = m.hasEdited ? 0 : -1;
    // The ACTIVE transcript decides, not hasOriginalSpeakers: after a naming the labels
    // are names, and the panel must stay reachable to correct them.
    const canNameSpeakers = m.segments.some((segment) => Boolean(segment.speaker));
    detailActions.classList.toggle('has-speakers', canNameSpeakers);
    detailNameSpeakersBtn.setAttribute('aria-hidden', String(!canNameSpeakers));
    detailNameSpeakersBtn.tabIndex = canNameSpeakers ? 0 : -1;

    detailTranscript.replaceChildren(...m.segments.map(segmentNode));
    transcriptMeta.textContent = `${m.segments.length} segment`;

    const a = m.analysis;
    currentAnalysisDraft = a ? parseAnalysisMarkdown(a.markdown) : emptyAnalysisDraft();
    detailNoAnalysis.hidden = Boolean(a);
    renderAnalysisCards();

    // The pane's scroller is reused across meetings, so without this a meeting opened after
    // scrolling through another one would start halfway down.
    if (detailScroll) detailScroll.scrollTop = 0;
    showDetail();
  }

  async function doExport(id: string, format: ExportFormat): Promise<void> {
    try {
      await window.api.exportMeeting(id, format);
    } catch (e) {
      console.error('Dışa aktarma başarısız:', e);
      await window.api.showAlert('Dışa aktarma başarısız oldu. Lütfen tekrar deneyin.');
    }
  }

  // Replaces the old "Mail ile Gönder" stub: instead of a mailto backend of our own, hand
  // the PDF to the OS share sheet, which already knows the user's mail and chat apps.
  async function doShare(id: string): Promise<void> {
    try {
      await sharePdfFor(id);
    } catch (e) {
      console.error('Paylaşma başarısız:', e);
      await window.api.showAlert('Paylaşma başarısız oldu. Lütfen tekrar deneyin.');
    }
  }

  // Delete is irreversible (the folder's transcript + analysis are removed for good), so
  // confirm first. On success rebuild the list; if the deleted meeting was open in the
  // detail pane, fall back to the list since its record no longer exists.
  async function doDelete(id: string): Promise<void> {
    const meeting = currentMeetings.find((candidate) => candidate.id === id);
    const pairText = meeting?.hasEdited ? ' ve düzenlenmiş kopyası' : '';
    const confirmed = await window.api.confirmDelete(
      `Bu toplantı kaydı${pairText} kalıcı olarak silinecek. Devam edilsin mi?`,
    );
    if (!confirmed) return;
    try {
      await window.api.deleteMeeting(id);
      openId = null;
      await refreshList();
    } catch (e) {
      console.error('Silme başarısız:', e);
    }
  }

  async function undoMeetingEdit(): Promise<void> {
    if (!openId) return;
    const id = openId;
    const confirmed = await window.api.confirmDelete(
      'Düzenlenmiş sürüm silinecek ve orijinal toplantı geri yüklenecek. Devam edilsin mi?',
    );
    if (!confirmed) return;
    try {
      await window.api.revertMeetingEdit(id);
      await openMeeting(id);
    } catch (error) {
      console.error('Düzenleme geri alınamadı:', error);
      await window.api.showAlert('Düzenleme geri alınamadı. Lütfen tekrar deneyin.');
    }
  }

  // --- Speaker naming panel --------------------------------------------------
  // Reads only what is already on screen (active segments + the current analysis draft):
  // naming is a decision the user makes from evidence, so no re-analysis and no LLM call
  // is involved — the save goes through the ordinary edit path.
  const speakerNamesBackdrop = $<HTMLDivElement>('speakerNamesModal');
  const speakerNamesRows = $<HTMLDivElement>('speakerNamesRows');
  const speakerNamesCountEl = $<HTMLSpanElement>('speakerNamesCount');
  const speakerNamesNav = $<HTMLDivElement>('speakerNamesNav');
  const speakerNamesPrevBtn = $<HTMLButtonElement>('speakerNamesPrev');
  const speakerNamesNextBtn = $<HTMLButtonElement>('speakerNamesNext');
  const speakerNamesSaveBtn = $<HTMLButtonElement>('speakerNamesSave');
  const speakerNamesCancelBtn = $<HTMLButtonElement>('speakerNamesCancel');
  const speakerNamesCloseBtn = $<HTMLButtonElement>('speakerNamesModalClose');
  const speakerNamesBody = speakerNamesBackdrop.querySelector<HTMLDivElement>('.edit-modal-body')!;
  let speakerPage = 0;

  function closeSpeakerNamesModal(): void {
    closeModalAnimated(speakerNamesBackdrop, () => speakerNamesRows.replaceChildren());
  }

  // Pages are hidden, never rebuilt: a name typed on page 1 (and that row's error state)
  // has to survive a walk to page 3 and back.
  function showSpeakerPage(index: number, direction: 'next' | 'prev' | null): void {
    const pages = Array.from(speakerNamesRows.querySelectorAll<HTMLElement>('.speaker-name-row'));
    if (pages.length === 0) return;
    speakerPage = Math.min(Math.max(index, 0), pages.length - 1);

    pages.forEach((page, i) => {
      page.classList.remove('is-entering-next', 'is-entering-prev');
      page.hidden = i !== speakerPage;
    });

    const current = pages[speakerPage]!;
    if (direction) {
      const enter = `is-entering-${direction}`;
      // Flush layout between un-hiding and arming the animation: both happen in one tick,
      // and a style recalc that sees display:none -> displayed *and* the animation-name
      // appear together can treat it as no change and never start the animation.
      void current.offsetWidth;
      current.classList.add(enter);
      current.addEventListener(
        'animationend',
        () => current.classList.remove(enter),
        { once: true },
      );
    }

    speakerNamesCountEl.textContent = `${speakerPage + 1} / ${pages.length}`;
    speakerNamesPrevBtn.disabled = speakerPage === 0;
    speakerNamesNextBtn.disabled = speakerPage === pages.length - 1;
    // With one speaker there is nowhere to go, so the controls would be three dead pixels.
    speakerNamesNav.hidden = pages.length < 2;
    // The previous page may have been scrolled down; a new page must start at its heading.
    speakerNamesBody.scrollTop = 0;
  }

  function speakerEvidenceColumn(title: string, fill: (list: HTMLElement) => boolean): HTMLElement {
    const column = document.createElement('div');
    column.className = 'speaker-name-column';
    const heading = document.createElement('h6');
    heading.textContent = title;
    const list = document.createElement('div');
    list.className = 'speaker-name-list';
    if (!fill(list)) {
      const empty = document.createElement('p');
      empty.className = 'speaker-name-empty';
      empty.textContent = 'Kayıt yok.';
      list.append(empty);
    }
    column.append(heading, list);
    return column;
  }

  // index, not the label, builds the field id: once a speaker has been named the label IS
  // that name, and a name with a space is not a valid id.
  function speakerNameRowNode(label: string, index: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'speaker-name-row';
    row.dataset.label = label;

    const lines = speakerTranscriptLines(currentSegments, label);
    const mentions = analysisItemsBySpeaker(currentAnalysisDraft, label);

    const head = document.createElement('div');
    head.className = 'speaker-name-head';
    const name = document.createElement('span');
    name.className = 'speaker-name-label';
    name.textContent = label;
    const count = document.createElement('span');
    count.className = 'speaker-name-count';
    count.textContent = `${lines.length} replik · analizde ${mentions.length} madde`;
    head.append(name);
    // Whether this speaker was in the room or on the call is often the fastest clue to
    // who they are, so it sits next to the label rather than buried in the evidence.
    const source = speakerSource(currentSegments, label);
    if (source) head.append(sourceBadge(source));
    head.append(count);

    const evidence = document.createElement('div');
    evidence.className = 'speaker-name-evidence';
    evidence.append(
      speakerEvidenceColumn('Analizde', (list) => {
        for (const mention of mentions) {
          const p = document.createElement('p');
          const section = document.createElement('span');
          section.className = 'speaker-name-section';
          section.textContent = mention.sectionTitle;
          const text = document.createElement('span');
          // Same render path the section cards use, so **bold** reads the same here.
          text.innerHTML = renderAnalysisInlineMarkdown(mention.item);
          p.append(section, text);
          list.append(p);
        }
        return mentions.length > 0;
      }),
      speakerEvidenceColumn('Dökümde', (list) => {
        // One <p> per turn, matching how the Döküm card breaks a segment up.
        const turns = lines.flatMap((line) => splitTranscriptTurns(line));
        for (const turn of turns) {
          const p = document.createElement('p');
          p.textContent = turn;
          list.append(p);
        }
        return turns.length > 0;
      }),
    );

    const field = document.createElement('div');
    field.className = 'speaker-name-field';
    const fieldLabel = document.createElement('label');
    fieldLabel.textContent = 'Yeni isim';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control form-control-sm speaker-name-input';
    input.placeholder = `Boş bırakılırsa "${label}" olarak kalır`;
    fieldLabel.htmlFor = `speakerName-${index}`;
    input.id = fieldLabel.htmlFor;

    const error = document.createElement('p');
    error.className = 'speaker-name-error';
    error.hidden = true;

    input.addEventListener('input', () => {
      const message = speakerNameError(input.value);
      error.textContent = message ?? '';
      error.hidden = message === null;
    });

    field.append(fieldLabel, input);
    row.append(head, evidence, field, error);
    return row;
  }

  function openSpeakerNamesModal(): void {
    const labels = speakerLabels(currentSegments);
    if (labels.length === 0) return;
    speakerNamesRows.replaceChildren(...labels.map((label, index) => speakerNameRowNode(label, index)));
    // No direction on the first page: the modal's own panel-in animation is already
    // carrying it, and stacking a slide on top of that reads as a stutter.
    showSpeakerPage(0, null);
    speakerNamesBackdrop.classList.remove('is-closing');
    speakerNamesBackdrop.hidden = false;
  }

  async function applySpeakerNames(): Promise<void> {
    if (!openId) return;
    const sourceId = openId;
    const rows = Array.from(speakerNamesRows.querySelectorAll<HTMLElement>('.speaker-name-row'));
    const entries = rows.map((row) => ({
      label: row.dataset.label ?? '',
      name: row.querySelector<HTMLInputElement>('.speaker-name-input')?.value ?? '',
    }));

    // Re-validated on save, not just on input: a row the user never typed in has no error
    // shown yet, and an invalid name must never reach the stored transcript.
    let firstInvalid = -1;
    rows.forEach((row, index) => {
      const message = speakerNameError(entries[index]!.name);
      const error = row.querySelector<HTMLParagraphElement>('.speaker-name-error');
      if (error) {
        error.textContent = message ?? '';
        error.hidden = message === null;
      }
      if (message && firstInvalid < 0) firstInvalid = index;
    });
    // Saving from a later page must not fail silently: the offending row is on a hidden
    // page, so go to it — otherwise the button just looks dead.
    if (firstInvalid >= 0) {
      if (firstInvalid !== speakerPage) {
        showSpeakerPage(firstInvalid, firstInvalid > speakerPage ? 'next' : 'prev');
      }
      rows[firstInvalid]?.querySelector<HTMLInputElement>('.speaker-name-input')?.focus();
      return;
    }

    const mapping = buildSpeakerNameMap(entries);
    // Nothing changed: closing without a write is the whole point of "boş bırak = geç" —
    // an empty write would still create the edited copy and offer a pointless "Geri Al".
    if (Object.keys(mapping).length === 0) {
      closeSpeakerNamesModal();
      return;
    }

    try {
      if (typeof window.api.saveMeetingSpeakerNames !== 'function') {
        throw new Error('Ana süreç eski bir uygulama sürümünü çalıştırıyor.');
      }
      await window.api.saveMeetingSpeakerNames(sourceId, mapping);
      closeSpeakerNamesModal();
      await openMeeting(sourceId);
    } catch (error) {
      console.error('Konuşmacı adları kaydedilemedi:', error);
      await window.api.showAlert('Konuşmacı adları kaydedilemedi. Lütfen tekrar deneyin.');
      await openMeeting(sourceId);
    }
  }

  const reanalyzeModalBackdrop = $<HTMLDivElement>('reanalyzeModal');
  const reanalyzeModalMessage = $<HTMLParagraphElement>('reanalyzeModalMessage');
  const reanalyzeModalStatus = $<HTMLDivElement>('reanalyzeModalStatus');
  const reanalyzeIncludeSpeakers = $<HTMLInputElement>('reanalyzeIncludeSpeakers');
  const reanalyzeSpeakerSetting = reanalyzeIncludeSpeakers.closest<HTMLElement>('.reanalyze-setting');
  const reanalyzeSpeakersHelp = $<HTMLParagraphElement>('reanalyzeSpeakersHelp');
  const reanalyzeModalClose = $<HTMLButtonElement>('reanalyzeModalClose');
  const reanalyzeModalCancel = $<HTMLButtonElement>('reanalyzeModalCancel');
  const reanalyzeModalSubmit = $<HTMLButtonElement>('reanalyzeModalSubmit');
  let reanalysisRunning = false;
  let reanalysisModalOpening = false;

  function closeReanalyzeModal(force = false): void {
    if (reanalysisRunning && !force) return;
    closeModalAnimated(reanalyzeModalBackdrop, () => {
      reanalyzeModalStatus.hidden = true;
      reanalyzeModalStatus.replaceChildren();
      reanalyzeModalStatus.classList.remove('is-error');
    });
  }

  async function openReanalyzeModal(): Promise<void> {
    if (!openId || reanalysisRunning || reanalysisModalOpening) return;
    const meetingId = openId;
    reanalysisModalOpening = true;
    const mayUseSpeakers = true;
    let includeSpeakersByDefault = false;
    if (mayUseSpeakers) {
      try {
        includeSpeakersByDefault = (
          await window.api.getSettings()
        ).settings.analysis?.includeSpeakers ?? true;
      } catch (error) {
        console.warn('Genel analiz ayarı okunamadı; konuşmacılar dahil edilmeyecek:', error);
      }
    }
    reanalysisModalOpening = false;
    if (openId !== meetingId || reanalysisRunning) return;
    reanalyzeModalMessage.textContent = openMeetingHasEdited
      ? 'Yeniden analiz yalnızca orijinal dökümü kullanır. İşlem başarıyla tamamlandığında mevcut düzenlenmiş sürüm silinecektir.'
      : 'Toplantının dökümü değiştirilmeden, mevcut orijinal döküm yeniden analiz edilecektir.';
    reanalyzeModalStatus.hidden = true;
    reanalyzeModalStatus.replaceChildren();
    reanalyzeModalStatus.classList.remove('is-error');
    reanalyzeSpeakerSetting?.classList.toggle('capability-hidden', !mayUseSpeakers);
    reanalyzeIncludeSpeakers.checked = mayUseSpeakers && openMeetingHasSpeakers && includeSpeakersByDefault;
    reanalyzeIncludeSpeakers.disabled = !mayUseSpeakers || !openMeetingHasSpeakers;
    reanalyzeSpeakersHelp.textContent = openMeetingHasSpeakers
      ? 'Kapattığınızda konuşmacı etiketleri yalnızca analiz girdisinden çıkarılır; kayıtlı döküm değişmez.'
      : 'Orijinal dökümde konuşmacı etiketi bulunmadığı için bu seçenek kullanılamaz.';
    reanalyzeModalBackdrop.classList.remove('is-closing');
    reanalyzeModalBackdrop.hidden = false;
  }

  async function submitReanalysis(): Promise<void> {
    if (!openId || reanalysisRunning) return;
    const id = openId;
    reanalysisRunning = true;
    reanalyzeModalClose.disabled = true;
    reanalyzeModalCancel.disabled = true;
    reanalyzeModalSubmit.disabled = true;
    reanalyzeIncludeSpeakers.disabled = true;
    reanalyzeModalStatus.classList.remove('is-error');
    reanalyzeModalStatus.hidden = false;
    reanalyzeModalStatus.innerHTML = '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span><span>Analiz hazırlanıyor… Bu işlem birkaç dakika sürebilir.</span>';

    try {
      await window.api.reanalyzeMeeting(id, {
        includeSpeakers: reanalyzeIncludeSpeakers.checked,
      });
      reanalysisRunning = false;
      closeReanalyzeModal(true);
      await openMeeting(id);
    } catch (error) {
      console.error('Yeniden analiz başarısız:', error);
      reanalysisRunning = false;
      reanalyzeModalStatus.classList.add('is-error');
      // The provider's own message is the actionable half ("Analiz modeli seçilmemiş…"
      // names the settings tab to fix). The generic sentence alone left the user with
      // nothing to act on, which matters more now that a transcript-only meeting is
      // reanalysed here rather than merely re-run.
      reanalyzeModalStatus.textContent =
        `Yeniden analiz tamamlanamadı. Mevcut kayıt korundu. ${ipcErrorMessage(error)}`.trim();
    } finally {
      reanalyzeModalClose.disabled = false;
      reanalyzeModalCancel.disabled = false;
      reanalyzeModalSubmit.disabled = false;
      reanalyzeIncludeSpeakers.disabled = !openMeetingHasSpeakers;
    }
  }

  // Persist the current on-screen row order (after a drag) and keep currentMeetings in the
  // same order so the delete-confirm lookup and any future reference stay consistent.
  function persistRowOrder(): void {
    const ids = [...tableBody.querySelectorAll<HTMLTableRowElement>('tr[data-id]')].map(
      (row) => row.dataset.id!,
    );
    saveOrder(ids);
    currentMeetings = orderMeetings(currentMeetings, ids);
  }

  // FLIP: record every row's position, run the DOM reorder, then animate each displaced row
  // from its old spot to the new one so rows slide instead of teleporting.
  function reorderWithFlip(place: () => void): void {
    const rows = [...tableBody.querySelectorAll<HTMLTableRowElement>('tr[data-id]')];
    const firstTop = new Map(rows.map((r) => [r, r.getBoundingClientRect().top]));
    place();
    for (const r of rows) {
      if (r === draggingRow) continue; // the grabbed row jumps to the cursor slot; don't animate it
      const delta = (firstTop.get(r) ?? 0) - r.getBoundingClientRect().top;
      if (!delta) continue;
      r.style.transition = 'none';
      r.style.transform = `translateY(${delta}px)`;
      requestAnimationFrame(() => {
        r.style.transition = 'transform 150ms ease';
        r.style.transform = '';
      });
    }
  }

  // Live reorder while dragging: drop the dragged row above whichever row the cursor is
  // over the top half of (or at the end when past the last row). Only reorder when the
  // target slot actually changes, so FLIP doesn't restart every dragover tick.
  tableBody.addEventListener('dragover', (ev) => {
    const dragged = draggingRow;
    if (!dragged) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    const others = [...tableBody.querySelectorAll<HTMLTableRowElement>('tr[data-id]')].filter(
      (row) => row !== dragged,
    );
    const before =
      others.find((row) => {
        const box = row.getBoundingClientRect();
        return ev.clientY < box.top + box.height / 2;
      }) ?? null;
    if (before === dragged.nextElementSibling) return; // already in this slot — no-op
    reorderWithFlip(() => tableBody.insertBefore(dragged, before));
  });
  tableBody.addEventListener('drop', (ev) => ev.preventDefault());

  // The export dropdown's items are <a> tags inside a Bootstrap dropdown-menu, separate
  // from the button[data-action] delegation below.
  tableBody.addEventListener('click', (ev) => {
    const link = (ev.target as HTMLElement).closest<HTMLAnchorElement>(
      'a[data-format], a[data-action="share"], a[data-action="pdf-preview"]',
    );
    if (!link) return;
    ev.preventDefault();
    ev.stopPropagation(); // don't also satisfy the tr's row-open listener below
    const id = link.dataset.id!;
    if (link.dataset.action === 'pdf-preview') {
      const meeting = currentMeetings.find((m) => m.id === id);
      void openPdfModal(id, meeting?.name || fallbackMeetingName(meeting?.createdAt ?? ''));
      return;
    }
    if (link.dataset.action === 'share') {
      void runButtonOnce(link, () => doShare(id));
      return;
    }
    const format: ExportFormat = (link.dataset.format as ExportFormat | undefined) ?? 'pdf';
    void runButtonOnce(link, () => doExport(id, format));
  });

  // Row actions via delegation (rows are rebuilt on every refresh).
  tableBody.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!btn) return;
    if (btn.closest<HTMLTableRowElement>('tr')?.dataset.renamePhase !== 'idle') return;
    const id = btn.dataset.id!;
    const action = meetingButtonAction(btn.dataset.action);
    if (!action) return;
    void runButtonOnce(btn, async () => {
      if (action === 'open') await openMeeting(id);
      else await doDelete(id);
    });
  });

  detailExportMenu.addEventListener('click', (ev) => {
    const link = (ev.target as HTMLElement).closest<HTMLAnchorElement>(
      'a[data-format], a[data-action="share"], a[data-action="pdf-preview"]',
    );
    if (!link) return;
    ev.preventDefault();
    const id = openId;
    if (!id) return;
    if (link.dataset.action === 'pdf-preview') {
      void openPdfModal(id, detailTitle.textContent || 'Toplantı');
      return;
    }
    if (link.dataset.action === 'share') {
      void runButtonOnce(link, () => doShare(id));
      return;
    }
    const format: ExportFormat = (link.dataset.format as ExportFormat | undefined) ?? 'pdf';
    void runButtonOnce(link, () => doExport(id, format));
  });
  backToList.addEventListener('click', () => void runButtonOnce(backToList, refreshList));
  detailReanalyzeBtn.addEventListener('click', () => void openReanalyzeModal());
  detailNameSpeakersBtn.addEventListener('click', () => openSpeakerNamesModal());
  detailUndoEditBtn.addEventListener('click', () =>
    void runButtonOnce(detailUndoEditBtn, undoMeetingEdit),
  );
  speakerNamesSaveBtn.addEventListener('click', () =>
    void runButtonOnce(speakerNamesSaveBtn, applySpeakerNames),
  );
  speakerNamesPrevBtn.addEventListener('click', () => showSpeakerPage(speakerPage - 1, 'prev'));
  speakerNamesNextBtn.addEventListener('click', () => showSpeakerPage(speakerPage + 1, 'next'));
  speakerNamesCancelBtn.addEventListener('click', () => closeSpeakerNamesModal());
  speakerNamesCloseBtn.addEventListener('click', () => closeSpeakerNamesModal());
  speakerNamesBackdrop.addEventListener('click', (event) => {
    if (event.target === speakerNamesBackdrop) closeSpeakerNamesModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !speakerNamesBackdrop.hidden) closeSpeakerNamesModal();
  });
  reanalyzeModalClose.addEventListener('click', () => closeReanalyzeModal());
  reanalyzeModalCancel.addEventListener('click', () => closeReanalyzeModal());
  reanalyzeModalSubmit.addEventListener('click', () => void submitReanalysis());
  reanalyzeModalBackdrop.addEventListener('click', (event) => {
    if (event.target === reanalyzeModalBackdrop) closeReanalyzeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !reanalyzeModalBackdrop.hidden) closeReanalyzeModal();
  });
  newRecordingBtn.addEventListener('click', () => deps.onNewRecording());

  return { refreshList, openMeeting, showList, hidePanes };
}
