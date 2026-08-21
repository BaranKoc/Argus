import { showView, onViewChange, type ViewName } from '../../app/router.ts';
import { $, $all } from '../../shared/dom.ts';
import { initRecordView } from '../../features/record/record-view.ts';
import { initDashboard } from '../../features/dashboard/dashboard-view.ts';
import { initAdvancedSettingsView } from '../../features/settings/advanced/advanced-settings-view.ts';
import { initModelSettingsView } from '../../features/settings/model/model-settings-view.ts';

type SettingsPage = 'advanced' | 'model';

export function initUserShell(): void {
  const dashboard = initDashboard({ onNewRecording: () => showView('record') });

  initRecordView({
    onViewResults: (meetingId) => {
      showView('dashboard');
      if (meetingId) void dashboard.openMeeting(meetingId);
      else void dashboard.refreshList();
    },
  });

  const advancedSettings = initAdvancedSettingsView();
  const modelSettings = initModelSettingsView();
  const settingsPane = $<HTMLElement>('settingsPane');
  const topbarTitle = $<HTMLSpanElement>('topbarTitle');
  const navItems = $all<HTMLLIElement>('.menu-item[data-nav-view]');
  const settingsPanes: Record<SettingsPage, HTMLElement> = {
    advanced: $<HTMLElement>('settingsAdvancedPane'),
    model: $<HTMLElement>('settingsModelPane'),
  };
  const settingsButtons = $all<HTMLButtonElement>('[data-settings-page]');

  const selectSettingsPage = (page: SettingsPage): void => {
    for (const [name, pane] of Object.entries(settingsPanes)) pane.hidden = name !== page;
    for (const button of settingsButtons) {
      const active = button.dataset.settingsPage === page;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    if (page === 'advanced') advancedSettings?.open();
    else modelSettings.open();
  };

  for (const button of settingsButtons) {
    button.addEventListener('click', () => {
      if (button.dataset.settingsPage === 'advanced' || button.dataset.settingsPage === 'model') {
        selectSettingsPage(button.dataset.settingsPage);
      }
    });
  }

  onViewChange((view: ViewName) => {
    settingsPane.hidden = view !== 'settings';
    if (view === 'settings') {
      dashboard.hidePanes();
      topbarTitle.textContent = 'Ayarlar';
      selectSettingsPage('advanced');
    }
    if (view === 'dashboard') {
      dashboard.showList();
      topbarTitle.textContent = 'Toplantı Kayıtları';
      void dashboard.refreshList();
    }
    for (const item of navItems) item.classList.toggle('active', item.dataset.navView === view);
  });

  $<HTMLButtonElement>('toDashboardBtn').addEventListener('click', () => showView('dashboard'));
  $<HTMLButtonElement>('toSettingsBtn').addEventListener('click', () => showView('settings'));
  $<HTMLAnchorElement>('navNewRecording').addEventListener('click', (event) => {
    event.preventDefault();
    showView('record');
  });
  $<HTMLAnchorElement>('navRecordings').addEventListener('click', (event) => {
    event.preventDefault();
    showView('dashboard');
  });
  $<HTMLAnchorElement>('navSettings').addEventListener('click', (event) => {
    event.preventDefault();
    showView('settings');
  });

  const shell = $<HTMLElement>('userShellView');
  $<HTMLButtonElement>('sidebarCollapseBtn').addEventListener('click', () => {
    shell.classList.add('sidebar-collapsed');
  });
  $<HTMLButtonElement>('sidebarOpenBtn').addEventListener('click', () => {
    shell.classList.remove('sidebar-collapsed');
  });
}
