import { describe, expect, it } from 'vitest';
import models from '../site.models';
import { listedProducts, productById, shouldShowThreePackUpsell } from '../src/site/packs';
import { decideRender } from '../src/site/render-flow';

describe('catalog', () => {
  it('adds a $2.99 one-time trial without changing the $9.88 or $24.88 packs', () => {
    const trial = productById('video_trial');
    const one = productById('video_1');
    const three = productById('video_3');
    const ten = productById('video_10');

    expect(trial).toMatchObject({
      id: 'video_trial',
      kind: 'credits',
      credits: 10,
      limitPerUser: 1,
      price: { amount: 299, currency: 'usd' },
    });
    expect(one).toMatchObject({
      id: 'video_1',
      kind: 'credits',
      credits: 10,
      price: { amount: 988, currency: 'usd' },
    });
    expect(one && 'limitPerUser' in one && one.limitPerUser).toBeFalsy();
    expect(three).toMatchObject({
      id: 'video_3',
      kind: 'credits',
      credits: 30,
      price: { amount: 2488, currency: 'usd' },
    });
    expect(ten).toMatchObject({
      id: 'video_10',
      kind: 'credits',
      credits: 100,
      price: { amount: 5988, currency: 'usd' },
    });
    expect(models.find((model) => model.id === 'tiny-desk')).toMatchObject({ credits: 10, guest: false });
  });
});

describe('listedProducts', () => {
  it('shows the trial first, then hides it after a purchase or on a used device', () => {
    const visible = listedProducts().map((product) => product.id);
    expect(visible[0]).toBe('video_trial');
    expect(visible).toEqual(['video_trial', 'video_1', 'video_3', 'video_10']);

    expect(listedProducts({ unavailableProductIds: ['video_trial'] }).map((product) => product.id)).toEqual([
      'video_1',
      'video_3',
      'video_10',
    ]);
    expect(listedProducts({ deviceTrialUsed: true }).map((product) => product.id)).toEqual([
      'video_1',
      'video_3',
      'video_10',
    ]);
  });
});

describe('three-pack upsell', () => {
  it('appears on a finished full video, not on a preview or an in-progress job', () => {
    expect(shouldShowThreePackUpsell({ isPreview: false, hasOutput: true })).toBe(true);
    expect(shouldShowThreePackUpsell({ isPreview: true, hasOutput: true })).toBe(false);
    expect(shouldShowThreePackUpsell({ isPreview: false, hasOutput: false })).toBe(false);
  });
});

describe('0-photo guard', () => {
  it('still blocks a render when no photo of yours is on the stage', () => {
    expect(decideRender({ ownPhotoCount: 0, consent: true, rendering: false, confirmAnother: false })).toBe(
      'need_photo',
    );
  });
});
