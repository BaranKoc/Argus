import { validateLlmConfig, type LlmConfig } from '../../models.ts';
import { createAnthropicClient } from './anthropic-client.ts';
import type { LlmClient } from './client.ts';
import { createGeminiClient } from './gemini-client.ts';
import { createOllamaClient } from './ollama-client.ts';
import { createOpenAiClient } from './openai-client.ts';

export type { ChatRequest, LlmClient } from './client.ts';

// The single place a provider name turns into an adapter. Everything upstream
// (prompts.ts, sections.ts, pipeline.ts) is provider-agnostic and stays that way.
//
// The cancellation signal rides on the CLIENT, not on ChatRequest, because a client
// is already built per analysis call (analyzer.ts) while an analysis fans out into
// many chat() calls. That keeps pipeline.ts — which owns the map/reduce fan-out and
// would otherwise have to thread a signal through every helper — provider- and
// cancellation-agnostic, and guarantees no chunk request escapes the abort.
export function createLlmClient(config: LlmConfig, signal?: AbortSignal): LlmClient {
  validateLlmConfig(config);

  switch (config.provider) {
    case 'ollama':
      return createOllamaClient(config, signal);
    case 'openai':
      return createOpenAiClient(config, signal);
    case 'anthropic':
      return createAnthropicClient(config, signal);
    case 'gemini':
      return createGeminiClient(config, signal);
  }
}
