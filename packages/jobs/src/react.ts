import { ApiError, postJson } from '@shipwords/core/react/account';
import { getRecaptchaToken } from '@shipwords/core/react/recaptcha';
import { useCallback, useEffect, useRef, useState } from 'react';

// Headless hooks for generation jobs: submit, poll to completion, resume in-flight jobs after a refresh. Styling and layout are up to the site.

export interface PublicJob {
  id: string;
  modelId: string;
  /** needs_review: rendered, waiting for a human quality decision; no outputs until it is approved. */
  status: 'queued' | 'submitted' | 'needs_review' | 'succeeded' | 'failed' | 'canceled';
  prompt: string;
  costCredits: number;
  outputs: { url: string; mediaType: string }[];
  error: { code: string; message: string | null } | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface GenerateInput {
  modelId: string;
  /** Required for regular models; effects don't accept a prompt. */
  prompt?: string;
  references?: string[];
  parameters?: Record<string, unknown>;
  /** Effects: slot ID → path returned by uploadReference. */
  slots?: Record<string, string>;
}

const isActive = (job: PublicJob) => job.status === 'queued' || job.status === 'submitted';
const POLL_MS = 2500;

export async function uploadReference(file: File): Promise<string> {
  const response = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'content-type': file.type },
    body: file,
  });
  const data = (await response.json()) as { path?: string; error?: { code: string; message: string } };
  if (!response.ok || !data.path) {
    throw new ApiError(data.error?.message ?? 'Upload failed', data.error?.code, response.status, {});
  }
  return data.path;
}

/**
 * jobs: recent jobs (newest first); generate: submit a job.
 * When error.code is login_required, prompt sign-in; when insufficient_credits, prompt a purchase.
 */
export function useGeneration(options: { recaptchaSiteKey: string | null }) {
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const upsert = useCallback((job: PublicJob) => {
    setJobs((list) =>
      [job, ...list.filter((item) => item.id !== job.id)].sort((a, b) => b.createdAt - a.createdAt),
    );
  }, []);

  const watch = useCallback(
    (jobId: string) => {
      if (timers.current.has(jobId)) return;
      const tick = async () => {
        try {
          const response = await fetch(`/api/jobs/${jobId}`);
          if (response.ok) {
            const { job } = (await response.json()) as { job: PublicJob };
            upsert(job);
            if (!isActive(job)) {
              timers.current.delete(jobId);
              return;
            }
          }
        } catch {
          // Keep polling through network blips.
        }
        timers.current.set(jobId, setTimeout(tick, POLL_MS));
      };
      timers.current.set(jobId, setTimeout(tick, POLL_MS));
    },
    [upsert],
  );

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/jobs')
      .then((response) => (response.ok ? response.json() : { jobs: [] }))
      .then((value) => {
        const data = value as { jobs: PublicJob[] };
        if (cancelled) return;
        setJobs(data.jobs);
        for (const job of data.jobs) if (isActive(job)) watch(job.id);
      })
      .catch(() => undefined);
    const pending = timers.current;
    return () => {
      cancelled = true;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, [watch]);

  const generate = useCallback(
    async (input: GenerateInput) => {
      setSubmitting(true);
      setError(null);
      try {
        const recaptchaToken = options.recaptchaSiteKey
          ? await getRecaptchaToken(options.recaptchaSiteKey, 'generate')
          : null;
        const { job } = await postJson<{ job: PublicJob }>('/api/jobs', { ...input, recaptchaToken });
        upsert(job);
        watch(job.id);
        return job;
      } catch (e) {
        setError(e instanceof ApiError ? e : new ApiError(String(e), undefined, 0, {}));
        return null;
      } finally {
        setSubmitting(false);
      }
    },
    [options.recaptchaSiteKey, upsert, watch],
  );

  const cancel = useCallback(
    async (jobId: string) => {
      const { job } = await postJson<{ job: PublicJob | null }>(`/api/jobs/${jobId}/cancel`, {});
      if (job) upsert(job);
    },
    [upsert],
  );

  return { jobs, generate, cancel, submitting, error, clearError: () => setError(null) };
}
