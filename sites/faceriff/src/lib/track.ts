// Custom events. Existing Rybbit names are unchanged so current funnels keep working.
// The 8 conversion events (home_view, upload_photo, render_click, signin_open,
// pay_panel_view, pay_success, gen_fail, manual_review_submit) also go to gtag,
// Umami (when present) and a first-party /api/track log the admin can read.
// The Rybbit script loads with defer, so events before load are queued and sent after;
// local dev never loads it, so Rybbit events stay queued. First-party POSTs still run.

import { isConversionEvent } from './conversion-event-names';

type Props = Record<string, string | number | boolean>;
type Rybbit = { event(name: string, props?: Props): void; identify?(userId: string): void };
type AnalyticsWindow = Window & {
  gtag?: (command: 'event', name: string, props?: Props) => void;
  umami?: { track: (name: string, props?: Props) => void };
  rybbit?: Rybbit;
};

const queue: (() => void)[] = [];
let waiting = false;

function client(): AnalyticsWindow | undefined {
  return typeof window === 'undefined' ? undefined : (window as AnalyticsWindow);
}

function rybbit(): Rybbit | undefined {
  return client()?.rybbit;
}

function flush() {
  const api = rybbit();
  if (!api) return false;
  for (const send of queue.splice(0)) send();
  return true;
}

function later(send: () => void) {
  queue.push(send);
  if (waiting || flush()) return;
  waiting = true;
  let tries = 0;
  const timer = setInterval(() => {
    if (flush() || ++tries > 30) {
      clearInterval(timer);
      waiting = false;
    }
  }, 500);
}

function persistFirstParty(name: string, props?: Props) {
  if (!isConversionEvent(name) || typeof window === 'undefined') return;
  const body = JSON.stringify({ name, props: props ?? {} });
  try {
    if (navigator.sendBeacon?.('/api/track', new Blob([body], { type: 'application/json' }))) return;
  } catch {
    // fall through to fetch
  }
  void fetch('/api/track', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
    credentials: 'same-origin',
  }).catch(() => undefined);
}

export function track(name: string, props?: Props) {
  if (typeof window === 'undefined') return;
  const w = client()!;
  w.gtag?.('event', name, props);
  w.umami?.track(name, props);
  later(() => rybbit()?.event(name, props));
  persistFirstParty(name, props);
}

let identified: string | null = null;

/** After sign-in, link the visitor session to the user id (no email). */
export function identify(userId: string) {
  if (typeof window === 'undefined' || identified === userId) return;
  identified = userId;
  later(() => rybbit()?.identify?.(userId));
}
