// The speaker-separation tab and whether its labels reach the analysis. Both preferences
// are stored locally under Electron userData.

import type { SettingsResponse } from '../../../../preload/index.ts';
import { $, $maybe } from '../../../shared/dom.ts';
import { ipcErrorMessage } from '../../../shared/ipc-error.ts';

function settingsErrorMessage(error: unknown): string {
  const message = ipcErrorMessage(error);
  // A build whose main process predates this channel: the raw "No handler registered"
  // means nothing to the person reading it, so name the fix instead.
  if (
    message.includes('No handler registered')
    && message.includes('settings:setAnalysisIncludeSpeakers')
  ) {
    return 'Yeni analiz ayarını kullanmak için uygulamayı tamamen kapatıp yeniden açın.';
  }
  return message;
}

export function resolveAnalysisIncludeSpeakers(response: SettingsResponse): boolean {
  const diarizationEnabled = response.status.ready && response.settings.diarization.enabled;
  return diarizationEnabled && (response.settings.analysis?.includeSpeakers ?? true);
}

// A missing runtime is the expected first-run state, not a broken install: the CUDA
// runtime is too large to ship inside the installer, so it arrives as a separate archive
// the user applies from the guide below. Anything else genuinely is a packaging fault.
export function unavailableHint(status: SettingsResponse['status']): string {
  if (status.reason === 'no-runtime') {
    return 'Bu özellik henüz kullanıma hazır değil: GPU desteği installer ile birlikte verilen'
      + ' ayrı bir dosyadan kurulur ve NVIDIA ekran kartı gerektirir. Aşağıdaki adımlar'
      + ' bunun nasıl yapıldığını anlatır.';
  }
  return 'Bu uygulama paketi Pyannote modelini içermiyor. Kurulum paketi geliştirici tarafından hazırlanmalıdır.';
}

function render(response: SettingsResponse): void {
  const diarizationToggle = $maybe<HTMLInputElement>('diarizationEnabled');
  const analysisSpeakersToggle = $maybe<HTMLInputElement>('analysisIncludeSpeakers');
  if (!diarizationToggle || !analysisSpeakersToggle) return;

  const diarizationEnabled = response.status.ready && response.settings.diarization.enabled;
  diarizationToggle.checked = response.settings.diarization.enabled;
  diarizationToggle.disabled = !response.status.ready;
  analysisSpeakersToggle.checked = resolveAnalysisIncludeSpeakers(response);
  analysisSpeakersToggle.disabled = !diarizationEnabled;

  const status = $<HTMLElement>('pyannoteStatus');
  status.textContent = response.status.message;
  // toggle, not className: the element also carries layout/utility classes from the
  // markup, and a wholesale assignment would strip them on the first render.
  status.classList.toggle('ready', response.status.ready);
  status.classList.toggle('warning', !response.status.ready);

  // Fades the whole section, not just the two inputs, so an unavailable feature reads as
  // unavailable at a glance instead of looking like a setting that failed to load.
  $maybe<HTMLElement>('diarizationSection')?.classList.toggle('is-unavailable', !response.status.ready);

  $<HTMLElement>('diarizationHint').textContent = response.status.ready
    ? 'Etkinleştirildiğinde konuşmacı etiketleri kayıt bittikten sonra yerel olarak eklenir.'
    : unavailableHint(response.status);
  $<HTMLElement>('analysisSpeakersHint').textContent = diarizationEnabled
    ? 'Konuşmacı etiketlerinin yeni toplantıların analiz girdisinde kullanılıp kullanılmayacağını belirler.'
    : 'Bu ayarı kullanmak için önce konuşmacı ayrımını etkinleştirin.';
}

export interface AdvancedSettingsView {
  open(): void;
}

// Returns null when the page is not in this build, so the caller has one thing to check
// instead of every call site guarding.
export function initAdvancedSettingsView(): AdvancedSettingsView | null {
  const diarizationToggle = $maybe<HTMLInputElement>('diarizationEnabled');
  const analysisSpeakersToggle = $maybe<HTMLInputElement>('analysisIncludeSpeakers');
  const message = $maybe<HTMLElement>('settingsMessage');
  if (!diarizationToggle || !analysisSpeakersToggle || !message) return null;

  const refresh = async (): Promise<void> => {
    try { render(await window.api.getSettings()); }
    catch (error) { message.textContent = String(error); }
  };

  // Step 1 of the guide. An id, not a URL: the address lives in shared/external-links.ts
  // and the main process is what opens it, so the renderer never hands the OS a link.
  const driverButton = $maybe<HTMLButtonElement>('openNvidiaDriver');
  driverButton?.addEventListener('click', async () => {
    message.textContent = '';
    try { await window.api.openExternal('nvidia-driver'); }
    catch (error) { message.textContent = settingsErrorMessage(error); }
  });

  const addonButton = $maybe<HTMLButtonElement>('installGpuAddon');
  const addonHint = $maybe<HTMLElement>('gpuAddonHint');
  if (addonButton && addonHint) {
    // Extraction is minutes long, so the percentage is the only thing telling the user
    // the app has not hung.
    window.api.onGpuAddonProgress?.(({ percent }) => {
      addonHint.textContent = `GPU desteği kuruluyor… %${percent}`;
    });

    addonButton.addEventListener('click', async () => {
      message.textContent = '';
      addonButton.disabled = true;
      addonHint.textContent = 'Arşiv seçiliyor…';
      try {
        const response = await window.api.installGpuAddon();
        addonHint.textContent = '';
        render(response);
        if (response.installed) message.textContent = 'GPU desteği kuruldu.';
      } catch (error) {
        addonHint.textContent = '';
        message.textContent = settingsErrorMessage(error);
      } finally {
        addonButton.disabled = false;
      }
    });
  }

  diarizationToggle.addEventListener('change', async () => {
    message.textContent = '';
    try { render(await window.api.setDiarizationEnabled(diarizationToggle.checked)); }
    catch (error) {
      await refresh();
      message.textContent = settingsErrorMessage(error);
    }
  });

  analysisSpeakersToggle.addEventListener('change', async () => {
    message.textContent = '';
    try {
      if (typeof window.api.setAnalysisIncludeSpeakers !== 'function') {
        throw new Error('Yeni analiz ayarını kullanmak için uygulamayı tamamen kapatıp yeniden açın.');
      }
      render(await window.api.setAnalysisIncludeSpeakers(analysisSpeakersToggle.checked));
    } catch (error) {
      await refresh();
      message.textContent = settingsErrorMessage(error);
    }
  });

  void refresh();
  return { open(): void { void refresh(); } };
}
