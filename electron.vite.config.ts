import { resolve } from 'node:path';
import { copyFileSync } from 'node:fs';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Non-JS assets the bundled engine reads from beside its own module at runtime.
// Rollup only emits JavaScript, so anything resolved through import.meta.url has
// to be copied next to out/main/index.js by hand or the lookup silently misses:
// pyannote-worker.py is spawned by Python, and domain-dictionary.json degrades to
// an empty dictionary on failure — which is exactly how the correction pass went
// unnoticed as a no-op inside Electron before this copy existed.
const MAIN_ASSETS: readonly [string, string][] = [
  ['engine/diarize/pyannote-worker.py', 'out/main/pyannote-worker.py'],
  ['engine/transcribe/domain-dictionary.json', 'out/main/domain-dictionary.json'],
];

function copyMainAssets() {
  return {
    name: 'copy-pyannote-worker',
    writeBundle() {
      for (const [from, to] of MAIN_ASSETS) {
        copyFileSync(resolve(__dirname, from), resolve(__dirname, to));
      }
    },
  };
}

// Main and preload build as CommonJS (root package is CJS): @huggingface/transformers
// resolves to its `require` build and native onnxruntime-node loads normally, which
// avoids Electron/Node's flaky ESM loader for native modules. The engine is imported
// by relative path so its .ts source is bundled and transpiled in.
//
// Deps are kept external so they load from real node_modules at runtime — EXCEPT
// audio-decode and marked are ESM-only (no CommonJS build) and so can't be `require`d;
// we let Rollup bundle them into the CJS main instead.
//
// electron-native-share has to be named explicitly: the plugin only reads `dependencies`,
// and this one lives under `optionalDependencies` (it is a Windows-only native addon).
// Without this Rollup would try to bundle a .node binary — and would fail outright on a
// machine where the optional install was skipped.
export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['audio-decode', 'marked'],
        // These SDKs enter through workspace dependencies, which the plugin does not
        // inspect. Bundling them turns ws's guarded optional native imports into errors.
        include: ['electron-native-share', '@anthropic-ai/sdk', '@google/genai', 'ollama', 'openai'],
      }),
      copyMainAssets(),
    ],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
