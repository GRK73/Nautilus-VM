import type { CreateParams, MessageResponse, MessagesClient } from './loop.ts';

export interface AnthropicClientOptions {
  apiKey: string;
  model: string;
  maxTokens?: number;
  baseUrl?: string;
}

/**
 * A MessagesClient backed by the Anthropic Messages API over plain fetch —
 * no SDK dependency. Keeps the whole project dependency-free.
 */
export function createAnthropicClient(opts: AnthropicClientOptions): MessagesClient {
  const base = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  return {
    async create(params: CreateParams): Promise<MessageResponse> {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: opts.maxTokens ?? 4096,
          system: params.system,
          tools: params.tools,
          messages: params.messages,
        }),
      });
      if (!res.ok) {
        throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);
      }
      return (await res.json()) as MessageResponse;
    },
  };
}
