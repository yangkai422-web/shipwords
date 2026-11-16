import site from '../../site.config';

/** The $9.88 single-video pack is the price anchor. Look it up by id, never by array index. */
export const ANCHOR_PRODUCT_ID = 'video_1';
export const THREE_PACK_ID = 'video_3';
export const TRIAL_PRODUCT_ID = 'video_trial';

const PLAN_ORDER = [TRIAL_PRODUCT_ID, ANCHOR_PRODUCT_ID, THREE_PACK_ID, 'video_10'];

/** Soft, device-level hide for the one-time trial after a purchase on this browser. */
export const TRIAL_DEVICE_KEY = 'faceriff:trial_purchased';

export function productById(id: string) {
  return site.products.find((product) => product.id === id);
}

export const anchorProduct = productById(ANCHOR_PRODUCT_ID);
export const threePack = productById(THREE_PACK_ID);
export const trialProduct = productById(TRIAL_PRODUCT_ID);

export function readDeviceTrialUsed(): boolean {
  try {
    return localStorage.getItem(TRIAL_DEVICE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markDeviceTrialUsed(): void {
  try {
    localStorage.setItem(TRIAL_DEVICE_KEY, '1');
  } catch {
    // Private mode should not break checkout return or pricing.
  }
}

export function listedProducts(
  opts: { unavailableProductIds?: readonly string[]; deviceTrialUsed?: boolean } = {},
) {
  const hidden = new Set(opts.unavailableProductIds);
  if (opts.deviceTrialUsed) hidden.add(TRIAL_PRODUCT_ID);
  const visible = site.products.filter((product) => !hidden.has(product.id));
  return [...visible].sort((a, b) => {
    const ai = PLAN_ORDER.indexOf(a.id);
    const bi = PLAN_ORDER.indexOf(b.id);
    return (ai === -1 ? PLAN_ORDER.length : ai) - (bi === -1 ? PLAN_ORDER.length : bi);
  });
}

/** The $24.88 three-pack upsell belongs on a finished full video, not on the free preview. */
export function shouldShowThreePackUpsell(input: { isPreview: boolean; hasOutput: boolean }): boolean {
  return !input.isPreview && input.hasOutput;
}
