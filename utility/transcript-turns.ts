// Whisper marks a change of speaker with a leading dash and keeps writing into the same
// block of text, so one segment — and, in the export, the whole transcript — arrives as a
// wall of prose with " -" turn markers buried in it. Both the on-screen Döküm card and the
// PDF break that back into one line per turn, so this rule lives where both can reach it.

// A dash only opens a turn when whitespace comes before it, which is what keeps hyphenated
// words ("e-posta", "think-standardıklık") on one line. The dash itself is kept: it is the
// only thing marking the line as somebody else's turn, and the transcript is shown as the
// engine produced it.
const TURN_BOUNDARY = /\s+(?=-\s*\S)/;

export function splitTranscriptTurns(text: string): string[] {
  return text
    .split(TURN_BOUNDARY)
    .map((turn) => turn.trim())
    .filter((turn) => turn.length > 0);
}
