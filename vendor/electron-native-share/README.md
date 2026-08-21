# electron-native-share

[![CI](https://github.com/pprimor/electron-native-share/actions/workflows/ci.yml/badge.svg)](https://github.com/pprimor/electron-native-share/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/electron-native-share)](https://www.npmjs.com/package/electron-native-share)

Universal native Share API for Electron apps. Brings the OS share sheet to your desktop app — macOS `NSSharingServicePicker`, Windows `DataTransferManager`.

## Install

```bash
npm install electron-native-share
```

Prebuilt binaries are included for macOS and Windows. No C++ compiler required for most users.

## Usage

```typescript
import { share, canShare } from 'electron-native-share';

// Check if native sharing is available on this platform
if (canShare()) {
  console.log('Native share sheet available');
}

// Share content (from Electron main process)
const result = await share({
  title: 'Check this out',
  text: 'Hello from my Electron app!',
  url: 'https://example.com',
});

console.log(result);
// { method: 'native' }
```

### Sharing files

```typescript
await share({
  title: 'My document',
  files: ['/absolute/path/to/document.pdf'],
});
```

### With a specific BrowserWindow

Pass the Electron `BrowserWindow` instance as the second argument so the share sheet anchors to the correct window:

```typescript
import { BrowserWindow } from 'electron';
import { share } from 'electron-native-share';

const win = new BrowserWindow({ width: 800, height: 600 });

await share({ text: 'Hello!' }, win);
```

## API

### `canShare(): boolean`

Returns `true` if native sharing is available on the current platform (macOS or Windows).

### `share(options, browserWindow?): Promise<ShareResult>`

Opens the native share sheet with the given content.

**Options:**

| Property | Type       | Description                         |
| -------- | ---------- | ----------------------------------- |
| `title`  | `string?`  | Share title                         |
| `text`   | `string?`  | Text content to share               |
| `url`    | `string?`  | URL to share                        |
| `files`  | `string[]?`| Array of absolute file paths        |

At least one of `title`, `text`, `url`, or `files` must be provided.

**Returns:** `Promise<ShareResult>`

```typescript
interface ShareResult {
  method: 'native' | 'cancelled';
}
```

Throws an `Error` if native sharing is not available on the current platform. Use `canShare()` to check before calling.

### `getNativeWindowHandle(browserWindow): Buffer | undefined`

Utility to extract the native window handle from an Electron `BrowserWindow`.

## Platform Support

| Platform | Method                            | Status |
| -------- | --------------------------------- | ------ |
| macOS    | `NSSharingServicePicker`          | ✅      |
| Windows  | WinRT `DataTransferManager`       | ✅      |
| Linux    | Not supported                     | —      |

## How it works

This library provides direct access to native OS share sheets. There are no silent fallbacks — if native sharing isn't available, `share()` throws so your app can decide how to handle it (show a message, copy to clipboard, etc.).

```typescript
if (canShare()) {
  const result = await share({ text: 'Hello!' });
  // result.method is 'native' or 'cancelled'
} else {
  // Handle unsupported platform your way
  clipboard.writeText('Hello!');
  showToast('Copied to clipboard');
}
```

The `install` script uses `node-gyp-build || exit 0`, so native addon build failures are silently ignored. On unsupported platforms the addon simply won't load, and `canShare()` will return `false`.

## Building from source

If prebuilt binaries aren't available for your platform:

```bash
npm run build        # Compile TypeScript + native addon
npm run build:ts     # TypeScript only
npm run build:native # Native addon only (requires C++ toolchain)
```

### Requirements for building native addon

- **macOS**: Xcode command line tools
- **Windows**: Visual Studio with C++ Desktop workload + Windows 10 SDK

## Example Electron App

A minimal example app is included in `examples/electron-app/`:

```bash
cd examples/electron-app
npm install
npm start
```

## License

MIT
