// IPC handlers + the live-session bridge: the renderer's only path to the engine and
// temp storage. Request/response channels forward renderer calls into the engine;
// push channels forward liveSession events back to the renderer. Engine errors on
// request channels reject in the renderer (architecture doc §5.1); session errors
// arrive as the live:error push event.
//
// registerIpc takes the BrowserWindow explicitly because the session's pushes are
// NOT triggered from within a renderer-originated handler — they fire whenever a
// chunk-queue round completes or finalize progresses, so we need a webContents to
// send to that isn't tied to an incoming event.sender.

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import {
  liveSession,
  getLiveConfig,
  configureDiarization,
  configureLlm,
  type Analysis,
} from '../../engine/index.ts';
import type { SourceEnvelope } from '../../engine/live/source-envelope.ts';
import { installGpuAddon } from './gpu-addon.ts';
import { parseMeetingLanguage } from './meeting-language.ts';
import { parseMeetingScope } from './meeting-scope.ts';
import { type SettingsStore } from './settings.ts';
import { type ModelConfigPatch, type ModelConfigStore } from './model-config.ts';
import { RecordingGuard } from './authorization.ts';
import { resolveExternalLink } from '../shared/external-links.ts';
import { removeAudio } from '../../utility/file-control.ts';
import {
  renameMeetingPair,
  revertMeetingEdit,
  saveEditedAnalysis,
  saveSpeakerNames,
} from '../../utility/meeting-edits.ts';
import type { SpeakerNameMap } from '../../utility/speaker-names.ts';
import { stamp } from '../../utility/meeting-id.ts';
import { MeetingReanalysisCoordinator } from './meeting-reanalysis.ts';
import { saveRecording, untrack } from './temp.ts';
import {
  saveMeeting,
  listMeetings,
  readMeeting,
  deleteMeeting,
  meetingsDir,
} from './meetings.ts';
import {
  exportMeeting,
  printMeeting,
  renderMeetingPdf,
  sharePdf,
  type ExportFormat,
} from './export.ts';
import { confirmDialog, alertDialog, infoDialog } from './dialogs.ts';

// apiKey keeps its three-way meaning across the boundary: absent = keep the stored key,
// null = clear it, string = replace it. Everything else is optional and must be its
// declared type if present — an unknown field is dropped rather than persisted.
function parseModelConfigPatch(payload: unknown): ModelConfigPatch {
  if (typeof payload !== 'object' || payload === null) throw new Error('Geçersiz analiz modeli ayarı.');
  const raw = payload as Record<string, unknown>;
  const patch: ModelConfigPatch = {};
  const optionalString = (key: 'presetId' | 'model' | 'host'): void => {
    if (raw[key] === undefined) return;
    if (typeof raw[key] !== 'string') throw new Error('Geçersiz analiz modeli ayarı.');
    patch[key] = raw[key];
  };
  optionalString('presetId');
  optionalString('model');
  optionalString('host');
  if (raw.apiKey !== undefined) {
    if (raw.apiKey !== null && typeof raw.apiKey !== 'string') {
      throw new Error('Geçersiz analiz modeli ayarı.');
    }
    patch.apiKey = raw.apiKey;
  }
  return patch;
}

// Attribution is a nice-to-have on top of the transcript, so a malformed envelope is
// dropped rather than allowed to fail the chunk that carries the actual audio.
function parseSourceEnvelope(payload: unknown): SourceEnvelope | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { mic, system } = payload as Record<string, unknown>;
  if (!(mic instanceof Float32Array) || !(system instanceof Float32Array)) return undefined;
  return { mic, system };
}

export interface IpcServices {
  settings: SettingsStore;
  modelConfig: ModelConfigStore;
}

