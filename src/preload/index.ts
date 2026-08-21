// Preload: the only surface the renderer sees. contextBridge exposes a small, typed
// window.api that forwards to the IPC handlers in the main process. No Node, no
// engine, no fs is reachable from the renderer directly.
//
// Request/response methods invoke and return a promise. Push events (the live
// session's status/segments/result/error) each get their own narrow on* subscriber
// rather than a generic passthrough — this codebase has no prior ipcRenderer.on usage,
// so keeping the surface explicit matches the existing narrow window.api style. Each
// subscriber returns an unsubscribe function.

import { contextBridge, ipcRenderer } from 'electron';
import type { Analysis, Segment } from '../../engine/index.ts';
import type { SourceEnvelope } from '../../engine/live/source-envelope.ts';
// Type-only: erased at build, so the main-process electron.app inside meetings.ts never
// enters the preload bundle — we only borrow the shapes for a typed window.api.
import type { MeetingSummary, MeetingDetail } from '../main/meetings.ts';
import type { ExportResult, ExportFormat, ShareOutcome } from '../main/export.ts';
import type { PrintOutcome } from '../main/print-result.ts';
import type { SpeakerNameMap } from '../../utility/speaker-names.ts';
import type { ExternalLinkId } from '../shared/external-links.ts';

// Event payloads, mirrored from engine/live/session.ts (kept as plain shapes here so
// the preload doesn't need the session's type machinery).
export interface LiveStatus {
  state: 'idle' | 'recording' | 'paused' | 'finalizing' | 'analyzing' | 'done' | 'error';
  detail?: string;
}
export interface LiveSegments {
  segments: Segment[];
}
export interface LiveResult {
  segments: Segment[];
  // Absent when the analysis step failed — the meeting still counts as a result
  // because the transcript was saved; analysisError says why, and the Dashboard's
  // "Yeniden Analiz Et" is the fix.
  analysis?: Analysis;
  analysisError?: string;
  speakersDegraded?: boolean;
  // Folder id of the just-saved meeting, so "Sonuçları Gör" can open its detail. Null
  // when the disk save failed (see ipc.ts) — the record view then just shows "Tamamlandı".
  meetingId: string | null;
}
export interface LiveError {
  message: string;
  phase: 'finalizing' | 'analyzing';
}
export interface AppSettings {
  diarization: { enabled: boolean; provider: 'pyannote-community-1' };
  analysis?: { includeSpeakers: boolean };
}

// Analysis-model settings. Redacted by design: the store keeps the API key
// and the renderer only ever learns that one exists plus its last four characters
// (see main/model-config.ts). Mirrored here as a plain shape so the preload doesn't drag
// the main process's fs code into its bundle.
export interface ModelConfigView {
  source: 'local' | 'remote';
  presetId: string;
  model: string;
  host: string;
  hasApiKey: boolean;
  apiKeyHint: string;
  path: string;
  readOnlyReason: string;
}
export interface ModelConfigPatch {
  presetId?: string;
  model?: string;
  host?: string;
  // undefined keeps the stored key, null clears it, a string replaces it.
  apiKey?: string | null;
}

// What language the meeting will be held in, chosen on the recording screen before it
// starts. Per-meeting and never persisted, so it rides the start call instead of being
// read from settings in main — the same shape meetings:reanalyze already uses.
// 'foreign' still produces a Turkish transcript; it only switches to the Whisper model
// that survives decoding non-Turkish audio into Turkish.
export type MeetingLanguage = 'turkish' | 'foreign';
// How many parties are in the meeting, declared on the same screen and equally per-meeting.
// 'two-party' turns speaker separation off for that recording alone — with two sides the
// local/remote labels already say who spoke — and lets them stand in as the speakers all
// the way into the analysis.
export type MeetingScope = 'group' | 'two-party';
export interface LiveStartOptions {
  meetingLanguage: MeetingLanguage;
  meetingScope: MeetingScope;
}
// reason distinguishes a Light installer (speaker separation deliberately absent) from a
// damaged one, so the settings view can point at the Full installer instead of blaming
// the user's install. Mirrors main/settings.ts.
export interface PyannoteStatus {
  ready: boolean;
  message: string;
  reason?: 'no-runtime' | 'no-model';
}
export interface SettingsResponse { settings: AppSettings; status: PyannoteStatus; }

// installed:false means the user closed the file picker — not an error, just nothing to
// report. Progress arrives on its own channel because a 4.6 GB extraction takes minutes.
export interface GpuAddonResponse extends SettingsResponse { installed: boolean; }
export interface GpuAddonProgress { percent: number; }

