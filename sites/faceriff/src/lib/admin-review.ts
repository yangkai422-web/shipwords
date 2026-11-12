import { createDb } from '@shipwords/core/db/client';
import { emailOnFinish } from '@shipwords/jobs/notify';
import { approveReview, type ReviewResult, rejectReview } from '@shipwords/jobs/review';
import type { ReviewInfo, ReviewNote } from '@shipwords/jobs/runner';
import site from '../../site.config';
import models from '../../site.models';
import { type AdminEnv, type AdminUser, escapeHtml, secureHeaders, shanghaiTime } from './admin.server';

// Owner review queue (/admin/review): jobs the runner held in needs_review. Server-rendered, no scripts (CSP default-src 'none');
// confirmations are a second page with a POST form, protected by the admin session plus a same-origin check.

const DAY = 86_400_000;
const JOB_ID = /^job_[a-z0-9]+$/;
const MAX_FORM = 1024;

// Inline <video> needs media-src; forms need the Origin header, which no-referrer turns into "null" on POST.
// A function, not a constant: admin.server imports this module, so its exports aren't initialised yet at load time.
const pageHeaders = () => ({
  ...secureHeaders,
  'content-security-policy': `${secureHeaders['content-security-policy']}; media-src 'self'`,
  'referrer-policy': 'same-origin',
  'content-type': 'text/html; charset=utf-8',
});
const page = (title: string, body: string, status = 200, head = false) =>
  new Response(
    head
      ? null
      : `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>FaceRiff · ${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`,
    { status, headers: pageHeaders() },
  );
const STYLE =
  '*{box-sizing:border-box}body{margin:0;background:#0b1020;color:#eef0ff;font:14px/1.65 system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:28px 20px}a{color:#ff839a}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:28px 0 10px}.muted,p{color:#aeb5d4}.item{background:#151b33;border:1px solid #eef0ff1f;border-radius:14px;padding:18px;margin:16px 0;display:grid;grid-template-columns:minmax(0,320px) 1fr;gap:20px}video{width:100%;max-height:560px;background:#000;border-radius:10px}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}dt{color:#aeb5d4}dd{margin:0;word-break:break-all}table{border-collapse:collapse;width:100%;margin:8px 0;background:#10162a}th,td{padding:6px 10px;border-bottom:1px solid #eef0ff16;text-align:left;font-variant-numeric:tabular-nums;white-space:nowrap}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:14px}.button{display:inline-block;padding:10px 16px;border-radius:8px;text-decoration:none;color:#fff;border:0;font:inherit;cursor:pointer}.ok{background:#3a7d44}.no{background:#b3364f}.ghost{background:#2a3150}.badge{padding:2px 8px;border-radius:6px;background:#3b3450;color:#ffe5a1}.bad{background:#4c2435;color:#ff9aaf}.good{background:#263c2c;color:#c6f432}.notice{border-left:3px solid #c6f432;background:#151b33;padding:12px 16px;margin:16px 0}.warn{border-left-color:#ff4d6d}@media(max-width:800px){.item{grid-template-columns:1fr}}';

export interface PendingReview {
  id: string;
  email: string | null;
  modelId: string;
  createdAt: number;
  finishedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  reviewJson: string | null;
  outputsJson: string | null;
  costCredits: number;
}
export interface ReviewHistory {
  jobId: string;
  action: string;
  adminEmail: string;
  previousCode: string | null;
  decidedAt: number;
  modelId: string;
  email: string | null;
  status: string;
}

