/**
 * Decide what the Render button should do. Pack selection comes before sign-in;
 * paying still requires a session until guest checkout exists in @shipwords/core.
 */
export type RenderDecision =
  | 'need_photo'
  | 'need_consent'
  | 'confirm_another'
  | 'wait_account'
  | 'open_pricing'
  | 'start';

export function decideRender(input: {
  ownPhotoCount: number;
  consent: boolean;
  rendering: boolean;
  confirmAnother: boolean;
  signedIn: boolean;
  accountLoading: boolean;
  availableCredits: number | null;
  costCredits: number;
}): RenderDecision {
  if (input.ownPhotoCount <= 0) return 'need_photo';
  if (!input.consent) return 'need_consent';
  if (input.rendering && !input.confirmAnother) return 'confirm_another';
  if (!input.signedIn) return 'open_pricing';
  if (input.accountLoading && input.availableCredits == null) return 'wait_account';
  if (input.availableCredits == null) return 'start';
  if (input.availableCredits < input.costCredits) return 'open_pricing';
  return 'start';
}
