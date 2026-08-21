// Validation for the one per-recording option the renderer sends to main.
//
// Deliberately its own module rather than a helper inside ipc.ts: that file imports
// electron, which a plain `node --test` process cannot load, and this rule is worth a
// test. Same split as authorization.ts — policy here, wiring there.

import { type MeetingLanguage } from '../../engine/index.ts';

// Throws rather than defaulting. Every other live:start option is derived in main from
// SettingsStore, so an unrecognised value here means the renderer and main disagree
// about the contract — and silently recording a foreign meeting with the Turkish model
// produces a transcript that reads as broken with nothing to point at.
export function parseMeetingLanguage(payload: unknown): MeetingLanguage {
  const value = (payload as { meetingLanguage?: unknown } | null)?.meetingLanguage;
  if (value !== 'turkish' && value !== 'foreign') throw new Error('Geçersiz toplantı dili ayarı.');
  return value;
}