export async function loadReviewQueue(db: D1Database, now = Date.now()) {
  const [pending, history] = await db.batch<Record<string, unknown>>([
    db.prepare(
      `SELECT j.id,u.email,j.model_id modelId,j.created_at createdAt,j.finished_at finishedAt,j.error_code errorCode,
      j.error_message errorMessage,j.review_json reviewJson,j.outputs_json outputsJson,j.cost_credits costCredits
      FROM jobs j LEFT JOIN user u ON u.id=j.user_id WHERE j.status='needs_review' ORDER BY j.created_at ASC LIMIT 200`,
    ),
    db
      .prepare(
        `SELECT r.job_id jobId,r.action,r.admin_email adminEmail,r.previous_code previousCode,r.created_at decidedAt,
        j.model_id modelId,u.email,j.status FROM job_reviews r JOIN jobs j ON j.id=r.job_id LEFT JOIN user u ON u.id=j.user_id
        WHERE r.created_at>=? ORDER BY r.created_at DESC LIMIT 200`,
      )
      .bind(now - 30 * DAY),
  ]);
  return {
    pending: (pending?.results ?? []) as unknown as PendingReview[],
    history: (history?.results ?? []) as unknown as ReviewHistory[],
  };
}

const reasonLabel: Record<string, string> = {
  review_swap_fail: '人脸检测明确失败：疑似仍是原脸',
  review_grey: '人脸检测灰区：不能确定是否换脸成功',
  review_check_error: '人脸检测服务不可用，未能自动判断',
  review_compose_failed: '合成失败：预览的是 Yir 原片（无原曲音轨、镜头未对齐）',
};
const noteLabel: Record<ReviewNote['reason'], string> = {
  swap_fail: '明确失败',
  grey: '灰区',
  check_error: '检测不可用',
};
const verdictLabel: Record<string, string> = { pass: '通过', review: '灰区', fail: '失败' };

function parse<T>(json: string | null): T | null {
  try {
    return json ? (JSON.parse(json) as T) : null;
  } catch {
    return null;
  }
}

function modelInfo(modelId: string) {
  const model = models.find((m) => m.id === modelId);
  const labels = new Map<string, string>((model?.effect?.slots ?? []).map((slot) => [slot.id, slot.label]));
  return { name: model?.name ?? modelId, label: (slot: string) => labels.get(slot) ?? slot };
}

function renderNote(note: ReviewNote, label: (slot: string) => string): string {
  const head = `<p><strong>片段 ${escapeHtml(note.part)}</strong> · ${escapeHtml(noteLabel[note.reason] ?? note.reason)} · 阈值 ${escapeHtml(note.threshold)}（相似度 ≥ 阈值 = 原脸仍在）</p>`;
  if (note.reason === 'check_error')
    return `${head}<p class="muted">错误：${escapeHtml(note.error ?? '未知')}</p>`;
  const roles = note.quality?.roles;
  const rows = (note.scores ?? []).map((score, i) => {
    const role = roles?.find((r) => r.index === i);
    const slot = note.slots?.[i];
    return `<tr><td>${escapeHtml(slot ? label(slot) : `#${i + 1}`)}</td><td>${escapeHtml(score.toFixed(3))}</td><td>${role ? `<span class="badge ${role.verdict === 'fail' ? 'bad' : role.verdict === 'pass' ? 'good' : ''}">${escapeHtml(verdictLabel[role.verdict] ?? role.verdict)}</span>` : score >= note.threshold ? '<span class="badge bad">超阈值</span>' : '—'}</td><td>${role ? `${role.peak.toFixed(3)}` : '—'}</td><td>${role ? `${role.strong}/${role.valid}（可见 ${role.visible}）` : '—'}</td><td>${role ? role.longestStrongRun : '—'}</td></tr>`;
  });
  return `${head}<table><thead><tr><th>角色</th><th>相似度</th><th>判定</th><th>峰值</th><th>强匹配帧/有效帧</th><th>最长连续强匹配</th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="6">无分数</td></tr>'}</tbody></table>`;
}

