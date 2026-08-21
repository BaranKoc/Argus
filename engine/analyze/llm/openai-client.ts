import OpenAI from 'openai';
import type { LlmConfig } from '../../models.ts';
import type { ChatRequest, LlmClient } from './client.ts';
import { parseJsonContent, toProviderError } from './errors.ts';

const SCHEMA_NAME = 'analysis_draft';

// The official `openai` package, which covers far more than OpenAI itself:
// OpenRouter, Groq, Together, DeepSeek, Mistral, vLLM and LM Studio all speak the
// same endpoint, so pointing ENGINE_LLM_URL at any of them with provider=openai is
// enough — `baseURL` is exactly the seam the SDK exposes for that.
export function createOpenAiClient(config: LlmConfig, signal?: AbortSignal): LlmClient {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.host.replace(/\/$/, ''),
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries,
  });

  return {
    async chat(request: ChatRequest): Promise<unknown> {
      // 'object' mode is the fallback for OpenAI-compatible servers that accept the
      // endpoint but reject json_schema; the prompt already asks for this exact
      // shape and coerceAnalysisDraft repairs the rest.
      const responseFormat = config.jsonMode === 'object' || !request.schema
        ? { type: 'json_object' as const }
        : {
          type: 'json_schema' as const,
          json_schema: { name: SCHEMA_NAME, strict: true, schema: request.schema },
        };

      let completion;
      try {
        completion = await client.chat.completions.create({
          model: config.model,
          temperature: config.temperature,
          // Not max_completion_tokens: the OpenAI-compatible servers above are the
          // majority of this adapter's traffic and many still only know max_tokens.
          max_tokens: config.maxTokens,
          // No num_ctx equivalent here — the context window is a property of the
          // hosted model, not a per-request knob. config.numCtx still matters: it is
          // the budget pipeline.ts plans single-pass vs. map/reduce chunking against,
          // so set it to the model's real window even though it isn't sent.
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          response_format: responseFormat,
        }, { signal });
      } catch (error) {
        throw toProviderError(error, {
          providerLabel: 'OpenAI',
          host: config.host,
          timeoutMs: config.timeoutMs,
        });
      }

      // The SDK throws on a non-2xx, but some OpenAI-compatible servers answer 200
      // with an error body instead, which would otherwise surface as "boş yanıt".
      const reported = (completion as { error?: { message?: string } }).error;
      if (reported?.message) throw new Error(`OpenAI hatası: ${reported.message}`);
      return parseJsonContent(completion.choices?.[0]?.message?.content ?? undefined, 'OpenAI');
    },
  };
}
