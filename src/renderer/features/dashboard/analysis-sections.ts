import {
  ANALYSIS_SECTIONS,
  emptyAnalysisDraft,
  parseAnalysisMarkdown,
  serializeAnalysisMarkdown,
  type AnalysisDraft,
  type AnalysisSectionKey,
} from '../../../../engine/analyze/sections.ts';

export interface AnalysisSectionView {
  key: AnalysisSectionKey;
  title: string;
  items: string[];
  count: number;
  empty: boolean;
}

const SECTION_THEME_CLASSES: Record<AnalysisSectionKey, string> = {
  mainRequest: 'theme-indigo',
  contextAndTopics: 'theme-blue',
  decisions: 'theme-green',
  rejectedOrDeferred: 'theme-orange',
  actionItems: 'theme-cyan',
  questionsAndAnswers: 'theme-violet',
  risksAndBlockers: 'theme-red',
  nextSteps: 'theme-teal',
  detectedValues: 'theme-amber',
};

export function analysisSectionThemeClass(key: AnalysisSectionKey): string {
  return SECTION_THEME_CLASSES[key];
}

export function analysisSectionViews(markdown?: string): AnalysisSectionView[] {
  const draft = markdown ? parseAnalysisMarkdown(markdown) : emptyAnalysisDraft();
  return ANALYSIS_SECTIONS.map(({ key, title }) => ({
    key,
    title,
    items: [...draft[key]],
    count: draft[key].length,
    empty: draft[key].length === 0,
  }));
}

export function replaceAnalysisSection(
  draft: AnalysisDraft,
  key: AnalysisSectionKey,
  items: string[],
): { draft: AnalysisDraft; markdown: string } {
  const next = { ...draft, [key]: items.map((item) => item.trim()).filter(Boolean) };
  return { draft: next, markdown: serializeAnalysisMarkdown(next) };
}
