import { createNodeYirClient } from '@yir-ai/sdk/server';

export interface YirBalance {
  /** Decimal USD strings as returned by Yir; available/total can be negative after settlement. */
  available: string;
  held: string;
  total: string;
}

/** GET /v1/balance (Yir wallet snapshot) with the server-side API key. The key never leaves the Worker. */
export async function fetchYirBalance(options: {
  apiKey: string;
  baseURL?: string;
  signal?: AbortSignal;
}): Promise<YirBalance> {
  if (!options.apiKey) throw new Error('yir_not_configured');
  const client = createNodeYirClient({
    apiKey: options.apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });
  const b = await client.getBalance(options.signal ? { signal: options.signal } : undefined);
  return { available: b.available_amount, held: b.held_amount, total: b.total_amount };
}
