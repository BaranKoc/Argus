interface SplitOptions {
  maxTokens: number;
  overlapTokens: number;
  charsPerToken: number;
}

const SEPARATORS = ['\n\n', '\nSPEAKER_', '\n', '. ', ' '];

function approxTokens(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken);
}

function splitKeepDelimiterOnLeft(text: string, delimiter: string): string[] {
  const out: string[] = [];
  let start = 0;
  while (true) {
    const idx = text.indexOf(delimiter, start);
    if (idx < 0) {
      out.push(text.slice(start));
      return out;
    }
    out.push(text.slice(start, idx + delimiter.length));
    start = idx + delimiter.length;
  }
}

function splitByDelimiter(text: string, delimiter: string): string[] {
  const parts = delimiter === '\nSPEAKER_'
    ? text.split(/(?=\nSPEAKER_)/g)
    : splitKeepDelimiterOnLeft(text, delimiter);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function hardSplitBySize(text: string, maxTokens: number, charsPerToken: number): string[] {
  const maxChars = Math.max(1, Math.floor(maxTokens * charsPerToken));
  const out: string[] = [];
  for (let cursor = 0; cursor < text.length; cursor += maxChars) {
    out.push(text.slice(cursor, cursor + maxChars).trim());
  }
  return out.filter((chunk) => chunk.length > 0);
}

function recursiveSplit(
  text: string,
  separatorIndex: number,
  maxTokens: number,
  charsPerToken: number,
): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (approxTokens(normalized, charsPerToken) <= maxTokens) return [normalized];
  if (separatorIndex >= SEPARATORS.length) {
    return hardSplitBySize(normalized, maxTokens, charsPerToken);
  }

  const parts = splitByDelimiter(normalized, SEPARATORS[separatorIndex]);
  if (parts.length <= 1) {
    return recursiveSplit(normalized, separatorIndex + 1, maxTokens, charsPerToken);
  }

  const out: string[] = [];
  for (const part of parts) {
    if (approxTokens(part, charsPerToken) <= maxTokens) out.push(part);
    else out.push(...recursiveSplit(part, separatorIndex + 1, maxTokens, charsPerToken));
  }
  return out;
}

function packGreedy(parts: string[], maxTokens: number, charsPerToken: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const part of parts) {
    if (!current) {
      current = part;
      continue;
    }
    const candidate = `${current} ${part}`.replace(/\s+/g, ' ').trim();
    if (approxTokens(candidate, charsPerToken) <= maxTokens) current = candidate;
    else {
      out.push(current);
      current = part;
    }
  }
  if (current) out.push(current);
  return out;
}

function tailForOverlap(chunk: string, overlapTokens: number, charsPerToken: number): string {
  if (overlapTokens <= 0) return '';
  const sentences = chunk.split(/(?<=[.!?])\s+/).filter(Boolean);
  const selected: string[] = [];
  let tokens = 0;
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    selected.unshift(sentences[i]);
    tokens += approxTokens(sentences[i], charsPerToken);
    if (tokens >= overlapTokens) break;
  }
  return selected.join(' ').trim();
}

function applyOverlap(chunks: string[], options: SplitOptions): string[] {
  if (chunks.length <= 1 || options.overlapTokens <= 0) return chunks;
  const out = [chunks[0]];
  for (let i = 1; i < chunks.length; i += 1) {
    const tail = tailForOverlap(out[i - 1], options.overlapTokens, options.charsPerToken);
    const next = chunks[i].trim();
    out.push(!tail || next.startsWith(tail) ? next : `${tail} ${next}`.replace(/\s+/g, ' ').trim());
  }
  return out;
}

export function splitDialogue(text: string, options: SplitOptions): string[] {
  const chunks = recursiveSplit(text, 0, options.maxTokens, options.charsPerToken);
  return applyOverlap(packGreedy(chunks, options.maxTokens, options.charsPerToken), options);
}
