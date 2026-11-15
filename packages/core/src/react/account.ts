import { useCallback, useEffect, useState } from 'react';

// Headless hooks for account data (balance, subscription, orders) and checkout, with no styling.

export interface AccountData {
  user: { id: string; email: string; name: string };
  balance: { available: number; debt: number; nextExpiry: { at: number; amount: number } | null };
  subscription: {
    productId: string;
    status: string;
    currentPeriodEnd: number | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  orders: {
    id: string;
    productId: string;
    amount: number;
    currency: string;
    status: string;
    createdAt: number;
    /** Amount actually paid for the first period; lower than amount (list price) when a promo code was used. Smallest currency unit. */
    amountPaid: number;
    /** Amount refunded on the first period (smallest currency unit). */
    amountRefunded: number;
    dispute: 'open' | 'won' | 'lost' | null;
  }[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: { code: string; message: string } & Record<string, unknown>;
  };
  if (!response.ok) {
    throw new ApiError(
      data.error?.message ?? 'Request failed',
      data.error?.code,
      response.status,
      data.error ?? {},
    );
  }
  return data;
}

/** Current user's account data; data is null when signed out. */
export function useAccount() {
  const [data, setData] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/billing/me');
      setData(response.ok ? ((await response.json()) as AccountData) : null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, loading, refresh };
}

/** Starts checkout and redirects to the hosted payment page. Callers should prompt sign-in first when signed out, and may pass the contact email collected at checkout. */
export function useCheckout() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checkout = useCallback(async (productId: string, returnPath?: string, email?: string) => {
    setPending(productId);
    setError(null);
    try {
      const { url } = await postJson<{ url: string }>('/api/billing/checkout', { productId, returnPath, email });
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout failed');
      setPending(null);
    }
  }, []);
  return { checkout, pending, error };
}

export async function openBillingPortal(returnPath = '/account') {
  const { url } = await postJson<{ url: string }>('/api/billing/portal', { returnPath });
  window.location.assign(url);
}

/** Checkout return page: actively syncs order status until paid or timed out. */
export async function waitForOrder(orderId: string, timeoutMs = 30_000): Promise<'paid' | 'pending'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status } = await postJson<{ status: string }>('/api/billing/sync', { orderId });
    if (status === 'paid') return 'paid';
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return 'pending';
}
