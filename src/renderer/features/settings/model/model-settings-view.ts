// The Analiz Modeli settings tab. Writes the local user's model config; every
// decision about WHAT to show lives in model-settings.ts, so this file is only DOM.
//
// The form works on a local DRAFT and only writes on Kaydet. Picking a preset used to save
// immediately, which made every cloud card unselectable: the store validates each write,
// and a freshly picked cloud preset has no key yet, so the save was rejected and the screen
// snapped back to the previous preset — the user could never reach the key field. Now the
// draft holds the half-finished state, Kaydet stays disabled until it is complete, and the
// store only ever receives a config it will accept.

import type { ModelConfigPatch, ModelConfigView } from '../../../../preload/index.ts';
import { $, $all } from '../../../shared/dom.ts';
import { ipcErrorMessage } from '../../../shared/ipc-error.ts';
import {
  LLM_PRESETS,
  draftForPreset,
  draftFromConfig,
  hasPendingChanges,
  keyStateText,
  modelBlockerText,
  modelStatusText,
  resolveModelSelection,
  scopeText,
  type ModelDraft,
} from './model-settings.ts';

// Built once from the shared catalog. A <button role="radio"> rather than real radios: the
// card is the hit target and carries an icon, a badge and two lines of text, none of which
// a styled <input> gives us without fighting the UA.
function buildPresetCards(onSelect: (presetId: string) => void): void {
  const grid = $<HTMLElement>('llmPresetGrid');
  grid.replaceChildren(...LLM_PRESETS.map((preset) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'llm-preset-card';
    card.dataset.presetId = preset.id;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', 'false');

    const head = document.createElement('span');
    head.className = 'llm-preset-head';
    const icon = document.createElement('i');
    icon.className = preset.icon;
    const label = document.createElement('span');
    label.className = 'llm-preset-label';
    label.textContent = preset.label;
    head.append(icon, label);
    if (preset.badge) {
      const badge = document.createElement('span');
      badge.className = 'settings-badge';
      badge.textContent = preset.badge;
      head.append(badge);
    }

    const hint = document.createElement('span');
    hint.className = 'llm-preset-hint';
    hint.textContent = preset.hint;

    card.append(head, hint);
    card.addEventListener('click', () => onSelect(preset.id));
    return card;
  }));
}

export interface ModelSettingsView {
  open(): void;
}

