// Per-user settings. Pyannote assets are provisioned by the developer into the
// app bundle; this process never receives a Hugging Face token.
//
// Everything here is scoped to one Windows account. Analysis-provider secrets live in a
// separate model-config.json so the two settings shapes cannot quietly become one another.

import fs from 'node:fs';
import path from 'node:path';
import { PYANNOTE_MODEL_VERSION, PYANNOTE_PROVIDER, type DiarizationConfig } from '../../engine/diarization-config.ts';

export interface AppSettings {
  diarization: { enabled: boolean; provider: typeof PYANNOTE_PROVIDER };
  analysis: { includeSpeakers: boolean };
}

// 'no-runtime' is the ordinary state of a Light installer, not a broken install. The
// renderer needs to tell the two apart to say "get the Full installer" instead of
// "your package is damaged", and a boolean cannot carry that.
export type PyannoteUnavailableReason = 'no-runtime' | 'no-model';

export interface PyannoteStatus {
  ready: boolean;
  message: string;
  reason?: PyannoteUnavailableReason;
}

const DEFAULT_SETTINGS: AppSettings = {
  diarization: { enabled: false, provider: PYANNOTE_PROVIDER },
  analysis: { includeSpeakers: false },
};

export class SettingsStore {
  private readonly settingsPath: string;
  private readonly runtimeDir: string;
  private readonly pyannoteDir: string;
  private readonly modelDir: string;
  private readonly userDataDir: string;
  private settings: AppSettings;

  constructor(userDataDir: string, pyannoteDir = path.join(userDataDir, 'pyannote')) {
    this.userDataDir = userDataDir;
    this.pyannoteDir = pyannoteDir;
    this.settingsPath = path.join(userDataDir, 'settings.json');
    this.runtimeDir = path.join(pyannoteDir, 'runtime');
    this.modelDir = path.join(pyannoteDir, PYANNOTE_MODEL_VERSION);
    this.settings = this.read();
  }

  // An `llm` block written by an intermediate build is ignored rather than migrated: the
  // current model-config store validates provider settings before persisting them.
  private read(): AppSettings {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      const enabled = typeof (parsed as AppSettings)?.diarization?.enabled === 'boolean'
        ? (parsed as AppSettings).diarization.enabled : false;
      const storedIncludeSpeakers = (parsed as AppSettings)?.analysis?.includeSpeakers;
      const includeSpeakers = enabled && (
        typeof storedIncludeSpeakers === 'boolean' ? storedIncludeSpeakers : true
      );
      return {
        diarization: { enabled, provider: PYANNOTE_PROVIDER },
        analysis: { includeSpeakers },
      };
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  private persist(): void {
    fs.mkdirSync(this.userDataDir, { recursive: true });
    const tempPath = `${this.settingsPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.settingsPath);
  }

  // Two layouts are legitimate and both must resolve. The distributable ships a
  // relocatable CPython whose interpreter sits at the runtime root — a venv can't be
  // shipped, since its pyvenv.cfg hard-codes the absolute path of the base install
  // that created it and no end user has that. A developer's `download-pyannote`
  // venv, on the other hand, puts it under Scripts/.
  private runtimePython(): string | null {
    const relative = process.platform === 'win32'
      ? ['python.exe', 'Scripts/python.exe']
      : ['bin/python'];
    for (const rel of relative) {
      const candidate = path.join(this.runtimeDir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  get(): AppSettings { return structuredClone(this.settings); }

  // Where the GPU add-on unpacks to. Exposed rather than recomputed in ipc.ts so the
  // extraction target and the readiness probe can never point at different folders.
  pyannoteRoot(): string { return this.pyannoteDir; }

  status(): PyannoteStatus {
    if (!this.runtimePython()) {
      return {
        ready: false,
        reason: 'no-runtime',
        message: 'GPU desteği henüz kurulmadı.',
      };
    }
    if (!fs.existsSync(path.join(this.modelDir, 'config.yaml'))) {
      return { ready: false, reason: 'no-model', message: 'Pyannote modeli bu pakete eklenmemiş.' };
    }
    return { ready: true, message: 'Pyannote yerel olarak kullanıma hazır.' };
  }

  engineConfig(): DiarizationConfig {
    const status = this.status();
    return {
      enabled: this.settings.diarization.enabled && status.ready,
      provider: PYANNOTE_PROVIDER,
      pythonPath: this.runtimePython(),
      modelDir: this.modelDir,
      modelVersion: PYANNOTE_MODEL_VERSION,
    };
  }

  setEnabled(enabled: boolean): AppSettings {
    if (enabled && !this.status().ready) {
      throw new Error('Pyannote etkinleştirilmeden önce uygulama paketine eklenmelidir.');
    }
    this.settings = {
      diarization: { enabled, provider: PYANNOTE_PROVIDER },
      analysis: { includeSpeakers: enabled },
    };
    this.persist();
    return this.get();
  }

  setIncludeSpeakers(includeSpeakers: boolean): AppSettings {
    if (includeSpeakers && (!this.settings.diarization.enabled || !this.status().ready)) {
      throw new Error('Konuşmacılar analize yalnızca konuşmacı ayrımı etkinken dahil edilebilir.');
    }
    this.settings = {
      ...this.settings,
      analysis: { includeSpeakers },
    };
    this.persist();
    return this.get();
  }
}
