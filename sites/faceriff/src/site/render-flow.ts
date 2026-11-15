/**
 * Decide what the Render button should do. A free 5-second preview starts first;
 * paying to unlock the full video happens after the preview is ready.
 * Guests can start the free preview without signing in. Checkout still collects
 * an email and requires a session so credits can be granted.
 */
export type RenderDecision =
  | 'need_photo'
  | 'need_consent'
  | 'confirm_another'
  | 'start';

export function decideRender(input: {
  ownPhotoCount: number;
  consent: boolean;
  rendering: boolean;
  confirmAnother: boolean;
}): RenderDecision {
  if (input.ownPhotoCount <= 0) return 'need_photo';
  if (!input.consent) return 'need_consent';
  if (input.rendering && !input.confirmAnother) return 'confirm_another';
  return 'start';
}

export type UnlockDecision = 'wait_account' | 'open_pricing' | 'start';

/** After a preview is ready: spend credits or open checkout (email is collected there). */
export function decideUnlock(input: {
  signedIn: boolean;
  accountLoading: boolean;
  availableCredits: number | null;
  costCredits: number;
}): UnlockDecision {
  if (!input.signedIn) return 'open_pricing';
  if (input.accountLoading && input.availableCredits == null) return 'wait_account';
  if (input.availableCredits == null) return 'start';
  if (input.availableCredits < input.costCredits) return 'open_pricing';
  return 'start';
}
