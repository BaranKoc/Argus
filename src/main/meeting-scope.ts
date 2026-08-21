// Validation for the second per-recording option the renderer sends to main.
//
// Its own module for the same reason as meeting-language.ts: ipc.ts imports electron,
// which a plain `node --test` process cannot load, and this rule is worth a test.
//
// Differs from the language rule in one way, on purpose. A MISSING field falls back to
// 'group' — that is the value every recording had before this option existed, so an older
// renderer (or a caller that legitimately has nothing to say about the room) keeps working
// unchanged. An UNRECOGNISED value still throws: it can only mean the renderer and main
// disagree about the contract, and silently analysing a group meeting as two-party would
// merge everyone on the far end into one "Uzak Konuşmacı" with nothing to point at later.

import { DEFAULT_MEETING_SCOPE, type MeetingScope } from '../../engine/index.ts';

export function parseMeetingScope(payload: unknown): MeetingScope {
  const value = (payload as { meetingScope?: unknown } | null)?.meetingScope;
  if (value === undefined || value === null) return DEFAULT_MEETING_SCOPE;
  if (value !== 'group' && value !== 'two-party') throw new Error('Geçersiz toplantı türü ayarı.');
  return value;
}
