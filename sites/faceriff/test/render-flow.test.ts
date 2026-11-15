import { describe, expect, it } from 'vitest';
import { decideRender } from '../src/site/render-flow';
import { assignOpenSeats, isHeic, isSupportedImage } from '../src/site/image';

const base = {
  ownPhotoCount: 1,
  consent: true,
  rendering: false,
  confirmAnother: false,
  signedIn: false,
  accountLoading: false,
  availableCredits: null as number | null,
  costCredits: 10,
};

describe('decideRender', () => {
  it('blocks a paid render when no photo of yours is on the stage', () => {
    expect(decideRender({ ...base, ownPhotoCount: 0 })).toBe('need_photo');
  });

  it('asks for consent and another-job confirmation before payment', () => {
    expect(decideRender({ ...base, consent: false })).toBe('need_consent');
    expect(decideRender({ ...base, signedIn: true, availableCredits: 20, rendering: true })).toBe(
      'confirm_another',
    );
  });

  it('opens the pack dialog for signed-out visitors instead of sign-in', () => {
    expect(decideRender(base)).toBe('open_pricing');
  });

  it('lets a signed-in user with enough credits render, otherwise opens packs', () => {
    expect(decideRender({ ...base, signedIn: true, availableCredits: 10 })).toBe('start');
    expect(decideRender({ ...base, signedIn: true, availableCredits: 9 })).toBe('open_pricing');
  });

  it('waits for account data, then falls back to generate if the account request failed', () => {
    expect(decideRender({ ...base, signedIn: true, accountLoading: true, availableCredits: null })).toBe(
      'wait_account',
    );
    expect(decideRender({ ...base, signedIn: true, accountLoading: false, availableCredits: null })).toBe(
      'start',
    );
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
