export const EMPTY_SECTION_TEXT = 'Tespit edilmedi.';

export const ANALYSIS_SECTIONS = [
  { key: 'mainRequest', title: 'Ana İstek ve Amaç' },
  { key: 'contextAndTopics', title: 'Bağlam ve Ana Konular' },
  { key: 'decisions', title: 'Alınan Kararlar' },
  { key: 'rejectedOrDeferred', title: 'Reddedilen veya Ertelenen Seçenekler' },
  { key: 'actionItems', title: 'Aksiyon Maddeleri' },
  { key: 'questionsAndAnswers', title: 'Sorular ve Cevaplar' },
  { key: 'risksAndBlockers', title: 'Riskler ve Engelleyiciler' },
  { key: 'nextSteps', title: 'Sonraki Adımlar' },
  { key: 'detectedValues', title: 'Tespit Edilen Değerler' },
] as const;

export type AnalysisSectionKey = (typeof ANALYSIS_SECTIONS)[number]['key'];
export type AnalysisDraft = Record<AnalysisSectionKey, string[]>;

const stringArraySchema = { type: 'array', items: { type: 'string' } } as const;

export const ANALYSIS_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mainRequest: stringArraySchema,
    contextAndTopics: stringArraySchema,
    decisions: stringArraySchema,
    rejectedOrDeferred: stringArraySchema,
    actionItems: stringArraySchema,
    questionsAndAnswers: stringArraySchema,
    risksAndBlockers: stringArraySchema,
    nextSteps: stringArraySchema,
    detectedValues: stringArraySchema,
  },
  required: ANALYSIS_SECTIONS.map((section) => section.key),
} as const;

export function emptyAnalysisDraft(): AnalysisDraft {
  return Object.fromEntries(
    ANALYSIS_SECTIONS.map((section) => [section.key, []]),
  ) as unknown as AnalysisDraft;
}

function normalizeItem(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const item = value
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();
  if (!item || item.toLocaleLowerCase('tr-TR') === EMPTY_SECTION_TEXT.toLocaleLowerCase('tr-TR')) {
    return null;
  }
  return item;
}

export function coerceAnalysisDraft(raw: unknown): AnalysisDraft {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const draft = emptyAnalysisDraft();

  for (const section of ANALYSIS_SECTIONS) {
    const values = Array.isArray(obj[section.key]) ? obj[section.key] as unknown[] : [];
    const seen = new Set<string>();
    for (const value of values) {
      const item = normalizeItem(value);
      if (!item) continue;
      const key = item.toLocaleLowerCase('tr-TR');
      if (seen.has(key)) continue;
      seen.add(key);
      draft[section.key].push(item);
    }
  }

  return draft;
}

export function serializeAnalysisMarkdown(draft: AnalysisDraft): string {
  return ANALYSIS_SECTIONS.map((section) => {
    const items = draft[section.key];
    const body = items.length > 0
      ? items.map((item) => `- ${item}`).join('\n')
      : `- ${EMPTY_SECTION_TEXT}`;
    return `### ${section.title}\n\n${body}`;
  }).join('\n\n');
}

export function parseAnalysisMarkdown(markdown: string): AnalysisDraft {
  const draft = emptyAnalysisDraft();
  const titleToKey = new Map<string, AnalysisSectionKey>(
    ANALYSIS_SECTIONS.map((section) => [section.title, section.key]),
  );
  let current: AnalysisSectionKey | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) {
      current = titleToKey.get(heading[1].trim()) ?? null;
      continue;
    }
    if (!current) continue;
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (!bullet) continue;
    const item = normalizeItem(bullet[1]);
    if (item) draft[current].push(item);
  }

  return draft;
}
