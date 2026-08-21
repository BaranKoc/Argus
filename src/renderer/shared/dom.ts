// The two element lookups every view needs, defined once instead of re-declared at the
// top of each file.
//
// `$` asserts the element exists, which is right for markup the view owns: a typo should
// blow up loudly at init, not produce a silently dead button. `$maybe` is for optional
// capability-based controls and elements that belong to a different panel.

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export const $maybe = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

export const $all = <T extends HTMLElement>(selector: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(selector));
