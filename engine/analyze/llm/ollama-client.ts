import { Ollama, type ChatResponse } from 'ollama';
import type { LlmConfig } from '../../models.ts';
import type { ChatRequest, LlmClient } from './client.ts';
import { isRetriable, parseJsonContent, toProviderError } from './errors.ts';

// The official `ollama` package, pointed at its native /api/chat rather than the
// OpenAI-compatible /v1 endpoint: only this one takes `format` as a full JSON
// Schema and `num_ctx` as a per-request option, and both shape the analysis output
// the control-group references were produced with.
//
// ollama-js is the one SDK here with neither a timeout nor a retry policy of its
// own (the other three take them as client options), so ENGINE_LLM_TIMEOUT_MS is
// enforced through the injected fetch below and ENGINE_LLM_MAX_RETRIES by withRetry.
export function createOllamaClient(config: LlmConfig, signal?: AbortSignal): LlmClient {
  const client = new Ollama({ host: config.host, fetch: fetchWithTimeout(config.timeoutMs, signal) });

  return {
    async chat(request: ChatRequest): Promise<unknown> {
      let data: ChatResponse;
      try {
        data = await withRetry(config.maxRetries, signal, () => client.chat({
          model: config.model,
          stream: false,
          think: false,
          format: request.schema ?? 'json',
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          options: { temperature: config.temperature, num_ctx: request.numCtx ?? config.numCtx },
        }));
      } catch (error) {
        throw toProviderError(error, {
          providerLabel: 'Ollama',
          host: config.host,
          timeoutMs: config.timeoutMs,
          hint: '"ollama serve" çalışıyor mu?',
        });
      }

      // Ollama reports model-level failures in a 200 body, which ollama-js passes
      // through untouched (it only throws on a non-2xx), so this is not dead code.
      const reported = (data as { error?: string }).error;
      if (reported) throw new Error(`Ollama hatası: ${reported}`);
      return parseJsonContent(data.message?.content, 'Ollama');
    },
  };
}

function fetchWithTimeout(timeoutMs: number, cancel?: AbortSignal): typeof fetch {
  return (input, init) => {
    // ollama-js passes its own signal so that `ollama.abort()` works; combine
    // rather than replace, or the deadline would silently disable that. `cancel` is
    // the session-wide abort (a cancelled meeting) and joins the same union.
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (init?.signal) signals.push(init.signal);
    if (cancel) signals.push(cancel);
    return fetch(input, { ...init, signal: AbortSignal.any(signals) });
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  maxRetries: number,
  cancel: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      // A cancelled meeting aborts as an AbortError, which isRetriable reads as a
      // transient timeout — retrying a signal that is already aborted just burns the
      // whole retry budget on instant failures and mislabels the result "zaman aşımı".
      if (cancel?.aborted) throw error;
      if (attempt >= maxRetries || !isRetriable(error)) throw error;
      await sleep(250 * (attempt + 1));
    }
  }
}
