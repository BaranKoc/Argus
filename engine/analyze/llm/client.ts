export interface ChatRequest {
  system: string;
  user: string;
  schema?: Record<string, unknown>;
  numCtx?: number;
}

export interface LlmClient {
  chat(request: ChatRequest): Promise<unknown>;
}
