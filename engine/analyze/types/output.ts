export interface Analysis {
  status: 'success';
  markdown: string;
}

export interface AnalyzeOpts {
  language?: string;
  // Aborts the in-flight provider request. Set when the meeting it belongs to was
  // cancelled, so a discarded analysis stops costing tokens the moment the user says so.
  signal?: AbortSignal;
}
