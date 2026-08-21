export type RenamePhase = 'idle' | 'editing' | 'saving';
export type MeetingRowTarget = 'row' | 'name' | 'input' | 'button';
export type MeetingRowIntent = 'open' | 'rename' | 'ignore';
export type MeetingButtonAction = 'open' | 'export' | 'delete';

export class RenameInteractionState {
  #phase: RenamePhase = 'idle';

  get phase(): RenamePhase {
    return this.#phase;
  }

  begin(): boolean {
    if (this.#phase !== 'idle') return false;
    this.#phase = 'editing';
    return true;
  }

  beginSave(): boolean {
    if (this.#phase !== 'editing') return false;
    this.#phase = 'saving';
    return true;
  }

  reset(): void {
    this.#phase = 'idle';
  }
}

export class SingleFlightInteractionState {
  #running = false;

  begin(): boolean {
    if (this.#running) return false;
    this.#running = true;
    return true;
  }

  finish(): void {
    this.#running = false;
  }
}

export function meetingRowIntent(
  target: MeetingRowTarget,
  renamePhase: RenamePhase,
  suppressRowOpen = false,
): MeetingRowIntent {
  if (suppressRowOpen || renamePhase !== 'idle') return 'ignore';
  if (target === 'name') return 'rename';
  if (target === 'row') return 'open';
  return 'ignore';
}

export function meetingButtonAction(value: string | undefined): MeetingButtonAction | null {
  if (value === 'open' || value === 'export' || value === 'delete') return value;
  return null;
}

// Merge the user's saved drag order (a list of ids) with the live list from main.
// Meetings not yet in the saved order (freshly recorded) surface first in their incoming
// newest-first order; saved ids that no longer exist (deleted) are dropped.
export function orderMeetings<T extends { id: string }>(meetings: T[], savedIds: string[]): T[] {
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const known = new Set(savedIds);
  const fresh = meetings.filter((m) => !known.has(m.id));
  const saved = savedIds.map((id) => byId.get(id)).filter((m): m is T => m !== undefined);
  return [...fresh, ...saved];
}
