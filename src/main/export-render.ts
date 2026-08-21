// Renders export-html.ts's HTML to a PDF buffer, or to the printer, via a BrowserWindow
// that's never visible to the user. Using Electron's own printToPDF/print (rather than a
// PDF library) keeps the export path dependency-free, matching export.ts's offline-first
// stance.

import { BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isPrintCancellation,
  isPrinterUnavailable,
  type PrintOutcome,
} from './print-result.ts';

const PAGE_WIDTH = 900;
const RENDER_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} zaman aşımına uğradı`)),
      RENDER_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// show: false windows sometimes never get a composited frame on Windows (GPU-dependent),
// which makes printToPDF hang forever waiting for one. Instead the window is genuinely
// shown — invisible via opacity 0 rather than being moved off-screen — so the compositor
// always creates a real surface. (An earlier version parked it at x/y: -32000, which broke
// printToPDF specifically: capturePage still worked from that position, but printToPDF's
// print pipeline needs a position associated with a real monitor to compute page setup and
// failed immediately. opacity: 0 stays within real display bounds, so both work.)
// backgroundThrottling is disabled so Chromium doesn't treat this as a throttled background
// tab and delay its paint pipeline; focusable: false keeps it from stealing focus.
//
// The document is written to a temp file and loadFile'd rather than passed as a
// `data:text/html` URL. It used to be a data URL, which was fine while the HTML was a
// couple of KB — but export-html.ts now embeds the wordmark as a base64 data URI, so the
// document is ~500 KB and percent-encoding it would push the URL itself toward Chromium's
// data-URL size ceiling. A file has no such limit.
async function renderWindow(html: string): Promise<{ win: BrowserWindow; cleanup: () => void }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-render-'));
  const file = path.join(dir, 'export.html');
  await fs.writeFile(file, html, 'utf8');
  const cleanup = (): void => {
    void fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };

  const win = new BrowserWindow({
    show: true,
    opacity: 0,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    width: PAGE_WIDTH,
    height: 600,
    webPreferences: { backgroundThrottling: false },
  });
  try {
    await win.loadFile(file);
  } catch (e) {
    win.destroy();
    cleanup();
    throw e;
  }
  return { win, cleanup };
}

export async function renderToPdfBuffer(html: string): Promise<Buffer> {
  const { win, cleanup } = await renderWindow(html);
  try {
    return await withTimeout(
      win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        // marginType: 'custom' + numeric top/bottom/left/right threw "margins must be less
        // than or equal to pageSize" at runtime despite the .d.ts claiming pixel units —
        // the real unit Chromium validates against didn't match. Sidestep the ambiguity
        // entirely: 'none' plus export-html.ts's own body { padding: 32px } gives the same
        // visual whitespace without engaging printToPDF's margin math at all.
        margins: { marginType: 'none' },
      }),
      'PDF oluşturma',
    );
  } finally {
    win.destroy();
    cleanup();
  }
}

// Opens the OS print dialog on the same document the PDF export produces, so what the user
// prints matches what they previewed. printToPDF is not involved: Chromium's print pipeline
// takes the live page. The window is destroyed by the print callback rather than a finally,
// because print() returns as soon as the dialog is dismissed — tearing the window down any
// earlier would cancel the job.
export async function printHtml(html: string): Promise<PrintOutcome> {
  const { win, cleanup } = await renderWindow(html);
  return new Promise((resolve, reject) => {
    // Deferred out of the callback: this fires from inside Chromium's print completion,
    // and destroying the WebContents that is still finishing that job took the whole app
    // down with it. One tick later the job is fully unwound.
    const teardown = (): void => {
      setImmediate(() => {
        if (!win.isDestroyed()) win.destroy();
        cleanup();
      });
    };

    let settled = false;
    try {
      win.webContents.print({ printBackground: true }, (success, failureReason) => {
        settled = true;
        teardown();
        // A cancelled dialog or a machine with no configured printer must not turn the
        // PDF workspace's otherwise independent actions into an application error.
        if (!success && failureReason && isPrinterUnavailable(failureReason)) {
          resolve({ printed: false, reason: 'unavailable' });
          return;
        }
        if (!success && failureReason && !isPrintCancellation(failureReason)) {
          reject(new Error(failureReason));
          return;
        }
        resolve(success ? { printed: true } : { printed: false, reason: 'cancelled' });
      });
    } catch (e) {
      // print() itself throws in some states (no printers, a job already running, and —
      // as seen here — a dismissed dialog). Cancellation and having no configured printer
      // are both expected outcomes, not failures the user needs to be told about.
      if (!settled) {
        teardown();
        const failureReason = e instanceof Error ? e.message : String(e);
        if (isPrintCancellation(failureReason)) {
          resolve({ printed: false, reason: 'cancelled' });
          return;
        }
        if (isPrinterUnavailable(failureReason)) {
          resolve({ printed: false, reason: 'unavailable' });
          return;
        }
        reject(e);
      }
    }
  });
}
