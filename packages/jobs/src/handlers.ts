import { InsufficientCreditsError, spendCredits } from '@shipwords/core/credits/ledger';
import { newId } from '@shipwords/core/db/client';
import { clientIp, errorResponse, ipBucket, json, readJson } from '@shipwords/core/http';
import { consumeQuota, dayWindow, releaseQuota } from '@shipwords/core/quota/counters';
import { ensureGuestId, readGuestId } from '@shipwords/core/quota/guest';
import type { Core } from '@shipwords/core/server';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  claimGuestJobs,
  loadJob,
  healStale as healStaleJob,
  isQualityRetryHoldError,
  isReviewPendingError,
  markFailed,
  qualityRetryHold,
  reviewPending,
  SKIPPED_UPSTREAM,
  type StoredOutput,
  spendKey,
  upstreamIds,
} from './lifecycle';
import { creditsFor, effectParts, type ModelDefinition, referenceRoleOf, sanitizeParameters } from './models';
import { type JobRow, jobs } from './schema';
import { createAdapters, type JobsEnv } from './workflow';

const MAX_PROMPT = 4000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const UPLOADS_PER_DAY = 40;
const RECAPTCHA_ACTION = 'generate';
const REVIEW_PENDING_MESSAGE =
  'Your previous video is being reviewed by our team for quality. You can start a new one as soon as that review is done (usually within 24 hours).';

interface CreateBody {
  modelId?: string;
  prompt?: string;
  /** Reference images: site file paths (/files/uploads/...) obtained from the upload endpoint first. */
  references?: string[];
  parameters?: Record<string, unknown>;
  /** Effects: slot ID → site path returned by the upload endpoint. */
  slots?: Record<string, unknown>;
  recaptchaToken?: string;
}

