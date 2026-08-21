// What is left of the old hand-rolled http.ts. The retry/timeout loop it used to
// own is now the SDKs' job (`maxRetries`/`timeout` client options on OpenAI and
// Anthropic, `httpOptions.retryOptions` on Gemini; Ollama is the exception — see
// ollama-client.ts). What is NOT their job is the wording: these Turkish messages
// go straight to the desktop UI, and four SDKs with four error vocabularies would
// otherwise leak "Connection error." at the user. So the one thing still shared
// across adapters is the translation into our message shapes.

export interface ProviderContext {
  // Shown in error messages, e.g. "Ollama" / "OpenAI". The host is included too so
  // a misconfigured ENGINE_LLM_URL is visible in the message itself.
  providerLabel: string;
  host: string;
  timeoutMs: number;
  // Provider-specific recovery advice appended to the connection-failure message
  // (Ollama's is '"ollama serve" çalışıyor mu?').
  hint?: string;
}

// Every SDK carries the HTTP status on its error, just under a different name:
// `status` for OpenAI/Anthropic/Gemini, `status_code` for ollama-js's ResponseError.
function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { status, status_code: statusCode } = error as Record<string, unknown>;
  if (typeof status === 'number') return status;
  if (typeof statusCode === 'number') return statusCode;
  return undefined;
}

// Names rather than instanceof: the four SDKs each throw their own class, and an
// undici timeout surfaces as a bare DOMException. Matching on the name keeps this
// free of imports from all four packages.
const TIMEOUT_NAMES = new Set(['AbortError', 'TimeoutError', 'APIConnectionTimeoutError']);

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (TIMEOUT_NAMES.has(error.name)) return true;
  return /timed out|timeout/i.test(error.message);
}

// Retry policy for adapters whose SDK has none (Ollama). Mirrors what the other
// three SDKs do by default: transient statuses, plus a request that never reached
// the server. Deliberately narrow — a TypeError from a bad argument is a bug, and
// retrying it three times only delays the stack trace.
export function isRetriable(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return status === 429 || status >= 500;
  if (isTimeout(error)) return true;
  return error instanceof Error && error.message.toLowerCase().includes('fetch');
}

export function toProviderError(error: unknown, context: ProviderContext): Error {
  const { providerLabel, host, timeoutMs, hint } = context;

  const status = statusOf(error);
  if (status !== undefined) {
    const detail = error instanceof Error ? error.message : '';
    return new Error(`${providerLabel} isteği başarısız: ${status}. ${detail}`.trim());
  }

  if (isTimeout(error)) {
    return new Error(`${providerLabel} zaman aşımı (${timeoutMs} ms): ${host}`);
  }

  if (error instanceof Error && error.message) {
    const advice = hint ? ` ${hint}` : '';
    return new Error(`${providerLabel}'a bağlanılamadı (${host}).${advice} (${error.message})`);
  }

  return new Error(`${providerLabel} isteği başarısız oldu.`);
}

// Adapters all end up doing the same thing with a provider's text payload: the
// model was told to emit JSON, so a parse failure is a model failure and the
// message has to carry enough of the text to diagnose it.
export function parseJsonContent(content: string | undefined, providerLabel: string): unknown {
  if (!content) throw new Error(`${providerLabel} boş yanıt döndürdü.`);
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(
      `${providerLabel} yanıtı JSON olarak ayrıştırılamadı: ${content.slice(0, 200)}`,
    );
  }
}
