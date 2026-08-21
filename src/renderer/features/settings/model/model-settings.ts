// View model for the Analiz Modeli settings tab. Pure — no DOM, no window.api — so
// the rules that decide what the user sees (which preset is selected, whether a key is
// still needed, what the status line says) are unit-testable without an Electron window.
//
// The preset table comes from engine/analyze/llm/catalog.ts, the same module
// main/model-config.ts validates against. It is a deliberate leaf with no Transformers
// import, which is what makes importing engine code from the renderer safe here
// (features/dashboard/analysis-sections.ts does the same).
//
// There is no "use this selection" switch: .env no longer competes with this screen, so
// whatever is saved here IS what runs. See engine/models.ts for the tier order.

import {
  DEFAULT_PRESET_ID,
  LLM_PRESETS,
  presetOrDefault,
  presetRequiresKey,
  type LlmPreset,
} from '../../../../../engine/analyze/llm/catalog.ts';
import type { ModelConfigView } from '../../../../preload/index.ts';

export { LLM_PRESETS, type LlmPreset };

// Three states rather than a boolean because "this provider needs none" and "one is
// stored" are both fine, but they are different things to tell the user.
export type KeyState = 'not-needed' | 'stored' | 'missing';

// What the user has selected and typed but not saved yet.
//
// Choosing a preset is a statement of intent, not a finished configuration: a cloud card is
// invalid the instant it is picked (no key yet), so the screen has to be able to show that
// state instead of refusing it. The draft is what makes that possible — the store still
// validates, but it only ever sees a complete config.
//
// The key itself is deliberately NOT here: this layer stays free of secrets, and "is it
// usable" only needs to know whether one was typed.
export interface ModelDraft {
  presetId: string;
  model: string;
  host: string;
  apiKeyEntered: boolean;
}

export function draftFromConfig(config: ModelConfigView | undefined): ModelDraft {
  const view = config ?? DEFAULT_VIEW;
  const preset = presetOrDefault(view.presetId);
  return {
    presetId: preset.id,
    model: view.model.trim() || preset.defaultModel,
    host: view.host.trim(),
    apiKeyEntered: false,
  };
}

// Switching presets starts the model from the new preset's default and drops the previous
// preset's host — the store applies the same rule on save (an OpenAI key must never be
// carried to Gemini), so the form must not show something the save would discard.
export function draftForPreset(presetId: string): ModelDraft {
  const preset = presetOrDefault(presetId);
  return { presetId: preset.id, model: preset.defaultModel, host: '', apiKeyEntered: false };
}

export interface ModelSelection {
  preset: LlmPreset;
  // What would actually run: the user's model if they typed one, else the preset's.
  model: string;
  host: string;
  showHost: boolean;
  keyState: KeyState;
  apiKeyHint: string;
  // False when saving would be rejected by the store, so the screen can say what is
  // missing instead of letting the user discover it through a failed save.
  usable: boolean;
}

const DEFAULT_VIEW: ModelConfigView = {
  source: 'local',
  presetId: DEFAULT_PRESET_ID,
  model: '',
  host: '',
  hasApiKey: false,
  apiKeyHint: '',
  path: '',
  readOnlyReason: '',
};

// With no draft this describes what is SAVED (the home screen and the initial render);
// with one it describes what the user is currently looking at. Same function either way,
// so the two can never disagree about what "usable" means.
export function resolveModelSelection(
  config: ModelConfigView | undefined,
  draft?: ModelDraft,
): ModelSelection {
  const view = config ?? DEFAULT_VIEW;
  const preset = presetOrDefault(draft ? draft.presetId : view.presetId);
  const model = (draft ? draft.model : view.model).trim() || preset.defaultModel;
  const host = (draft ? draft.host : view.host).trim();
  // A stored key only counts while the draft is still on the preset it was stored for —
  // switching cards abandons it, exactly as the store will on save.
  const keyKept = view.hasApiKey && (!draft || draft.presetId === view.presetId);
  const keyState: KeyState = !presetRequiresKey(preset)
    ? 'not-needed'
    : (keyKept || draft?.apiKeyEntered) ? 'stored' : 'missing';
  return {
    preset,
    model,
    host,
    showHost: preset.editableHost,
    keyState,
    // Blank once the draft leaves the preset the stored key belongs to: showing the old
    // key's last four next to a different provider would name a key that is on its way out.
    apiKeyHint: keyKept ? view.apiKeyHint : '',
    usable: Boolean(model) && keyState !== 'missing' && (!preset.editableHost || Boolean(host)),
  };
}

// The line under the form. It always names the model that will actually run, because that
// — not which card looks selected — is what the user came here to confirm.
//
// Always called with the SAVED selection (no draft): while an unsaved draft sits on screen
// this sentence must keep describing what analysis really uses, or it would promise a model
// that nothing is configured to call.
export function modelStatusText(selection: ModelSelection): string {
  return `Analizler ${selection.preset.label} üzerinde ${selection.model} ile yapılacak.`;
}

// Whether the form has moved away from what is saved — so the screen can admit that the
// status line above describes the old choice, not the one on screen.
export function hasPendingChanges(
  config: ModelConfigView | undefined,
  draft: ModelDraft,
): boolean {
  const saved = draftFromConfig(config);
  return draft.apiKeyEntered
    || draft.presetId !== saved.presetId
    || draft.model.trim() !== saved.model.trim()
    || draft.host.trim() !== saved.host.trim();
}

// What is still missing before this can be saved, phrased as the action to take. Empty
// string means nothing is missing.
export function modelBlockerText(selection: ModelSelection): string {
  if (!selection.model) return 'Devam etmek için bir model adı girin.';
  if (selection.preset.editableHost && !selection.host) return 'Devam etmek için sunucu adresini girin.';
  if (selection.keyState === 'missing') return `${selection.preset.label} için API anahtarı girin.`;
  return '';
}

export function keyStateText(selection: ModelSelection): string {
  switch (selection.keyState) {
    case 'not-needed':
      return 'Bu sağlayıcı API anahtarı istemez.';
    case 'stored':
      // No hint means the key was typed just now and has not been saved yet — telling the
      // user it is "kayıtlı" before Kaydet would be wrong.
      return selection.apiKeyHint
        ? `Kayıtlı anahtar: ${selection.apiKeyHint}. Değiştirmek için yenisini girin.`
        : 'Anahtar girildi. Kaydet ile saklanacak.';
    case 'missing':
      return 'Bu sağlayıcı için bir API anahtarı gerekli.';
  }
}

// Where this setting lives, said plainly. When the write failed, saying so matters more
// than the path.
export function scopeText(config: ModelConfigView | undefined): string {
  const view = config ?? DEFAULT_VIEW;
  if (view.readOnlyReason) return view.readOnlyReason;
  if (view.source === 'remote') return 'Bu ayar merkezi sunucudan geliyor.';
  return `Bu ayar bu kullanıcı için yerel olarak saklanır (${view.path}).`;
}
