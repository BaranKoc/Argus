// Unit tests for the LLM provider adapters (npm test). No network: globalThis.fetch
// is stubbed, so these assert exactly what each provider would receive on the wire
// and what we make of its reply. The Ollama cases are the regression guard for the
// multi-provider refactor — that request body must not drift, or every
// control-group analyze reference silently stops being comparable.
//
// Asserting on the wire and not on the SDKs is deliberate: the adapters now delegate
// to each vendor's official client, so what we actually need to know is that those
// clients still produce the bodies our references were made with.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createLlmClient } from '../analyze/llm/index.ts';
import { stripForGemini } from '../analyze/llm/gemini-client.ts';
import { getLlmConfig, llmSnapshot, type LlmConfig, type LlmProvider } from '../models.ts';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { mainRequest: { type: 'array', items: { type: 'string' } } },
  required: ['mainRequest'],
};

const DRAFT = { mainRequest: ['Rapor istendi.'] };

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: 'ollama',
    model: 'test-model',
    host: 'http://localhost:11434',
    apiKey: '',
    jsonMode: 'schema',
    maxTokens: 4096,
    temperature: 0,
    numCtx: 8192,
    timeoutMs: 5000,
    maxRetries: 0,
    mapConcurrency: 1,
    chunkTokens: 2200,
    chunkOverlapTokens: 0,
    charsPerToken: 3.5,
    ...overrides,
  };
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
let captured: Captured[];

// Headers arrive as a Headers instance, a plain object or an entry array depending
// on which SDK built the request; flatten to lowercase keys so assertions don't
// have to care.
function flattenHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const flat: Record<string, string> = {};
  if (!headers) return flat;
  const entries = headers instanceof Headers
    ? [...headers.entries()]
    : Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [key, value] of entries) flat[key.toLowerCase()] = String(value);
  return flat;
}