export function publicJob(job: JobRow, baseURL: string) {
  // Only delivered jobs expose outputs: a needs_review job has files in R2 that the customer must not get before a decision.
  const pending = job.status === 'needs_review';
  const outputs = job.outputsJson && !pending ? (JSON.parse(job.outputsJson) as StoredOutput[]) : [];
  return {
    id: job.id,
    modelId: job.modelId,
    status: job.status,
    prompt: job.prompt,
    costCredits: job.costCredits,
    outputs: outputs.map((output) => ({
      url: `${baseURL}/files/${output.key}`,
      mediaType: output.mediaType,
    })),
    error: job.errorCode && !pending ? { code: job.errorCode, message: job.errorMessage } : null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

function withCookie(response: Response, setCookie: string | null): Response {
  if (setCookie) response.headers.append('set-cookie', setCookie);
  return response;
}

export function createJobs(core: Core, models: readonly ModelDefinition[]) {
  const env = () => core.env as unknown as JobsEnv & { GUEST_COOKIE_SECRET: string; APP_URL?: string };
  const baseURL = () => (env().APP_URL ?? core.site.url).replace(/\/$/, '');

  /** Identity of the current request: signed-in user, or a guest with a signed cookie. Signed-in users also claim this device's guest jobs. */
  async function identity(request: Request) {
    const [user, guestId] = await Promise.all([
      core.getUser(request),
      readGuestId(request.headers, core.site.id, env().GUEST_COOKIE_SECRET),
    ]);
    if (user && guestId) await claimGuestJobs(core.db, guestId, user.id);
    return { user, guestId };
  }

  /**
   * Fallback: if the Workflow exits unexpectedly the job stays in progress. Jobs still unfinished after the model timeout plus 15 minutes
   * are marked failed and refunded when the user views them, so no cron is needed.
   */
  /** Stale in-progress jobs are failed and refunded on read (no cron needed); needs_review is left alone. See lifecycle.healStale. */
  async function healStale(job: JobRow): Promise<JobRow> {
    const model = models.find((m) => m.id === job.modelId);
    return healStaleJob(core.db, job, model?.timeoutMinutes, Date.now(), core.log);
  }

  async function ownedJob(request: Request, jobId: string) {
    const { user, guestId } = await identity(request);
    const found = await loadJob(core.db, jobId);
    const job = found ? await healStale(found) : null;
    if (!job) return null;
    if (user && job.userId === user.id) return job;
    if (guestId && job.guestId === guestId && !job.userId) return job;
    return null;
  }

  /** Only accept files uploaded to this site, so users can't make the upstream fetch arbitrary URLs. Returns the public URL, or null if invalid. */
  function uploadUrl(ref: unknown): string | null {
    if (typeof ref !== 'string') return null;
    const prefix = `${baseURL()}/files/uploads/`;
    const path = ref.startsWith('/files/uploads/') ? `${baseURL()}${ref}` : ref;
    if (!path.startsWith(prefix) || !/^[a-z0-9_]+\.(png|jpg|webp)$/.test(path.slice(prefix.length)))
      return null;
    return path;
  }

  function resolveReferences(model: ModelDefinition, refs: unknown): string[] | null {
    if (refs === undefined) return [];
    if (!Array.isArray(refs) || refs.length > model.maxReferences) return null;
    const urls: string[] = [];
    for (const ref of refs) {
      const url = uploadUrl(ref);
      if (!url) return null;
      urls.push(url);
    }
    return urls;
  }

  async function dispatch(job: JobRow): Promise<Response | null> {
    try {
      await env().GENERATION_WORKFLOW.create({ id: job.id, params: { jobId: job.id } });
      return null;
    } catch (error) {
      core.log('workflow dispatch failed', { jobId: job.id, error: String(error) });
      await markFailed(core.db, job.id, 'failed', 'dispatch_failed', 'could not start the job');
      return errorResponse(503, 'dispatch_failed', 'Could not start the job, please try again.');
    }
  }

  return {
    models,

    /** POST /api/jobs */
    async create(request: Request): Promise<Response> {
      const body = await readJson<CreateBody>(request);
      const model = models.find((m) => m.id === body?.modelId);
      if (!body || !model) return errorResponse(400, 'unknown_model');
      let prompt: string;
      let parameters: Record<string, unknown>;
      let inputJson: string;
      if (model.effect) {
        // Effect prompts stay server-side: the prompt column is an empty string, so publicJob never exposes it.
        const parts = effectParts(model, body.slots, uploadUrl, (key) => `${baseURL()}/files/${key}`);
        if (!parts) return errorResponse(400, 'invalid_slots');
        prompt = '';
        parameters = {};
        inputJson = JSON.stringify({ parts });
      } else {
        prompt = (body.prompt ?? '').trim();
        if (!prompt || prompt.length > MAX_PROMPT) return errorResponse(400, 'invalid_prompt');
        const references = resolveReferences(model, body.references);
        if (!references) return errorResponse(400, 'invalid_references');
        parameters = sanitizeParameters(model, body.parameters);
        const role = referenceRoleOf(model);
        inputJson = JSON.stringify({ references: references.map((url) => ({ url, role })), parameters });
      }
      const jobId = newId('job');
      const user = await core.getUser(request);

      if (user) {
        const cost = creditsFor(model, parameters);
        if (cost > 0 && (await reviewPending(core.db, user.id, model.id))) {
          return errorResponse(409, 'review_pending', REVIEW_PENDING_MESSAGE);
        }
        if (cost > 0 && await qualityRetryHold(core.db, user.id, model.id)) {
          return errorResponse(409, 'quality_review_required',
            'Your previous video needs a manual review. Your credits are safe; please contact support before trying again.');
        }
        const row = {
          id: jobId,
          userId: user.id,
          modelId: model.id,
          kind: model.kind,
          prompt,
          inputJson,
          costCredits: cost,
          upstream: model.upstream,
        };
        try {
          // Charge and job creation share one batch: either both happen or neither does.
          if (cost > 0) {
            await spendCredits(
              core.db,
              { userId: user.id, amount: cost, idemKey: spendKey(jobId), ref: jobId },
              [core.db.insert(jobs).values(row)],
            );
          } else {
            await core.db.insert(jobs).values(row);
          }
        } catch (error) {
          if (isReviewPendingError(error)) return errorResponse(409, 'review_pending', REVIEW_PENDING_MESSAGE);
          if (isQualityRetryHoldError(error)) {
            return errorResponse(409, 'quality_review_required',
              'Your previous video needs a manual review. Your credits are safe; please contact support before trying again.');
          }
          if (error instanceof InsufficientCreditsError) {
            return errorResponse(402, 'insufficient_credits', 'Not enough credits.', {
              required: error.required,
              available: error.available,
            });
          }
          throw error;
        }
        const job = (await loadJob(core.db, jobId))!;
        return (await dispatch(job)) ?? json({ job: publicJob(job, baseURL()) }, { status: 201 });
      }

      if (!model.guest) return errorResponse(401, 'login_required', 'Sign in to use this model.');
      const decision = await core.guest.authorize(request, body.recaptchaToken, RECAPTCHA_ACTION);
      if (!decision.ok) {
        return withCookie(
          errorResponse(401, 'login_required', 'Sign in to keep generating.', { reason: decision.reason }),
          decision.setCookie,
        );
      }
      await core.db
        .insert(jobs)
        .values({
          id: jobId,
          guestId: decision.guestId,
          modelId: model.id,
          kind: model.kind,
          prompt,
          inputJson,
          costCredits: 0,
          quotaJson: JSON.stringify(decision.rules),
          upstream: model.upstream,
        })
        .catch(async (error) => {
          // Quota was taken but the job wasn't created: give it back, or repeated failures would drain the daily guest budget.
          await releaseQuota(core.db, decision.rules);
          throw error;
        });
      const job = (await loadJob(core.db, jobId))!;
      const failed = await dispatch(job);
      return withCookie(
        failed ?? json({ job: publicJob(job, baseURL()) }, { status: 201 }),
        decision.setCookie,
      );
    },

    /** GET /api/jobs/<id> */
    async get(request: Request, jobId: string): Promise<Response> {
      const job = await ownedJob(request, jobId);
      return job ? json({ job: publicJob(job, baseURL()) }) : errorResponse(404, 'job_not_found');
    },

    /** GET /api/jobs: recent jobs, to resume in-flight jobs after a refresh and show history. */
    async list(request: Request): Promise<Response> {
      const { user, guestId } = await identity(request);
      if (!user && !guestId) return json({ jobs: [] });
      const owner = user ? eq(jobs.userId, user.id) : and(eq(jobs.guestId, guestId!), isNull(jobs.userId));
      const rows = await core.db.select().from(jobs).where(owner).orderBy(desc(jobs.createdAt)).limit(30);
      const healed = await Promise.all(rows.map(healStale));
      return json({ jobs: healed.map((row) => publicJob(row, baseURL())) });
    },

    /** POST /api/jobs/<id>/cancel */
    async cancel(request: Request, jobId: string): Promise<Response> {
      const job = await ownedJob(request, jobId);
      if (!job) return errorResponse(404, 'job_not_found');
      // Once Yir has the task we pay for it even if canceled; a refunded cancel would let one user burn upstream spend in a loop.
      if (job.status === 'submitted' || job.upstreamJobId)
        return errorResponse(409, 'not_cancellable', 'This video is already rendering and can no longer be canceled.');
      const updated = await markFailed(core.db, jobId, 'canceled', 'canceled', 'canceled by user');
      if (updated?.status === 'canceled') {
        await env()
          .GENERATION_WORKFLOW.get(jobId)
          .then((instance) => instance.terminate())
          .catch(() => undefined);
        // createAdapters throws when the mock is misconfigured; nothing real was submitted then, so there is nothing to cancel.
        const adapter = (() => {
          try {
            return createAdapters(env())[job.upstream];
          } catch {
            return undefined;
          }
        })();
        // The job read before canceling may not list every segment yet; use the record after canceling so a just-submitted segment isn't missed.
        const ids = upstreamIds(updated).filter((id) => !id.startsWith(SKIPPED_UPSTREAM));
        if (adapter) await Promise.all(ids.map((id) => adapter.cancel(id).catch(() => undefined)));
      }
      return json({ job: updated ? publicJob(updated, baseURL()) : null });
    },

    /** POST /api/uploads: upload one reference image, returns a site path. Open to users and guests, rate-limited per IP per day. */
    async upload(request: Request): Promise<Response> {
      const user = await core.getUser(request);
      const guest = user
        ? null
        : await ensureGuestId(request.headers, core.site.id, env().GUEST_COOKIE_SECRET);
      const ip = clientIp(request.headers);
      const owner = user ? `user:${user.id}` : `guest:${guest!.guestId}`;
      const allowed = await consumeQuota(core.db, [
        { key: `upload:${owner}`, window: dayWindow(), limit: UPLOADS_PER_DAY },
        ...(ip
          ? [{ key: `upload:ip:${ipBucket(ip)}`, window: dayWindow(), limit: UPLOADS_PER_DAY * 2 }]
          : []),
      ]);
      if (!allowed) return errorResponse(429, 'upload_limit');
      const type = request.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (!UPLOAD_TYPES.has(type)) return errorResponse(415, 'unsupported_type');
      const length = Number(request.headers.get('content-length') ?? '0');
      if (!length || length > MAX_UPLOAD_BYTES) return errorResponse(413, 'too_large');
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > MAX_UPLOAD_BYTES) return errorResponse(413, 'too_large');
      const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      const key = `uploads/${newId('up')}.${ext}`;
      await env().OUTPUTS.put(key, bytes, { httpMetadata: { contentType: type } });
      return withCookie(
        json({ path: `/files/${key}`, url: `${baseURL()}/files/${key}` }, { status: 201 }),
        guest?.setCookie ?? null,
      );
    },

    /** GET /files/<key>: read outputs and uploads from R2. Keys contain a random ID and can't be enumerated. */
    async file(_request: Request, key: string): Promise<Response> {
      // assets/ holds site-provided assets (effect reference videos etc.); file names are chosen by the site, read-only.
      if (
        !/^(jobs\/job_[a-z0-9]+\/\d+\.[a-z0-9]+|uploads\/up_[a-z0-9]+\.(png|jpg|webp)|assets\/[a-z0-9][a-z0-9/_-]*\.(mp4|mp3|png|jpg|webp))$/.test(
          key,
        ) ||
        key.includes('..')
      ) {
        return errorResponse(404, 'not_found');
      }
      // Outputs are only served after the job succeeds: if a cancel lands between "stored" and "marked succeeded", the user was refunded and must not get the result.
      const jobId = key.startsWith('jobs/') ? key.split('/')[1] : null;
      if (jobId && (await loadJob(core.db, jobId))?.status !== 'succeeded')
        return errorResponse(404, 'not_found');
      const object = await env().OUTPUTS.get(key);
      if (!object) return errorResponse(404, 'not_found');
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('cache-control', 'public, max-age=31536000, immutable');
      return new Response(object.body, { headers });
    },
  };
}

export type Jobs = ReturnType<typeof createJobs>;
