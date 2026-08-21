// Electron wraps a rejected ipcMain.handle in its own Error whose message is
//
//   Error invoking remote method 'modelConfig:set': Error: Bu sağlayıcı için bir model…
//
// The channel name and the doubled "Error:" are implementation detail leaking into a
// sentence a person is meant to read. Everything after the last "Error: " is the message
// main actually wrote, so that is what gets shown.

const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*/;
const ERROR_LABEL = /^(?:[A-Za-z]*Error):\s*/;

export function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  let message = raw.replace(IPC_PREFIX, '');
  // Repeated because the wrapper can nest one more level when a handler rethrows.
  while (ERROR_LABEL.test(message)) message = message.replace(ERROR_LABEL, '');
  return message.trim() || raw;
}