export function initModelSettingsView(): ModelSettingsView {
  const message = $<HTMLElement>('llmMessage');
  const modelInput = $<HTMLInputElement>('llmModel');
  const hostInput = $<HTMLInputElement>('llmHost');
  const keyInput = $<HTMLInputElement>('llmApiKey');
  const saveBtn = $<HTMLButtonElement>('llmSaveBtn');

  // What is saved, and what the user is currently looking at. Both are needed at once:
  // the status line reports the former while the form renders the latter.
  let config: ModelConfigView | undefined;
  let draft: ModelDraft = draftFromConfig(undefined);

  // Everything that depends on the draft but NOT on the input values. Called on every
  // keystroke, so it must never write to an input — that would send the caret to the start
  // of the box mid-word.
  const renderValidity = (): void => {
    const selection = resolveModelSelection(config, draft);

    for (const card of $all<HTMLButtonElement>('.llm-preset-card')) {
      const active = card.dataset.presetId === selection.preset.id;
      card.classList.toggle('selected', active);
      card.setAttribute('aria-checked', String(active));
    }

    $<HTMLElement>('llmHostRow').hidden = !selection.showHost;
    $<HTMLElement>('llmApiKeyRow').hidden = selection.keyState === 'not-needed';
    keyInput.placeholder = selection.apiKeyHint || 'sk-...';
    $<HTMLElement>('llmApiKeyHint').textContent = keyStateText(selection);

    $<HTMLElement>('llmBlocker').textContent = modelBlockerText(selection);
    // Disabled until the draft is complete: this is what keeps an invalid patch off the
    // IPC channel entirely, so the store's own validation never has to reject one.
    saveBtn.disabled = !selection.usable;

    const modelHint = $<HTMLElement>('llmModelHint');
    modelHint.textContent = selection.preset.suggestedModels.length
      ? 'Listeden seçebilir veya kendi model adınızı yazabilirsiniz.'
      : 'Sunucunuzun sunduğu model adını yazın.';

    // The status line describes what is SAVED, not the draft. When they differ, say so
    // rather than letting the sentence look stale.
    const saved = resolveModelSelection(config);
    const status = $<HTMLElement>('llmStatus');
    const pending = hasPendingChanges(config, draft);
    status.textContent = pending
      ? `${modelStatusText(saved)} Kaydedilmemiş değişiklik var.`
      : modelStatusText(saved);
    status.classList.toggle('ready', !pending && saved.usable);
    status.classList.toggle('warning', pending || !saved.usable);
  };

  // Pushes the draft INTO the inputs. Separate from renderValidity because it moves the
  // caret: only call it when the draft was replaced wholesale, never on a keystroke.
  const syncInputs = (): void => {
    const preset = resolveModelSelection(config, draft).preset;
    modelInput.value = draft.model;
    modelInput.placeholder = preset.defaultModel || 'model adı';
    hostInput.value = draft.host;
    // Never refilled from the response — the renderer is not given the key. Cleared so a
    // saved key doesn't look like it is sitting in the box waiting to be re-sent.
    keyInput.value = '';
    $<HTMLDataListElement>('llmModelOptions').replaceChildren(
      ...preset.suggestedModels.map((model) => {
        const option = document.createElement('option');
        option.value = model;
        return option;
      }),
    );
    renderValidity();
  };

  // Full render: the saved config changed, so both the draft and the scope line follow it.
  const renderAll = (next: ModelConfigView): void => {
    config = next;
    draft = draftFromConfig(next);

    const scope = $<HTMLElement>('llmScope');
    scope.textContent = scopeText(next);
    scope.classList.toggle('warning', Boolean(next.readOnlyReason));

    syncInputs();
  };

  const refresh = async (): Promise<void> => {
    try { renderAll(await window.api.getModelConfig()); }
    catch (error) { message.textContent = ipcErrorMessage(error); }
  };

  // Switching presets rewrites the whole draft — the model box has to follow the card, and
  // the previous preset's host/key are abandoned exactly as the store would on save.
  const selectPreset = (presetId: string): void => {
    message.textContent = '';
    draft = draftForPreset(presetId);
    syncInputs();
  };

  buildPresetCards(selectPreset);

  for (const [input, key] of [[modelInput, 'model'], [hostInput, 'host']] as const) {
    input.addEventListener('input', () => {
      draft = { ...draft, [key]: input.value };
      renderValidity();
    });
  }
  keyInput.addEventListener('input', () => {
    draft = { ...draft, apiKeyEntered: keyInput.value.trim().length > 0 };
    renderValidity();
  });

  saveBtn.addEventListener('click', async () => {
    message.textContent = '';
    const apiKey = keyInput.value.trim();
    const patch: ModelConfigPatch = {
      presetId: draft.presetId,
      model: draft.model,
      host: draft.host,
      // Omitted when the box is empty: that means "leave the stored key alone", not
      // "clear it" (see main/model-config.ts ModelConfigPatch).
      ...(apiKey ? { apiKey } : {}),
    };
    try {
      if (typeof window.api.setModelConfig !== 'function') {
        throw new Error('Analiz modeli ayarını kullanmak için uygulamayı tamamen kapatıp yeniden açın.');
      }
      renderAll(await window.api.setModelConfig(patch));
    } catch (error) {
      // Re-read rather than leave a rejected draft claiming to be saved: what is stored and
      // what is on screen have diverged, and the stored one is the truth.
      message.textContent = ipcErrorMessage(error);
      await refresh();
    }
  });

  void refresh();
  return { open(): void { void refresh(); } };
}