export function renderReviewPage(
  data: Awaited<ReturnType<typeof loadReviewQueue>>,
  flash: { done?: string | null; job?: string | null } = {},
): string {
  const doneText: Record<string, string> = {
    approved: '已通过并交付，客户会收到成片邮件。',
    rejected: '已拒绝并退回积分，客户会收到失败邮件。',
    approved_nomail: '已通过并交付，但给客户的邮件发送失败，请手动通知客户。',
    rejected_nomail: '已拒绝并退回积分，但给客户的邮件发送失败，请手动通知客户。',
    noop: '这个任务之前已经处理过，没有重复操作。',
    error: '操作没有完成：任务不存在或已不在待审核状态。',
  };
  const notice =
    flash.done && doneText[flash.done]
      ? `<div class="notice${flash.done === 'error' || flash.done.endsWith('_nomail') ? ' warn' : ''}">${escapeHtml(flash.job ?? '')} ${escapeHtml(doneText[flash.done])}</div>`
      : '';
  const items = data.pending.map((job) => {
    const review = parse<ReviewInfo>(job.reviewJson);
    const { name, label } = modelInfo(job.modelId);
    const composed = review?.composed ?? false;
    const video = `/api/admin/review-video?job=${encodeURIComponent(job.id)}`;
    const raw = review?.rawKey && composed ? ` · <a href="${video}&amp;v=raw">看 Yir 原片</a>` : '';
    return `<section class="item" id="${escapeHtml(job.id)}"><div><video src="${video}" controls playsinline preload="metadata"></video><p class="muted">${composed ? '预览：合成后的成片' : '预览：Yir 原片（合成未完成）'}${raw}</p></div><div>
    <dl><dt>任务</dt><dd>${escapeHtml(job.id)}</dd><dt>客户邮箱</dt><dd>${escapeHtml(job.email ?? '访客 / 已删除账号')}</dd><dt>模板</dt><dd>${escapeHtml(name)}（${escapeHtml(job.modelId)}）</dd><dt>创建</dt><dd>${escapeHtml(shanghaiTime(job.createdAt))}（北京时间）</dd><dt>进入审核</dt><dd>${escapeHtml(shanghaiTime(job.finishedAt))}（北京时间）</dd><dt>原因</dt><dd>${escapeHtml(reasonLabel[job.errorCode ?? ''] ?? job.errorCode ?? '—')}</dd><dt>积分</dt><dd>${escapeHtml(job.costCredits)}（已扣，审核前不退）</dd></dl>
    ${(review?.notes ?? []).map((note) => renderNote(note, label)).join('')}
    ${review?.composeError ? `<p class="muted">合成错误：${escapeHtml(review.composeError)}${composed ? '' : '。通过后交付的是 Yir 原片。'}</p>` : ''}
    <div class="actions"><a class="button ok" href="/admin/review/confirm?job=${encodeURIComponent(job.id)}&amp;action=approve">通过并交付</a><a class="button no" href="/admin/review/confirm?job=${encodeURIComponent(job.id)}&amp;action=reject">拒绝并退积分</a></div></div></section>`;
  });
  const history = data.history
    .map(
      (h) =>
        `<tr><td>${escapeHtml(shanghaiTime(h.decidedAt))}</td><td>${escapeHtml(h.jobId)}</td><td>${escapeHtml(h.email ?? '—')}</td><td>${escapeHtml(h.modelId)}</td><td><span class="badge ${h.action === 'approved' ? 'good' : 'bad'}">${h.action === 'approved' ? '通过并交付' : '拒绝并退积分'}</span></td><td>${escapeHtml(reasonLabel[h.previousCode ?? ''] ?? h.previousCode ?? '—')}</td><td>${escapeHtml(h.adminEmail)}</td></tr>`,
    )
    .join('');
  return `<header><a href="/admin">← 返回经营后台</a><h1>待审核任务 <span class="badge ${data.pending.length ? 'bad' : 'good'}">${data.pending.length}</span></h1><p>人脸检测没有明确通过、或合成失败的视频会停在这里：不自动交付、不自动退积分，客户看到「审核中，24 小时内邮件通知」，且审核结束前不能再下同一模板的付费单。时间均为北京时间。</p></header>${notice}
  ${items.join('') || '<div class="notice">目前没有待审核任务。</div>'}
  <h2>最近 30 天审核记录</h2><table><thead><tr><th>处理时间</th><th>任务</th><th>客户</th><th>模板</th><th>结果</th><th>当时原因</th><th>操作人</th></tr></thead><tbody>${history || '<tr><td colspan="7">暂无记录</td></tr>'}</tbody></table>`;
}

