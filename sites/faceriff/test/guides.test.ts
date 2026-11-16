import { describe, expect, it } from 'vitest';
import site from '../site.config';
import { pageKey } from '../src/lib/realtime';
import { GUIDE_PATHS, SITEMAP_PAGES } from '../src/site/guide-paths';
import { ANCHOR_PRODUCT_ID, getAnchorProduct, getProduct, listedProducts, THREE_PACK_ID } from '../src/site/packs';

function formatUsd(product: { price: { amount: number; currency: string } }) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: product.price.currency }).format(
    product.price.amount / 100,
  );
}

describe('public anchor price', () => {
  it('is the $9.88 video_1 pack even when the $2.99 trial is listed first', () => {
    const trialFirst = listedProducts();
    expect(trialFirst[0]?.id).toBe('video_trial');
    expect(trialFirst[0]?.price).toEqual({ amount: 299, currency: 'usd' });

    const reordered = [...site.products].sort((a, b) => Number(b.id === 'video_trial') - Number(a.id === 'video_trial'));
    expect(reordered[0]?.id).toBe('video_trial');

    const anchor = getAnchorProduct();
    expect(anchor).toMatchObject({ id: ANCHOR_PRODUCT_ID, price: { amount: 988, currency: 'usd' } });
    expect(formatUsd(anchor)).toBe('$9.88');
    expect(formatUsd(reordered[0]!)).toBe('$2.99');
    expect(formatUsd({ price: { amount: getProduct(THREE_PACK_ID).price.amount / 3, currency: 'usd' } })).not.toBe(
      formatUsd(anchor),
    );
  });
});

describe('/tiny-desk-template', () => {
  it('is a registered guide route and does not replace the longer template URL', () => {
    expect(GUIDE_PATHS).toContain('/tiny-desk-template');
    expect(GUIDE_PATHS).toContain('/outstanding-tiny-desk-ai-template');
    expect(new Set(GUIDE_PATHS).size).toBe(GUIDE_PATHS.length);
  });

  it('is in the sitemap and the public page allowlist', () => {
    expect(SITEMAP_PAGES).toContain('/tiny-desk-template');
    expect(SITEMAP_PAGES).toContain('/outstanding-tiny-desk-ai-template');
    expect(pageKey('/tiny-desk-template')).toBe('/tiny-desk-template');
    expect(pageKey('/outstanding-tiny-desk-ai-template')).toBe('/outstanding-tiny-desk-ai-template');
  });
});
