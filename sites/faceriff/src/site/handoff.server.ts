import { env } from 'cloudflare:workers';

// Relay for uploading photos from a phone by QR code: desktop opens a pairing code, the phone uploads via /api/uploads as usual and registers the path under the code;
// desktop polls and fills empty slots. Stored in R2 (OUTPUTS) under handoff/<code>/: meta holds the creation time, and each photo is an empty object
// with the path encoded in its key, so one prefix list returns everything, with no object reads and no concurrent writes to one object.

const TTL_MS = 30 * 60 * 1000;
const MAX_ITEMS = 20;
const TOKEN = /^[a-f0-9]{32}$/;
const UPLOAD_PATH = /^\/files\/uploads\/(up_[a-z0-9]+\.(?:png|jpg|webp))$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
const fail = (status: number, code: string) => json({ error: { code, message: code } }, status);

async function expiresAt(token: string): Promise<number | null> {
  if (!TOKEN.test(token)) return null;
  const meta = await env.OUTPUTS.head(`handoff/${token}/meta`);
  const created = Number(meta?.customMetadata?.created ?? 0);
  return created && Date.now() - created < TTL_MS ? created + TTL_MS : null;
}

async function items(token: string): Promise<string[]> {
  const list = await env.OUTPUTS.list({ prefix: `handoff/${token}/i-`, limit: MAX_ITEMS });
  return list.objects
    .map((object) =>
      object.key
        .split('/')
        .at(-1)!
        .replace(/^i-\d+-/, ''),
    )
    .map((name) => `/files/uploads/${name}`);
}

/** POST /api/handoff: desktop opens a pairing code. */
export async function createHandoff(): Promise<Response> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const created = Date.now();
  await env.OUTPUTS.put(`handoff/${token}/meta`, '', { customMetadata: { created: String(created) } });
  return json({ token, expiresAt: created + TTL_MS }, 201);
}

/** GET /api/handoff/<code>: photo paths sent from the phone, in upload order. */
export async function readHandoff(token: string): Promise<Response> {
  const expires = await expiresAt(token);
  if (!expires) return fail(404, 'handoff_expired');
  return json({ paths: await items(token), expiresAt: expires });
}

/** POST /api/handoff/<code> {path}: phone registers a photo it just uploaded. */
export async function addToHandoff(request: Request, token: string): Promise<Response> {
  if (!(await expiresAt(token))) return fail(404, 'handoff_expired');
  const body = (await request.json().catch(() => null)) as { path?: unknown } | null;
  const name = typeof body?.path === 'string' ? UPLOAD_PATH.exec(body.path)?.[1] : undefined;
  if (!name || !(await env.OUTPUTS.head(`uploads/${name}`))) return fail(400, 'invalid_path');
  if ((await items(token)).length >= MAX_ITEMS) return fail(429, 'handoff_full');
  await env.OUTPUTS.put(`handoff/${token}/i-${String(Date.now()).padStart(13, '0')}-${name}`, '');
  return json({ ok: true }, 201);
}
