import { GoogleGenAI, type Schema } from '@google/genai';
import type { LlmConfig } from '../../models.ts';
import type { ChatRequest, LlmClient } from './client.ts';
import { parseJsonContent, toProviderError } from './errors.ts';

// Gemini's responseSchema is an OpenAPI 3.0 subset, not full JSON Schema, and it
// rejects the whole request if it sees `additionalProperties`. ANALYSIS_DRAFT_SCHEMA
// sets that key deliberately (OpenAI's strict mode requires it), so strip it here
// rather than weakening the shared schema for every other provider. The SDK does
// not do this for us — it forwards the schema as given.
export function stripForGemini(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripForGemini);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'additionalProperties')
      .map(([key, entry]) => [key, stripForGemini(entry)]),
  );
}

// The official `@google/genai` package. It sends the key as an `x-goog-api-key`
// header rather than the `?key=` query parameter the REST docs lead with, which is
// what we want: a URL carrying the key would end up in our own error messages and
// in any proxy log along the way.
export function createGeminiClient(config: LlmConfig, signal?: AbortSignal): LlmClient {
  const client = new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions: {
      baseUrl: config.host.replace(/\/$/, ''),
      timeout: config.timeoutMs,
      // `attempts` counts the original request, so ENGINE_LLM_MAX_RETRIES=0 has to
      // become 1 attempt, not 0 (which the SDK also reads as "no retries", but the
      // arithmetic is what keeps this honest against the other providers).
      retryOptions: { attempts: config.maxRetries + 1 },
    },
  });

  return {
    async chat(request: ChatRequest): Promise<unknown> {
      let response;
      try {
        response = await client.models.generateContent({
          model: config.model,
          contents: [{ role: 'user', parts: [{ text: request.user }] }],
          config: {
            abortSignal: signal,
            systemInstruction: request.system,
            temperature: config.temperature,
            maxOutputTokens: config.maxTokens,
            responseMimeType: 'application/json',
            ...(request.schema
              ? { responseSchema: stripForGemini(request.schema) as Schema }
              : {}),
          },
        });
      } catch (error) {
        throw toProviderError(error, {
          providerLabel: 'Gemini',
          host: config.host,
          timeoutMs: config.timeoutMs,
        });
      }

      return parseJsonContent(response.text, 'Gemini');
    },
  };
}
