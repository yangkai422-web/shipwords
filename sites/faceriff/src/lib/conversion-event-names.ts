/** Funnel events persisted first-party and forwarded to gtag/Umami when present. */
export const CONVERSION_EVENTS = [
  'home_view',
  'upload_photo',
  'render_click',
  'signin_open',
  'pay_panel_view',
  'pay_success',
  'gen_fail',
  'manual_review_submit',
] as const;

export type ConversionEventName = (typeof CONVERSION_EVENTS)[number];

const NAMES = new Set<string>(CONVERSION_EVENTS);

export function isConversionEvent(name: string): name is ConversionEventName {
  return NAMES.has(name);
}