// Each queued entry is one response; the last one repeats so a retry test can
// queue [500, 200] while a single-call test queues just one. A real Response is
// handed back rather than a hand-rolled stub because every SDK reads more of it
// than the old adapters did (content-type on the error path, retry-after, ...).
function stubFetch(queue: { status?: number; json?: unknown; text?: string }[]): void {
  let index = 0;
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    captured.push({
      url: String(url),
      headers: flattenHeaders(init.headers),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const entry = queue[Math.min(index, queue.length - 1)];
    index += 1;
    const status = entry.status ?? 200;
    const body = entry.json !== undefined ? JSON.stringify(entry.json) : (entry.text ?? '');
    return new Response(body, {
      status,
      statusText: String(status),
      headers: { 'content-type': entry.json !== undefined ? 'application/json' : 'text/plain' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  captured = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('ollama adapter', () => {
  it('sends the expected request body unchanged', async () => {
    stubFetch([{ json: { message: { content: JSON.stringify(DRAFT) } } }]);
    const client = createLlmClient(config());

    const result = await client.chat({ system: 'SYS', user: 'USER', schema: SCHEMA, numCtx: 4096 });

    assert.deepEqual(result, DRAFT);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, 'http://localhost:11434/api/chat');
    assert.deepEqual(captured[0].body, {
      model: 'test-model',
      stream: false,
      think: false,
      format: SCHEMA,
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'USER' },
      ],
      options: { temperature: 0, num_ctx: 4096 },
    });
  });

  it('falls back to num_ctx from config and format "json" without a schema', async () => {
    stubFetch([{ json: { message: { content: '{}' } } }]);
    await createLlmClient(config()).chat({ system: 'S', user: 'U' });

    assert.equal(captured[0].body.format, 'json');
    assert.deepEqual(captured[0].body.options, { temperature: 0, num_ctx: 8192 });
  });

  it('strips a trailing slash from the host', async () => {
    stubFetch([{ json: { message: { content: '{}' } } }]);
    await createLlmClient(config({ host: 'http://box:11434/' })).chat({ system: 'S', user: 'U' });

    assert.equal(captured[0].url, 'http://box:11434/api/chat');
  });

  it('surfaces an error reported inside a 200 body', async () => {
    stubFetch([{ json: { error: 'model not found' } }]);
    await assert.rejects(
      createLlmClient(config()).chat({ system: 'S', user: 'U' }),
      /model not found/,
    );
  });

  it('needs no API key', () => {
    assert.doesNotThrow(() => createLlmClient(config({ apiKey: '' })));
  });
});

describe('openai adapter', () => {
  const openai = config({
    provider: 'openai',
    host: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
  });

  it('posts to /chat/completions with a Bearer key and a json_schema format', async () => {
    stubFetch([{ json: { choices: [{ message: { content: JSON.stringify(DRAFT) } }] } }]);

    const result = await createLlmClient(openai).chat({ system: 'SYS', user: 'USER', schema: SCHEMA });

    assert.deepEqual(result, DRAFT);
    assert.equal(captured[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(captured[0].headers.authorization, 'Bearer sk-test');
    assert.deepEqual(captured[0].body.response_format, {
      type: 'json_schema',
      json_schema: { name: 'analysis_draft', strict: true, schema: SCHEMA },
    });
    assert.deepEqual(captured[0].body.messages, [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' },
    ]);
    assert.equal(captured[0].body.max_tokens, 4096);
  });

  it('degrades to json_object when ENGINE_LLM_JSON_MODE=object', async () => {
    stubFetch([{ json: { choices: [{ message: { content: '{}' } }] } }]);

    await createLlmClient(config({ ...openai, jsonMode: 'object' }))
      .chat({ system: 'S', user: 'U', schema: SCHEMA });

    assert.deepEqual(captured[0].body.response_format, { type: 'json_object' });
  });

  it('never sends num_ctx — it has no OpenAI equivalent', async () => {
    stubFetch([{ json: { choices: [{ message: { content: '{}' } }] } }]);
    await createLlmClient(openai).chat({ system: 'S', user: 'U', numCtx: 4096 });

    assert.equal('num_ctx' in captured[0].body, false);
    assert.equal('options' in captured[0].body, false);
  });

  it('works against an OpenAI-compatible base URL', async () => {
    stubFetch([{ json: { choices: [{ message: { content: '{}' } }] } }]);
    await createLlmClient(config({ ...openai, host: 'https://openrouter.ai/api/v1' }))
      .chat({ system: 'S', user: 'U' });

    assert.equal(captured[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  });
});

describe('anthropic adapter', () => {
  const anthropic = config({
    provider: 'anthropic',
    host: 'https://api.anthropic.com',
    apiKey: 'sk-ant-test',
    model: 'claude-sonnet-5',
  });

  it('posts to /v1/messages with the versioned key header and a forced tool', async () => {
    stubFetch([{ json: { content: [{ type: 'tool_use', name: 'analysis_draft', input: DRAFT }] } }]);

    const result = await createLlmClient(anthropic).chat({ system: 'SYS', user: 'USER', schema: SCHEMA });

    assert.deepEqual(result, DRAFT);
    assert.equal(captured[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(captured[0].headers['x-api-key'], 'sk-ant-test');
    assert.equal(captured[0].headers['anthropic-version'], '2023-06-01');
    // system is a top-level parameter, NOT a message
    assert.equal(captured[0].body.system, 'SYS');
    assert.deepEqual(captured[0].body.messages, [{ role: 'user', content: 'USER' }]);
    assert.equal(captured[0].body.max_tokens, 4096);
    assert.deepEqual(captured[0].body.tool_choice, { type: 'tool', name: 'analysis_draft' });
    assert.deepEqual(
      (captured[0].body.tools as { input_schema: unknown }[])[0].input_schema,
      SCHEMA,
    );
  });

  it('falls back to the text block when the model answers in prose', async () => {
    stubFetch([{ json: { content: [{ type: 'text', text: JSON.stringify(DRAFT) }] } }]);

    const result = await createLlmClient(anthropic).chat({ system: 'S', user: 'U', schema: SCHEMA });

    assert.deepEqual(result, DRAFT);
  });

  it('omits tools entirely when no schema is requested', async () => {
    stubFetch([{ json: { content: [{ type: 'text', text: '{}' }] } }]);
    await createLlmClient(anthropic).chat({ system: 'S', user: 'U' });

    assert.equal('tools' in captured[0].body, false);
    assert.equal('tool_choice' in captured[0].body, false);
  });
});

describe('gemini adapter', () => {
  const gemini = config({
    provider: 'gemini',
    host: 'https://generativelanguage.googleapis.com',
    apiKey: 'g-test',
    model: 'gemini-2.5-flash',
  });

  it('posts to :generateContent with the key in a header, not the URL', async () => {
    stubFetch([{
      json: { candidates: [{ content: { parts: [{ text: JSON.stringify(DRAFT) }] } }] },
    }]);

    const result = await createLlmClient(gemini).chat({ system: 'SYS', user: 'USER', schema: SCHEMA });

    assert.deepEqual(result, DRAFT);
    assert.equal(
      captured[0].url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    assert.equal(captured[0].headers['x-goog-api-key'], 'g-test');
    assert.equal(captured[0].url.includes('g-test'), false);
    // The SDK normalises a bare system string into a Content, which carries a role.
    assert.deepEqual(captured[0].body.systemInstruction, { parts: [{ text: 'SYS' }], role: 'user' });
    assert.deepEqual(captured[0].body.contents, [{ role: 'user', parts: [{ text: 'USER' }] }]);
  });

  it('strips additionalProperties, which Gemini rejects', async () => {
    stubFetch([{ json: { candidates: [{ content: { parts: [{ text: '{}' }] } }] } }]);
    await createLlmClient(gemini).chat({ system: 'S', user: 'U', schema: SCHEMA });

    const generationConfig = captured[0].body.generationConfig as Record<string, unknown>;
    assert.equal(generationConfig.responseMimeType, 'application/json');
    assert.equal(JSON.stringify(generationConfig.responseSchema).includes('additionalProperties'), false);
    // ...without losing anything else. Types come back upper-cased because the SDK
    // maps them onto Gemini's OpenAPI `Type` enum on the way out.
    assert.deepEqual(generationConfig.responseSchema, {
      type: 'OBJECT',
      properties: { mainRequest: { type: 'ARRAY', items: { type: 'STRING' } } },
      required: ['mainRequest'],
    });
  });

  it('strips additionalProperties at every nesting depth', () => {
    const nested = {
      additionalProperties: false,
      properties: { a: { additionalProperties: false, items: [{ additionalProperties: true }] } },
    };
    assert.deepEqual(stripForGemini(nested), { properties: { a: { items: [{}] } } });
  });
});

describe('createLlmClient validation', () => {
  it('rejects a cloud provider with no API key before any request', async () => {
    stubFetch([{ json: {} }]);
    for (const provider of ['openai', 'anthropic', 'gemini'] as LlmProvider[]) {
      assert.throws(
        () => createLlmClient(config({ provider, model: 'm', apiKey: '' })),
        /ENGINE_LLM_API_KEY/,
        `${provider} should demand a key`,
      );
    }
    assert.equal(captured.length, 0);
  });

  it('rejects a cloud provider with no model', () => {
    assert.throws(
      () => createLlmClient(config({ provider: 'openai', model: '', apiKey: 'k' })),
      /ENGINE_LLM_MODEL/,
    );
  });
});

describe('shared retry behaviour', () => {
  it('retries a 500 and succeeds on the next attempt', async () => {
    stubFetch([
      { status: 500, text: 'boom' },
      { json: { message: { content: JSON.stringify(DRAFT) } } },
    ]);

    const result = await createLlmClient(config({ maxRetries: 1 })).chat({ system: 'S', user: 'U' });

    assert.deepEqual(result, DRAFT);
    assert.equal(captured.length, 2);
  });

  it('gives up once retries are exhausted', async () => {
    stubFetch([{ status: 429, text: 'slow down' }]);

    await assert.rejects(
      createLlmClient(config({ maxRetries: 1 })).chat({ system: 'S', user: 'U' }),
      /429/,
    );
    assert.equal(captured.length, 2);
  });

  it('does not retry a 400', async () => {
    stubFetch([{ status: 400, text: 'bad request' }]);

    await assert.rejects(
      createLlmClient(config({ maxRetries: 2 })).chat({ system: 'S', user: 'U' }),
      /400/,
    );
    assert.equal(captured.length, 1);
  });
});

describe('llmSnapshot', () => {
  it('records provider/model/host and never the API key', () => {
    const snapshot = llmSnapshot(config({ provider: 'openai', apiKey: 'sk-secret-do-not-leak' }));

    assert.deepEqual(Object.keys(snapshot).sort(), ['host', 'model', 'provider']);
    assert.equal(JSON.stringify(snapshot).includes('sk-secret-do-not-leak'), false);
  });

  it('defaults to the ambient config', () => {
    assert.equal(llmSnapshot().provider, getLlmConfig().provider);
  });
});
