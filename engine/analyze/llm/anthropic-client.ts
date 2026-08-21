import Anthropic from '@anthropic-ai/sdk';
import type { LlmConfig } from '../../models.ts';
import type { ChatRequest, LlmClient } from './client.ts';
import { parseJsonContent, toProviderError } from './errors.ts';

const TOOL_NAME = 'analysis_draft';

// The official `@anthropic-ai/sdk`. It pins the `anthropic-version` header itself
// (that header is how the Messages API is versioned, and an unpinned client would
// silently change response shape on the server's schedule), which is one fewer
// constant for us to keep current.
export function createAnthropicClient(config: LlmConfig, signal?: AbortSignal): LlmClient {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.host.replace(/\/$/, ''),
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries,
  });

  return {
    async chat(request: ChatRequest): Promise<unknown> {
      // Anthropic has no response_format; forcing a single tool whose input_schema
      // is our JSON Schema is how you get a guaranteed-shaped object back. The
      // payoff is that `input` arrives already parsed, so there is no JSON.parse
      // step to fail on.
      const tools = request.schema
        ? [{
          name: TOOL_NAME,
          description: 'Toplantı analizinin dokuz bölümünü yapılandırılmış olarak döndürür.',
          input_schema: request.schema as Anthropic.Tool.InputSchema,
        }]
        : undefined;

      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model: config.model,
          // Required by the API — unlike every other provider here, omitting it is
          // a 400, which is why maxTokens is a first-class LlmConfig field.
          max_tokens: config.maxTokens,
          temperature: config.temperature,
          // System prompt is a top-level parameter, not a message with role 'system'.
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          ...(tools ? { tools, tool_choice: { type: 'tool' as const, name: TOOL_NAME } } : {}),
        }, { signal });
      } catch (error) {
        throw toProviderError(error, {
          providerLabel: 'Anthropic',
          host: config.host,
          timeoutMs: config.timeoutMs,
        });
      }

      const toolUse = message.content.find((block) => block.type === 'tool_use');
      if (toolUse?.input && typeof toolUse.input === 'object') return toolUse.input;

      // No tool_use block: either we sent no schema, or the model answered in prose.
      // Fall back to the text block so a recoverable answer isn't thrown away.
      const text = message.content.find((block) => block.type === 'text');
      return parseJsonContent(text?.text, 'Anthropic');
    },
  };
}