export function registerIpc(win: BrowserWindow, services: IpcServices): void {
  const { settings, modelConfig } = services;
  const recording = new RecordingGuard();
  const send = (channel: string, payload?: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // The temp path for the recording currently being finalized; set on live:stop,
  // consumed once by whichever terminal session event arrives for KVKK deletion.
  let currentAudioPath: string | null = null;
  const meetingReanalysis = new MeetingReanalysisCoordinator();

  // KVKK deletion, shared by all three terminal events. A meeting that ended in an
  // error or was cancelled has exactly as little claim to its audio as one that
  // succeeded — leaving it on disk would also hand the stale path to the NEXT
  // meeting's terminal handler.
  const discardCurrentAudio = async (): Promise<void> => {
    if (!currentAudioPath) return;
    await removeAudio(currentAudioPath);
    untrack(currentAudioPath);
    currentAudioPath = null;
  };

  // --- Request/response ----------------------------------------------------

  // Persist renderer-encoded WAV bytes to temp, return the path.
  ipcMain.handle('audio:saveRecording', (_event, bytes: ArrayBuffer): Promise<string> => {
    recording.requireActive();
    return saveRecording(bytes);
  });

  ipcMain.handle('live:start', (_event, options: unknown): void => {
    // Narrowed here, not defaulted: an unrecognised value means the renderer and main
    // disagree about the contract, and silently recording a foreign meeting with the
    // Turkish model would produce a transcript that looks broken for no visible reason.
    // Validated INSIDE the callback because RecordingGuard only marks a recording
    // active after start() returns — throwing here mints no permission.
    recording.start(() => {
      const meetingLanguage = parseMeetingLanguage(options);
      const meetingScope = parseMeetingScope(options);
      // A two-party declaration overrides the account's setting FOR THIS RECORDING ONLY —
      // settings.setEnabled is deliberately not called, so the next meeting starts from
      // the user's own preference again. With two sides there is nothing for the diarizer
      // to separate that the local/remote labels do not already separate, and running it
      // anyway costs minutes and risks splitting one side into invented speakers.
      const twoParty = meetingScope === 'two-party';
      const diarization = settings.engineConfig();
      configureDiarization({
        ...diarization,
        enabled: !twoParty && diarization.enabled,
      });
      liveSession.start({
        includeSpeakersInAnalysis: settings.get().analysis.includeSpeakers,
        meetingLanguage,
        meetingScope,
      });
    });
  });

  // PCM arrives as a Float32Array (structured-clone over IPC). The renderer awaits
  // this so its final Stop flush is guaranteed delivered before live:stop.
  ipcMain.handle('live:pushChunk', (_event, pcm: Float32Array, envelope: unknown): void => {
    recording.requireActive();
    liveSession.pushChunk(pcm, parseSourceEnvelope(envelope));
  });

  ipcMain.handle('live:pause', (): void => {
    recording.requireActive();
    liveSession.pause();
  });

  ipcMain.handle('live:resume', (): void => {
    recording.requireActive();
    liveSession.resume();
  });

  // Acknowledge immediately; the real result comes via the live:result push after
  // the queue drains and finalize runs. A null path is the degraded (WAV-save-failed)
  // path. Remember the path so the 'result' handler below can delete it.
  ipcMain.handle('live:stop', (_event, audioPath: string | null): void => {
    recording.requireActive();
    currentAudioPath = audioPath;
    void liveSession.stop(audioPath);
  });

  // Discard the meeting being finalized. Like live:stop this only starts the work —
  // the session decides when the pipeline has actually unwound and announces it with
  // its 'cancelled' event, which is where the cleanup below happens. Cancelling
  // outside finalizing/analyzing is a no-op in the session, so a click racing the
  // pipeline's own completion cannot strand the recording guard.
  ipcMain.handle('live:cancel', (): void => {
    recording.requireActive();
    liveSession.cancel();
  });

  // Single source of truth for the renderer's emit cadence, so the chunk length isn't
  // duplicated as a drifting constant on the renderer side.
  ipcMain.handle('live:getConfig', (): { chunkSeconds: number } => {
    return { chunkSeconds: getLiveConfig().chunkSeconds };
  });

  // --- Settings -----------------------------------------------------------
  ipcMain.handle('settings:get', () => ({ settings: settings.get(), status: settings.status() }));
  ipcMain.handle('settings:setDiarizationEnabled', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Geçersiz diarization ayarı.');
    const next = settings.setEnabled(enabled);
    configureDiarization(settings.engineConfig());
    return { settings: next, status: settings.status() };
  });
  // The CUDA runtime is 4.6 GB and cannot ship in the installer, so the user applies it
  // here from the archive that came alongside it. Guarded like the other diarization
  // settings — it is the same feature, just its prerequisite.
  ipcMain.handle('settings:installGpuAddon', async () => {
    // Checked here rather than by hiding the button: the renderer's copy of the status
    // can be stale, and re-extracting 4.6 GB over a working runtime is a slow way to
    // achieve nothing. Says so and stops instead of opening a file picker.
    if (settings.status().reason !== 'no-runtime') {
      await infoDialog(win, 'GPU desteği zaten kurulu.');
      return { installed: false, settings: settings.get(), status: settings.status() };
    }
    const picked = await dialog.showOpenDialog(win, {
      title: 'GPU desteği arşivini seçin',
      properties: ['openFile'],
      filters: [{ name: 'GPU eklentisi', extensions: ['7z'] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { installed: false, settings: settings.get(), status: settings.status() };
    }

    await installGpuAddon({
      // Packaged next to the models root; in development it comes from node_modules.
      sevenZip: app.isPackaged
        ? path.join(process.resourcesPath, '7za.exe')
        : path.join(app.getAppPath(), 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
      archivePath: picked.filePaths[0],
      pyannoteDir: settings.pyannoteRoot(),
      onProgress: (progress) => send('settings:gpuAddonProgress', progress),
    });

    // Re-read: status() probes the filesystem, so the runtime that just landed is picked
    // up without a restart, and the engine is told about it immediately.
    configureDiarization(settings.engineConfig());
    return { installed: true, settings: settings.get(), status: settings.status() };
  });

  // Unguarded on purpose, unlike its neighbours: it opens one of a fixed list of public
  // pages (shared/external-links.ts), carries no user data and changes nothing. A
  // capability check here would only be protecting a URL anyone can type.
  ipcMain.handle('shell:openExternal', async (_event, id: unknown) => {
    await shell.openExternal(resolveExternalLink(id));
  });

  ipcMain.handle('settings:setAnalysisIncludeSpeakers', (_event, includeSpeakers: unknown) => {
    if (typeof includeSpeakers !== 'boolean') throw new Error('Geçersiz analiz ayarı.');
    const next = settings.setIncludeSpeakers(includeSpeakers);
    return { settings: next, status: settings.status() };
  });
  // --- Analysis model -----------------------------------------------------
  ipcMain.handle('modelConfig:get', () => modelConfig.get());
  ipcMain.handle('modelConfig:set', (_event, patch: unknown) => {
    const next = modelConfig.set(parseModelConfigPatch(patch));
    // Push it into the engine immediately — the analyzer resolves its config per call,
    // so this takes effect on the very next analysis without an app restart.
    configureLlm(modelConfig.runtimeConfig());
    return next;
  });
  // --- Dashboard ----------------------------------------------------------

  ipcMain.handle('meetings:list', () => {
    return listMeetings();
  });
  ipcMain.handle('meetings:read', (_event, id: string) => {
    return readMeeting(id);
  });
  // Export prompts with a native save dialog parented to this window. Logged here (not
  // just rejected to the renderer) so the underlying error is visible in this terminal
  // without needing DevTools.
  ipcMain.handle('meetings:export', async (_event, id: string, format: ExportFormat) => {
    try {
      return await exportMeeting(win, id, format);
    } catch (e) {
      console.error(`Dışa aktarma başarısız (format: ${format}):`, e);
      throw e;
    }
  });
  // Preview/print/share all re-render from the saved meeting rather than caching the last
  // PDF: an edit between opening the preview and hitting print must not print stale bytes.
  ipcMain.handle('meetings:renderPdf', async (_event, id: string) => {
    try {
      return await renderMeetingPdf(id);
    } catch (e) {
      console.error('PDF önizleme oluşturulamadı:', e);
      throw e;
    }
  });
  ipcMain.handle('meetings:print', async (_event, id: string) => {
    try {
      return await printMeeting(id);
    } catch (e) {
      console.error('Yazdırma başarısız:', e);
      throw e;
    }
  });
  // win, not the sender: the share sheet needs the HWND of the window it should hang off,
  // and it only appears when that window is the foreground one.
  ipcMain.handle('meetings:sharePdf', async (_event, id: string) => {
    try {
      return await sharePdf(win, id);
    } catch (e) {
      console.error('Paylaşma başarısız:', e);
      throw e;
    }
  });
  ipcMain.handle('meetings:delete', (_event, id: string) => {
    return deleteMeeting(id);
  });
  ipcMain.handle('meetings:saveEdit', (_event, openId: string, analysis: Analysis) => {
    return saveEditedAnalysis(meetingsDir(), openId, analysis, stamp());
  });
  // Validated here rather than trusted: the mapping is written straight into the stored
  // transcript, so a stray non-string value would corrupt the record on disk.
  ipcMain.handle('meetings:saveSpeakerNames', (_event, openId: string, mapping: unknown) => {
    if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) {
      throw new Error('Geçersiz konuşmacı ad eşlemesi.');
    }
    const entries = Object.entries(mapping as Record<string, unknown>);
    if (entries.some(([label, name]) => !label || typeof name !== 'string' || !name.trim())) {
      throw new Error('Geçersiz konuşmacı ad eşlemesi.');
    }
    return saveSpeakerNames(meetingsDir(), openId, mapping as SpeakerNameMap, stamp());
  });
  ipcMain.handle('meetings:rename', (_event, id: string, newName: string) => {
    return renameMeetingPair(meetingsDir(), id, newName);
  });
  ipcMain.handle('meetings:revertEdit', (_event, id: string) => {
    return revertMeetingEdit(meetingsDir(), id);
  });
  ipcMain.handle('meetings:reanalyze', (_event, id: string, options: unknown) => {
    const includeSpeakers = (options as { includeSpeakers?: unknown } | null)?.includeSpeakers;
    if (typeof includeSpeakers !== 'boolean') throw new Error('Geçersiz yeniden analiz ayarı.');
    return meetingReanalysis.run(meetingsDir(), id, { includeSpeakers });
  });
  // Native dialogs, parented to this window so the renderer never calls
  // window.confirm/window.alert directly (see dialogs.ts).
  ipcMain.handle('dialog:confirmDelete', (_event, message: string) => confirmDialog(win, message));
  ipcMain.handle('dialog:alert', (_event, message: string) => alertDialog(win, message));

  // --- Session pushes ------------------------------------------------------

  liveSession.on('status', (payload) => send('live:status', payload));
  liveSession.on('segments', (payload) => send('live:segments', payload));
  liveSession.on('error', async (payload) => {
    recording.finish();
    await discardCurrentAudio();
    send('live:error', payload);
  });

  // Nothing is saved here, deliberately: saveMeeting is called from the 'result'
  // handler alone, so a cancelled meeting simply never reaches disk.
  liveSession.on('cancelled', async () => {
    recording.finish();
    await discardCurrentAudio();
    send('live:cancelled');
  });

  // KVKK ordering: the temp audio must be gone BEFORE the UI can claim it was
  // auto-deleted. Delete first, then forward the result — this is app policy
  // (deletion), deliberately kept out of engine/live/ (removeAudio's own doc).
  liveSession.on('result', async (payload) => {
    recording.finish();
    await discardCurrentAudio();
    // Persist the derived transcript + analysis (never the audio, already deleted above).
    // Best-effort: a disk error here must not swallow the result the renderer is waiting for.
    // The saved id is forwarded so the renderer's "Sonuçları Gör" can open this exact
    // meeting's detail; null when the save failed (renderer then just shows "Tamamlandı").
    let meetingId: string | null = null;
    try {
      meetingId = await saveMeeting(payload);
    } catch (e) {
      console.error('Toplantı kaydedilemedi:', e);
    }
    send('live:result', { ...payload, meetingId });
  });
}