function renderConfirm(job: PendingReview, action: 'approve' | 'reject'): string {
  const approve = action === 'approve';
  return `<h1>${approve ? '确认通过并交付？' : '确认拒绝并退积分？'}</h1>
  <div class="notice${approve ? '' : ' warn'}">${approve ? '客户将可以下载这条视频，并收到「视频已完成」邮件；积分保持已扣。' : `将退回 ${escapeHtml(job.costCredits)} 积分（只退一次），客户会收到「生成失败、积分已退回」邮件，之后可以重新下单。`}</div>
  <dl><dt>任务</dt><dd>${escapeHtml(job.id)}</dd><dt>客户邮箱</dt><dd>${escapeHtml(job.email ?? '—')}</dd><dt>原因</dt><dd>${escapeHtml(reasonLabel[job.errorCode ?? ''] ?? job.errorCode ?? '—')}</dd></dl>
  <form method="post" action="/admin/review/action" class="actions"><input type="hidden" name="job" value="${escapeHtml(job.id)}"><input type="hidden" name="action" value="${action}"><button type="submit" class="button ${approve ? 'ok' : 'no'}">${approve ? '确认通过并交付' : '确认拒绝并退积分'}</button><a class="button ghost" href="/admin/review#${escapeHtml(job.id)}">取消</a></form>`;
}