// Wrap ipcRenderer.on so the renderer never touches the event object, and hand back
// an unsubscribe so listeners can be torn down.
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  // Save recorded WAV bytes to temp; returns the temp path.
  saveRecording: (bytes: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke('audio:saveRecording', bytes),

  // The engine's chunk cadence, so the recorder emits at the same size the engine expects.
  getLiveConfig: (): Promise<{ chunkSeconds: number }> => ipcRenderer.invoke('live:getConfig'),

  // --- Live session controls ---
  liveStart: (options: LiveStartOptions): Promise<void> => ipcRenderer.invoke('live:start', options),
  // Must be awaited by the renderer so the final Stop flush lands before liveStop.
  // The envelope rides along with the audio it was measured from, so the engine never
  // has to reconcile two separately-timed streams.
  livePushChunk: (pcm: Float32Array, envelope: SourceEnvelope): Promise<void> =>
    ipcRenderer.invoke('live:pushChunk', pcm, envelope),
  livePause: (): Promise<void> => ipcRenderer.invoke('live:pause'),
  liveResume: (): Promise<void> => ipcRenderer.invoke('live:resume'),
  // null triggers the degraded (WAV-save-failed) path.
  liveStop: (audioPath: string | null): Promise<void> => ipcRenderer.invoke('live:stop', audioPath),
  // Discard the meeting currently being finalized. Resolving means the cancel was
  // requested, not that it finished — that is the live:cancelled event.
  liveCancel: (): Promise<void> => ipcRenderer.invoke('live:cancel'),

  // Sent once, when the first fully-styled frame has painted. The window stays hidden
  // until this arrives, so the app is never seen mid-assembly (see main/index.ts).
  notifyUiReady: (): void => ipcRenderer.send('ui:ready'),

  // --- Settings -----------------------------------------------------------
  getSettings: (): Promise<SettingsResponse> => ipcRenderer.invoke('settings:get'),
  setDiarizationEnabled: (enabled: boolean): Promise<SettingsResponse> =>
    ipcRenderer.invoke('settings:setDiarizationEnabled', enabled),
  installGpuAddon: (): Promise<GpuAddonResponse> => ipcRenderer.invoke('settings:installGpuAddon'),
  onGpuAddonProgress: (cb: (p: GpuAddonProgress) => void): (() => void) =>
    subscribe('settings:gpuAddonProgress', cb),
  setAnalysisIncludeSpeakers: (includeSpeakers: boolean): Promise<SettingsResponse> =>
    ipcRenderer.invoke('settings:setAnalysisIncludeSpeakers', includeSpeakers),
  // An id from a fixed list, never a URL — see shared/external-links.ts.
  openExternal: (id: ExternalLinkId): Promise<void> =>
    ipcRenderer.invoke('shell:openExternal', id),

  // --- Analysis model -----------------------------------------------------
  getModelConfig: (): Promise<ModelConfigView> => ipcRenderer.invoke('modelConfig:get'),
  // Partial on purpose: the renderer sends only what the user touched, so an untouched
  // API key stays untouched instead of being round-tripped through a process that
  // must not hold it.
  setModelConfig: (patch: ModelConfigPatch): Promise<ModelConfigView> =>
    ipcRenderer.invoke('modelConfig:set', patch),

  // --- Live session events (each returns an unsubscribe) ---
  onLiveStatus: (cb: (e: LiveStatus) => void): (() => void) => subscribe('live:status', cb),
  onLiveSegments: (cb: (e: LiveSegments) => void): (() => void) => subscribe('live:segments', cb),
  onLiveResult: (cb: (e: LiveResult) => void): (() => void) => subscribe('live:result', cb),
  onLiveError: (cb: (e: LiveError) => void): (() => void) => subscribe('live:error', cb),
  // Payload-less: a cancelled meeting has no result to report.
  onLiveCancelled: (cb: () => void): (() => void) => subscribe('live:cancelled', cb),

  // --- Dashboard ---
  listMeetings: (): Promise<MeetingSummary[]> => ipcRenderer.invoke('meetings:list'),
  readMeeting: (id: string): Promise<MeetingDetail> => ipcRenderer.invoke('meetings:read', id),
  exportMeeting: (id: string, format: ExportFormat): Promise<ExportResult> =>
    ipcRenderer.invoke('meetings:export', id, format),
  // --- PDF preview (İndir / Paylaş / Yazdır live in the preview modal) ---
  // Raw PDF bytes for the in-app viewer; the renderer wraps them in a blob: URL.
  renderMeetingPdf: (id: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('meetings:renderPdf', id),
  printMeeting: (id: string): Promise<PrintOutcome> =>
    ipcRenderer.invoke('meetings:print', id),
  // "Paylaş" — the OS share sheet with the PDF attached (Windows/macOS), or, where there
  // is none, the file revealed in the file browser. 'cancelled' means the user dismissed
  // the sheet: a completed interaction, not a failure.
  sharePdf: (id: string): Promise<ShareOutcome> => ipcRenderer.invoke('meetings:sharePdf', id),
  deleteMeeting: (id: string): Promise<void> => ipcRenderer.invoke('meetings:delete', id),
  saveMeetingEdit: (openId: string, analysis: Analysis): Promise<string> =>
    ipcRenderer.invoke('meetings:saveEdit', openId, analysis),
  // Diarization labels -> real names. Goes through the same edited-copy path as
  // saveMeetingEdit, so revertMeetingEdit undoes a naming as well.
  saveMeetingSpeakerNames: (openId: string, mapping: SpeakerNameMap): Promise<string> =>
    ipcRenderer.invoke('meetings:saveSpeakerNames', openId, mapping),
  renameMeeting: (id: string, newName: string): Promise<void> =>
    ipcRenderer.invoke('meetings:rename', id, newName),
  revertMeetingEdit: (id: string): Promise<string> =>
    ipcRenderer.invoke('meetings:revertEdit', id),
  reanalyzeMeeting: (id: string, options: { includeSpeakers: boolean }): Promise<string> =>
    ipcRenderer.invoke('meetings:reanalyze', id, options),
  // --- Native dialogs (never window.confirm/window.alert — see main/dialogs.ts) ---
  confirmDelete: (message: string): Promise<boolean> =>
    ipcRenderer.invoke('dialog:confirmDelete', message),
  showAlert: (message: string): Promise<void> => ipcRenderer.invoke('dialog:alert', message),
};

export type Api = typeof api;

contextBridge.exposeInMainWorld('api', api);
