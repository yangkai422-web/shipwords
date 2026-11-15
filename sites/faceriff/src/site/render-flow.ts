/**
 * Decide what the Render button should do. A free 5-second preview starts first;
 * paying to unlock the full video happens after the preview is ready.
 * Sign-in is still required until guest checkout exists in @shipwords/core.
 */
export type RenderDecision =
  | 'need_photo'
  | 'need_consent'
  | 'confirm_another'
  | 'need_signin'
  | 'start';

export function decideRender(input: {
  ownPhotoCount: number;
  consent: boolean;
  rendering: boolean;
  confirmAnother: boolean;
  signedIn: boolean;
}): RenderDecision {
  if (input.ownPhotoCount <= 0) return 'need_photo';
  if (!input.consent) return 'need_consent';
  if (input.rendering && !input.confirmAnother) return 'confirm_another';
  if (!input.signedIn) return 'need_signin';
  return 'start';
}

export type UnlockDecision = 'need_signin' | 'wait_account' | 'open_pricing' | 'start';

/** After a preview is ready: spend credits or open the existing checkout. */
export function decideUnlock(input: {
  signedIn: boolean;
  accountLoading: boolean;
  availableCredits: number | null;
  costCredits: number;
}): UnlockDecision {
  if (!input.signedIn) return 'need_signin';
  if (input.accountLoading && input.availableCredits == null) return 'wait_account';
  if (input.availableCredits == null) return 'start';
  if (input.availableCredits < input.costCredits) return 'open_pricing';
  return 'start';
}
