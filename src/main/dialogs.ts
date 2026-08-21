// Native confirm/alert dialogs for the renderer. The renderer must never call
// window.confirm/window.alert directly: Chromium's synchronous in-page native dialogs
// leave the BrowserWindow's focus state corrupted afterward, so a subsequent
// element.focus() (e.g. the rename input) silently no-ops until the app is reloaded.
// Routing through Electron's dialog module avoids that corruption.

import { BrowserWindow, dialog } from 'electron';

export async function confirmDialog(win: BrowserWindow, message: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['İptal', 'Devam Et'],
    defaultId: 0,
    cancelId: 0,
    message,
  });
  return response === 1;
}

export async function infoDialog(win: BrowserWindow, message: string): Promise<void> {
  await dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['Tamam'],
    message,
  });
}

export async function alertDialog(win: BrowserWindow, message: string): Promise<void> {
  await dialog.showMessageBox(win, {
    type: 'error',
    buttons: ['Tamam'],
    message,
  });
}
