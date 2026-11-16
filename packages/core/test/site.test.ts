import { describe, expect, it } from 'vitest';
import { defineSite } from '../src/site';

const base = {
  id: 'test',
  name: 'Test',
  url: 'https://test.example',
  locales: ['en'] as const,
  defaultLocale: 'en',
  products: [
    {
      id: 'pack',
      kind: 'credits' as const,
      name: 'Pack',
      price: { amount: 100, currency: 'usd' },
      credits: 10,
      expiresDays: null,
    },
  ],
  signup: { bonusCredits: 0, bonusExpiresDays: null, bonusPerIpDaily: 0 },
  guest: { dailyPerDevice: 1, dailyPerIp: 3, dailySiteBudget: 100, minRecaptchaScore: 0.5 },
  billing: { provider: 'paypal' as const },
};

describe('defineSite limitPerUser', () => {
  it('accepts a one-time credit pack', () => {
    const site = defineSite({
      ...base,
      products: [{ ...base.products[0]!, id: 'trial', limitPerUser: 1 }],
    });
    const trial = site.products[0];
    expect(trial?.kind === 'credits' && trial.limitPerUser).toBe(1);
  });

  it('rejects a non-positive limitPerUser', () => {
    expect(() =>
      defineSite({
        ...base,
        products: [{ ...base.products[0]!, limitPerUser: 0 }],
      }),
    ).toThrow(/limitPerUser/);
  });
});
