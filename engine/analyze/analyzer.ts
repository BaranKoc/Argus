import { getLlmConfig, type LlmConfig } from '../models.ts';
import { createLlmClient, type LlmClient } from './llm/index.ts';
import { analyzeTranscript } from './pipeline.ts';
import type { Analysis, AnalyzeOpts } from './types/output.ts';

export type { Analysis, AnalyzeOpts } from './types/output.ts';

export interface AnalyzerDependencies {
  client?: LlmClient;
  config?: LlmConfig;
}

export function createAnalyzer(dependencies: AnalyzerDependencies = {}) {
  // Both config and client are resolved per call, not at construction. The exported
  // analyzeText singleton is built at module load, which in Electron happens before
  // .env has necessarily been read — resolving early would pin the analyzer to the
  // compiled-in defaults for the life of the process.
  return async function runAnalyzer(text: string, opts?: AnalyzeOpts): Promise<Analysis> {
    const config = dependencies.config ?? getLlmConfig();
    // An injected client (tests, bench) is used as given — wiring the signal into it
    // is the caller's business, and silently wrapping it would change what is measured.
    const client = dependencies.client ?? createLlmClient(config, opts?.signal);
    return {
      status: 'success',
      markdown: await analyzeTranscript(text, client, config),
    };
  };
}

export const analyzeText = createAnalyzer();
