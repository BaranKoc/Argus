// Electron main process: owns the window and runs the engine in-process. The engine
// is Node/ONNX-only and must never load in the renderer, so all engine access goes
// through the IPC handlers registered here (see ipc.ts).

// MUST stay the first import: it populates process.env from .env, and imports below
// it (the engine, transformers) are evaluated after it but before any statement here.
import './env-boot-run.ts';
import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, screen } from 'electron';
import { env } from '@huggingface/transformers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { warmUp, configureDiarization, configureLlm } from '../../engine/index.ts';
import { registerIpc } from './ipc.ts';
import { cleanupTracked } from './temp.ts';
import { SettingsStore } from './settings.ts';
import { ModelConfigStore } from './model-config.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// Developer builds use the checked-out cache. A distributable supplies the same
// directory as an Electron resource, so neither Whisper nor Pyannote is fetched by
// an end user's machine.
const MODELS_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'models')
  : path.join(app.getAppPath(), 'models');
env.cacheDir = MODELS_ROOT;

// No File/Edit/View/Window/Help — this app has no use for the default menu, only
// the OS title bar (minimize/maximize/close) stays.
Menu.setApplicationMenu(null);

// A packaged window takes its icon from the .exe, which electron-builder stamps from
// resources/icon.ico — so only the dev run has nothing to take one from, and that is the
// run that would otherwise show Electron's own logo in the title bar and taskbar.
const DEV_WINDOW_ICON = app.isPackaged
  ? undefined
  : path.join(app.getAppPath(), 'resources', 'icon.png');

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 680,
    title: 'Argus',
    icon: DEV_WINDOW_ICON,
    show: false,
    webPreferences: {
      preload: path.join(SCRIPT_DIR, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Chromium's built-in PDF viewer is gated behind `plugins`, which Electron defaults
      // to false. Without it the PDF preview <iframe> renders nothing (or downloads).
      plugins: true,
    },
  });

  // getDisplayMedia requires a video source even though the recorder only keeps its
  // audio track. Grant the primary display without a picker, but only to this app's
  // top-level frame and only for a request made from the Start button gesture.
  win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    if (
      process.platform !== 'win32' ||
      request.frame !== win.webContents.mainFrame ||
      !request.userGesture ||
      !request.audioRequested ||
      !request.videoRequested
    ) {
      callback({});
      return;
    }

    void desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const primaryId = String(screen.getPrimaryDisplay().id);
        const source = sources.find((candidate) => candidate.display_id === primaryId) ?? sources[0];
        callback(source ? { video: source, audio: 'loopback' } : {});
      })
      .catch(() => callback({}));
  });

  // Stay hidden until the renderer reports its first fully-styled frame ('ui:ready', sent
  // from renderer/main.ts on window load). Electron's own ready-to-show fires earlier —
  // at the first paint, with the stylesheet and icon font still landing — which
  // is exactly the half-drawn window we don't want anyone to see. Maximize before show, so
  // it never flashes at its restored 900x680 size; maximized rather than fullscreen on
  // purpose, since this app runs alongside an online meeting and the taskbar has to stay
  // reachable for switching windows.
  const reveal = (): void => {
    if (win.isDestroyed() || win.isVisible()) return;
    win.maximize();
    win.show();
  };
  ipcMain.once('ui:ready', reveal);
  // Safety net: a renderer that throws before signalling must not leave an app that is
  // running with no window at all.
  setTimeout(reveal, 5000);

  // electron-vite serves the renderer from a dev server in dev, and from the built
  // HTML when packaged.
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(SCRIPT_DIR, '../renderer/index.html'));
  }

  return win;
}

app.whenReady().then(() => {
  // Create the window first: registerIpc wires the live session's push events to this
  // window's webContents (they fire outside any renderer-originated handler), so it
  // needs the BrowserWindow up front.
  const userDataDir = app.getPath('userData');
  const settings = new SettingsStore(userDataDir, path.join(MODELS_ROOT, 'pyannote'));
  const modelConfig = new ModelConfigStore(userDataDir);

  configureDiarization(settings.engineConfig());
  // Unconditional, and never null: this is what makes ENGINE_LLM_* irrelevant inside the
  // app. With no saved setting it resolves to the first preset (local Ollama).
  configureLlm(modelConfig.runtimeConfig());

  const win = createWindow();
  registerIpc(win, { settings, modelConfig });

  // Preload the Whisper model so the first real transcribe isn't the call that pays
  // model-load latency (architecture doc §2). Fire-and-forget; errors surface later
  // on the actual transcribe call with an actionable message.
  warmUp().catch((e) => console.error('warmUp failed:', e));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Why these exist: the app was closing on its own and a clean exit code told us nothing
// about which of the many ways out of an Electron process had been taken. Each hook names
// one, so the terminal says what happened instead of the window just vanishing. They are
// silent in normal operation — quitting by closing the window is the only one that fires.
app.on('window-all-closed', () => {
  console.log('[lifecycle] window-all-closed — çıkılıyor');
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => console.log('[lifecycle] before-quit'));
app.on('will-quit', () => console.log('[lifecycle] will-quit'));
app.on('render-process-gone', (_event, _contents, details) => {
  console.error('[lifecycle] render-process-gone:', details.reason, details.exitCode);
});
app.on('child-process-gone', (_event, details) => {
  console.error('[lifecycle] child-process-gone:', details.type, details.reason);
});
// Without these an async failure anywhere in the main process can tear the process down
// before it prints anything useful.
process.on('uncaughtException', (e) => console.error('[lifecycle] uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('[lifecycle] unhandledRejection:', e));

// Best-effort remove any temp audio the user never explicitly deleted.
app.on('before-quit', () => {
  void cleanupTracked();
});