async function loadPending(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT j.id,u.email,j.model_id modelId,j.created_at createdAt,j.finished_at finishedAt,j.error_code errorCode,
      j.error_message errorMessage,j.review_json reviewJson,j.outputs_json outputsJson,j.cost_credits costCredits,j.status
      FROM jobs j LEFT JOIN user u ON u.id=j.user_id WHERE j.id=?`,
    )
    .bind(id)
    .first<PendingReview & { status: string }>();
}

/** Stream a held (or previously held) job's video inline, with Range support for seeking. Keys are confined to jobs/<id>/N.mp4|webm. */
async function reviewVideo(request: Request, env: AdminEnv, url: URL): Promise<Response> {
  const id = url.searchParams.get('job') ?? '';
  const notFound = () => new Response('Not found', { status: 404, headers: secureHeaders });
  if (!JOB_ID.test(id)) return notFound();
  const job = await env.DB.prepare('SELECT outputs_json,review_json FROM jobs WHERE id=?')
    .bind(id)
    .first<{ outputs_json: string | null; review_json: string | null }>();
  const review = parse<ReviewInfo>(job?.review_json ?? null);
  if (!job || !review) return notFound();
  const outputs = parse<{ key?: unknown }[]>(job.outputs_json);
  const key =
    url.searchParams.get('v') === 'raw' ? review.rawKey : Array.isArray(outputs) ? outputs[0]?.key : null;
  if (typeof key !== 'string' || !new RegExp(`^jobs/${id}/[0-9]+\\.(mp4|webm)$`).test(key)) return notFound();
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
  let r2Range: R2Range | undefined;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      const offset = Number(range[1]);
      r2Range = range[2] ? { offset, length: Math.max(0, Number(range[2]) - offset + 1) } : { offset };
    } else r2Range = { suffix: Number(range[2]) };
  }
  const object = await env.OUTPUTS.get(key, r2Range ? { range: r2Range } : {});
  if (!object) return notFound();
  const headers = new Headers({
    ...secureHeaders,
    'content-type': key.endsWith('.webm') ? 'video/webm' : 'video/mp4',
    'content-disposition': `inline; filename="faceriff-review-${id}.mp4"`,
    'accept-ranges': 'bytes',
  });
  const body = request.method === 'HEAD' ? null : (object as R2ObjectBody).body;
  if (r2Range && object.range && 'offset' in object.range) {
    const start = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - start;
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
    return new Response(body, { status: 206, headers });
  }
  headers.set('content-length', String(object.size));
  return new Response(body, { headers });
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded')
    return null;
  if (Number(request.headers.get('content-length') ?? 0) > MAX_FORM) return null;
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_FORM) return null;
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

/** Same-origin browser form only: the admin session cookie alone is not enough for a state change. */
function sameOrigin(request: Request, url: URL): boolean {
  const site = request.headers.get('sec-fetch-site');
  return request.headers.get('origin') === url.origin && (site === null || site === 'same-origin');
}

function notifier(env: AdminEnv) {
  if (!env.EMAIL || !env.EMAIL_FROM) return undefined;
  return emailOnFinish({
    db: createDb(env.DB),
    email: env.EMAIL,
    from: env.EMAIL_FROM,
    site,
    baseURL: (env.APP_URL ?? site.url).replace(/\/$/, ''),
  });
}

/** Routes under /admin/review and /api/admin/review-video. Called only after the allowlist check. Returns null for other paths. */
export async function handleReviewRequest(
  request: Request,
  env: AdminEnv,
  user: AdminUser,
  url: URL,
): Promise<Response | null> {
  const head = request.method === 'HEAD';
  if (url.pathname === '/admin/review/action') {
    if (request.method !== 'POST')
      return new Response(null, { status: 405, headers: { ...secureHeaders, allow: 'POST' } });
    if (!sameOrigin(request, url)) return page('拒绝', '<h1>请求来源无效</h1><p>请从后台页面操作。</p>', 403);
    const form = await readForm(request);
    const id = form?.get('job') ?? '';
    const action = form?.get('action');
    if (!form || !JOB_ID.test(id) || (action !== 'approve' && action !== 'reject'))
      return page('无效请求', '<h1>无效请求</h1><p><a href="/admin/review">返回待审核任务</a></p>', 400);
    const db = createDb(env.DB);
    let result: ReviewResult;
    try {
      result =
        action === 'approve'
          ? await approveReview(db, id, user.email, notifier(env))
          : await rejectReview(db, id, user.email, notifier(env));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'admin_review_error',
          jobId: id,
          action,
          message: String(error).slice(0, 200),
        }),
      );
      return page(
        '暂时失败',
        '<h1>操作暂时失败</h1><p>可以安全地重试：同一个决定不会重复执行，积分也只会退一次。</p><p><a href="/admin/review">返回待审核任务</a></p>',
        503,
      );
    }
    const done = result.ok
      ? result.changed
        ? `${action === 'approve' ? 'approved' : 'rejected'}${result.emailed === false ? '_nomail' : ''}`
        : 'noop'
      : 'error';
    console.log(JSON.stringify({ event: 'admin_review_decision', jobId: id, action, outcome: done }));
    return new Response(null, {
      status: 303,
      headers: { ...secureHeaders, location: `/admin/review?done=${done}&job=${encodeURIComponent(id)}` },
    });
  }
  if (
    url.pathname === '/admin/review' ||
    url.pathname === '/admin/review/' ||
    url.pathname === '/admin/review/confirm' ||
    url.pathname === '/api/admin/review-video'
  ) {
    if (request.method !== 'GET' && !head)
      return new Response(null, { status: 405, headers: { ...secureHeaders, allow: 'GET, HEAD' } });
  } else return null;
  if (url.pathname === '/api/admin/review-video') return reviewVideo(request, env, url);
  if (url.pathname === '/admin/review/confirm') {
    const id = url.searchParams.get('job') ?? '';
    const action = url.searchParams.get('action');
    const job = JOB_ID.test(id) ? await loadPending(env.DB, id) : null;
    if (!job || (action !== 'approve' && action !== 'reject'))
      return page(
        '未找到',
        '<h1>未找到这个任务</h1><p><a href="/admin/review">返回待审核任务</a></p>',
        404,
        head,
      );
    if (job.status !== 'needs_review')
      return page(
        '已处理',
        `<h1>这个任务已经处理过</h1><p>当前状态：${escapeHtml(job.status)}。</p><p><a href="/admin/review">返回待审核任务</a></p>`,
        409,
        head,
      );
    return page('确认操作', renderConfirm(job, action), 200, head);
  }
  const data = await loadReviewQueue(env.DB);
  return page(
    '待审核任务',
    renderReviewPage(data, { done: url.searchParams.get('done'), job: url.searchParams.get('job') }),
    200,
    head,
  );
}
