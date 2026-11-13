import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { handleAdminRequest } from '../src/lib/admin.server';
import {
  handleTrackRequest,
  isConversionEvent,
  loadConversionEvents,
  recordConversionEvent,
  sanitizeProps,
} from '../src/lib/conversion-events';
import { shanghaiDay } from '../src/lib/admin-data';

const owner = { email: 'owner@example.com', emailVerified: true };
const adminEnv = { DB: env.DB, OUTPUTS: env.OUTPUTS, ADMIN_EMAILS: owner.email };

describe('conversion event helpers', () => {
  it('allows only the eight funnel names', () => {
    expect(isConversionEvent('home_view')).toBe(true);
    expect(isConversionEvent('manual_review_submit')).toBe(true);
    expect(isConversionEvent('photo_added')).toBe(false);
    expect(isConversionEvent('payment_confirmed')).toBe(false);
  });

  it('drops unsafe or oversized props', () => {
    expect(sanitizeProps({ source: 'generate', reason: 'timeout', faces: 2, ok: true })).toEqual({
      source: 'generate',
      reason: 'timeout',
      faces: 2,
      ok: true,
    });
    expect(sanitizeProps({ 'bad key': 'x', email: 'a@b.c' })).toEqual({ email: 'a@b.c' });
    expect(sanitizeProps({ note: 'n'.repeat(200) }).note).toHaveLength(120);
    expect(sanitizeProps(['no'])).toEqual({});
  });
});

describe('POST /api/track', () => {
  it('ignores other paths and rejects bad input', async () => {
    expect(await handleTrackRequest(new Request('https://faceriff.com/api/jobs'), { DB: env.DB })).toBeNull();
    const wrong = await handleTrackRequest(
      new Request('https://faceriff.com/api/track', { method: 'GET' }),
      { DB: env.DB },
    );
    expect(wrong?.status).toBe(405);
    const unknown = await handleTrackRequest(
      new Request('https://faceriff.com/api/track', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'photo_added' }),
      }),
      { DB: env.DB },
    );
    expect(unknown?.status).toBe(400);
  });

  it('stores allowed events and honours dedupe keys', async () => {
    const ok = await handleTrackRequest(
      new Request('https://faceriff.com/api/track', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'home_view', props: { source: 'test' } }),
      }),
      { DB: env.DB },
    );
    expect(ok?.status).toBe(204);
    await recordConversionEvent(env.DB, {
      name: 'pay_success',
      props: { order: 'ord_1' },
      dedupeKey: 'ord_1',
    });
    await recordConversionEvent(env.DB, {
      name: 'pay_success',
      props: { order: 'ord_1' },
      dedupeKey: 'ord_1',
    });
    const snap = await loadConversionEvents(env.DB);
    expect(snap.day).toBe(shanghaiDay(Date.now()));
    expect(snap.counts.find((c) => c.name === 'home_view')?.n).toBeGreaterThanOrEqual(1);
    expect(snap.counts.find((c) => c.name === 'pay_success')?.n).toBe(1);
  });
});

describe('admin conversion section', () => {
  it('shows today counts on the dashboard', async () => {
    await recordConversionEvent(env.DB, { name: 'render_click', props: { faces: 1 } });
    const r = await handleAdminRequest(new Request('https://faceriff.com/admin'), adminEnv, async () => owner);
    const page = (await r?.text()) ?? '';
    expect(page).toContain('转化事件（今日');
    expect(page).toContain('点击渲染');
  });
});
