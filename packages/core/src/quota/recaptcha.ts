// Server-side verification for reCAPTCHA v3 (Google Cloud reCAPTCHA, score-based).
// The client loads https://www.google.com/recaptcha/enterprise.js?render=<site key>
// and calls grecaptcha.enterprise.execute(siteKey, { action }) for a token when the user clicks generate.

export interface RecaptchaConfig {
  siteKey: string;
  projectId: string;
  apiKey: string;
}

export type RecaptchaResult =
  | { ok: true; score: number }
  | {
      ok: false;
      reason: 'missing_token' | 'invalid_token' | 'action_mismatch' | 'low_score' | 'unavailable';
      score?: number;
    };

interface Assessment {
  tokenProperties?: { valid?: boolean; invalidReason?: string; action?: string };
  riskAnalysis?: { score?: number };
}

export async function verifyRecaptcha(
  config: RecaptchaConfig,
  token: string | null | undefined,
  expectedAction: string,
  minScore: number,
  fetcher: typeof fetch = fetch,
): Promise<RecaptchaResult> {
  // When keys are unset (common in local/dev), skip captcha and rely on the guest quota counters.
  if (!config.siteKey || !config.projectId || !config.apiKey) return { ok: true, score: 1 };
  if (!token) return { ok: false, reason: 'missing_token' };
  const url = `https://recaptchaenterprise.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/assessments?key=${encodeURIComponent(config.apiKey)}`;
  let assessment: Assessment;
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: { token, siteKey: config.siteKey, expectedAction } }),
    });
    if (!response.ok) return { ok: false, reason: 'unavailable' };
    assessment = (await response.json()) as Assessment;
  } catch {
    // Treat Google being unavailable as a failure: the guest must sign in to generate; don't let it through.
    return { ok: false, reason: 'unavailable' };
  }
  if (!assessment.tokenProperties?.valid) return { ok: false, reason: 'invalid_token' };
  if (assessment.tokenProperties.action !== expectedAction) return { ok: false, reason: 'action_mismatch' };
  const score = assessment.riskAnalysis?.score ?? 0;
  if (score < minScore) return { ok: false, reason: 'low_score', score };
  return { ok: true, score };
}
