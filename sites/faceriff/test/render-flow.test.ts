import { describe, expect, it } from 'vitest';
import { decideRender, decideUnlock } from '../src/site/render-flow';
import { assignOpenSeats, isHeic, isSupportedImage } from '../src/site/image';

const base = {
  ownPhotoCount: 1,
  consent: true,
  rendering: false,
  confirmAnother: false,
  signedIn: false,
};

describe('decideRender', () => {
  it('blocks a preview when no photo of yours is on the stage', () => {
    expect(decideRender({ ...base, ownPhotoCount: 0 })).toBe('need_photo');
  });

  it('asks for consent and another-job confirmation before starting a preview', () => {
    expect(decideRender({ ...base, consent: false })).toBe('need_consent');
    expect(decideRender({ ...base, signedIn: true, rendering: true })).toBe('confirm_another');
  });

  it('asks signed-out visitors to sign in instead of opening packs', () => {
    expect(decideRender(base)).toBe('need_signin');
  });

  it('starts a free preview for a signed-in user even without credits', () => {
    expect(decideRender({ ...base, signedIn: true })).toBe('start');
  });
});

describe('decideUnlock', () => {
  const unlock = {
    signedIn: true,
    accountLoading: false,
    availableCredits: 10 as number | null,
    costCredits: 10,
  };

  it('opens packs when the signed-in user does not have enough credits', () => {
    expect(decideUnlock({ ...unlock, availableCredits: 9 })).toBe('open_pricing');
    expect(decideUnlock({ ...unlock, signedIn: false, availableCredits: 0 })).toBe('need_signin');
  });

  it('spends a credit after the preview when the balance is enough', () => {
    expect(decideUnlock(unlock)).toBe('start');
  });

  it('waits for account data, then falls back to generate if the account request failed', () => {
    expect(decideUnlock({ ...unlock, accountLoading: true, availableCredits: null })).toBe(
      'wait_account',
    );
    expect(decideUnlock({ ...unlock, accountLoading: false, availableCredits: null })).toBe('start');
  });
});

describe('image helpers', () => {
  it('accepts HEIC by type or extension and regular photos', () => {
    expect(isHeic({ type: 'image/heic', name: 'IMG_1.HEIC' })).toBe(true);
    expect(isHeic({ type: '', name: 'photo.heif' })).toBe(true);
    expect(isSupportedImage({ type: 'image/jpeg', name: 'a.jpg' })).toBe(true);
    expect(isSupportedImage({ type: '', name: 'IMG_2.heic' })).toBe(true);
    expect(isSupportedImage({ type: 'application/pdf', name: 'x.pdf' })).toBe(false);
  });

  it('assigns a batch of photos to open seats in order, up to five', () => {
    expect(assignOpenSeats(['lead', 'sax', 'keys'], ['a', 'b', 'c', 'd'])).toEqual([
      { slotId: 'lead', file: 'a' },
      { slotId: 'sax', file: 'b' },
      { slotId: 'keys', file: 'c' },
    ]);
    expect(assignOpenSeats(['lead'], [])).toEqual([]);
  });
});
