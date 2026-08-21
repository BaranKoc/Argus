// Every view lives in one document so an active recording survives navigation to the
// meeting archive. Record is a separate focus canvas; dashboard and settings share the
// persistent application shell.

export type ViewName = 'record' | 'dashboard' | 'settings';

const viewRoots: Record<ViewName, string> = {
  record: 'recordView',
  dashboard: 'userShellView',
  settings: 'userShellView',
};

const roots = Array.from(new Set(Object.values(viewRoots)));
type Listener = (view: ViewName) => void;
const listeners: Listener[] = [];
let current: ViewName = 'record';

export function onViewChange(cb: Listener): void {
  listeners.push(cb);
}

export function currentView(): ViewName {
  return current;
}

export function showView(name: ViewName): void {
  current = name;
  const target = viewRoots[name];
  for (const id of roots) {
    const element = document.getElementById(id);
    if (element) element.hidden = id !== target;
  }
  for (const listener of listeners) listener(name);
}
