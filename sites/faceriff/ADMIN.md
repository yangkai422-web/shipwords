# FaceRiff owner dashboard

- Open `/login?next=%2Fadmin`, sign in with the verified owner email, then `/admin`.
- `ADMIN_EMAILS` is a comma-separated, case-insensitive **server-only Worker secret**. An empty/missing allowlist denies everyone. Never expose it in client public-config or commit its value. The production owner was confirmed against D1; only that account is allowed.
- GET/HEAD only; the Worker checks the existing better-auth session and verified email before sending HTML, JSON, or R2 outputs. Other users and logged-out requests receive 404. `Cache-Control: private, no-store`, noindex and frame-ancestors none are set.
- Endpoints: `/admin`, `/api/admin/dashboard`, `/api/admin/output?job=job_ID`. Output access is restricted to succeeded jobs and their own `jobs/job_ID/N.mp4|webm` R2 prefix. Photos, prompts, tokens and unmasked customer emails are never returned.

## Metrics

Business dates, first-party visitors and displayed timestamps use Asia/Shanghai (UTC+8). Cloudflare history is the explicit exception: its `day_utc` partitions remain UTC. Presets include today and the preceding 6/29 days; today is partial. Custom ranges are capped at 90 days.

- Visitors: successful browser HTML document requests, first-party HMAC-SHA256(IP + user-agent + Shanghai day), keyed using the existing auth secret with a separate analytics context. No cookie, raw IP, raw UA, path or cross-day identifier is stored. Known bots, admin, APIs, static files and prefetch are excluded. Daily deduplication uses the D1 composite primary key. SPA-only navigations are not additional document visits. Shared IP/UA can undercount; network changes can overcount.
- `daily_visitors` keeps a rolling 90-day window, cleaned on subsequent visits. Collection starts on the first tracked request after deployment (`analytics_meta.tracking_started_at`); earlier days use separately labelled Cloudflare history as a reference when present, otherwise unavailable (never invented zero). Daily totals are summed UV, not cross-day distinct people.
- Cloudflare history is imported separately into `cf_daily_traffic`, using `httpRequests1dGroups` (`uniq.uniques`, `sum.pageViews`, `sum.requests`) from the scoped Analytics:Read API token. The one-time backfill covers 2026-10-29 through 2026-11-11 UTC; the last day is an explicitly partial snapshot. The token was read only from the box environment, was not copied to susu or files, and is not a Worker secret. Wrangler continues using its existing deployment login. No scheduled refresh was added.
- Signups: `user.created_at`.
- Created orders: `orders.created_at`, including pending/expired orders. Paid orders and receipts: `orders.paid_at`, USD only; other currencies shown separately.
- Cash refunded: `payments.amount_refunded`, attributed back to the original order's paid date (not actual refund-event date). Values depend on payment webhook synchronization. This is separate from returned generation credits.
- Jobs and current outcome: `jobs.created_at`; `quality_review` is delivered but marked for review, not counted again as normal succeeded. Active = queued/submitted. Failed/canceled are separate. Counts update as jobs settle.
- Returned-credit jobs: an existing `credit_ledger` refund with `idem_key=refund:job:ID`. May overlap failures; not a cash refund.
- Yir generations: non-skipped IDs in `jobs.upstream_job_id`. Cost uses `upstream_cost_usd` when present, otherwise recorded generation count × $2.7378. An upstream charge accepted before its ID was persisted cannot be captured.
- Estimated difference = USD receipts − associated cumulative cash refunds − Yir cost. Includes test jobs/retries, excludes Cloudflare, payment fees, tax, etc.; not accounting profit or per-order gross margin.
- Recent lists are capped at 100 within the selected range. Orders buy credits; jobs have no `order_id`. The displayed same-account job counts are explicitly **not** order-to-video attribution.
- Quality holds include all historical failed `swap_not_applied` / `swap_not_applied_v2` jobs, grouped by account/template, matching the existing retry guard. No unlock or credit-changing actions are present.

## Development and production deployment

Work in the approved C-drive checkout, not the old D-drive copy. Run `pnpm install --frozen-lockfile`, site `pnpm typecheck`, `pnpm test`, `pnpm build`, and root `pnpm check:packages`. Site tests use isolated local D1/R2 and the actual site migrations directly (`vitest.config.ts` reads `migrations/`); there is no separate duplicated test migration tree.

Use the site's installed Wrangler (4.153.0), account `62ffbf61f44b6e2e24c9c0d483181eec`, Worker `faceriff`. Do not use another Cloudflare account/MCP. Preserve the existing production secrets; `.dev.vars` values are not deployed automatically. `ADMIN_EMAILS` was uploaded additively as a Worker secret with the code; later deployments preserve it.

1. Save D1 Time Travel bookmark and schema, plus the current Worker version metadata in ignored `.wrangler/` before changes.
2. `pnpm exec wrangler d1 migrations list DB --remote`, then `pnpm exec wrangler d1 migrations apply DB --remote` for the additive analytics tables.
3. Build with the existing Vite plugin. It generates `dist/server/wrangler.json` and `.wrangler/deploy/config.json` pointing to this checkout. Never deploy the copied stale build from another path.
4. `pnpm exec wrangler deploy --dry-run --keep-vars --containers-rollout=immediate`.
5. `pnpm exec wrangler deploy --keep-vars --containers-rollout=immediate --message "Owner dashboard"`. For initial allowlist provisioning only, add a gitignored `--secrets-file` JSON containing `ADMIN_EMAILS`; never commit that file.
6. Check logged-out `/admin` and all admin APIs are 404/no-store; homepage, login, pricing and public config remain healthy. Verify visitors in D1 with no raw identifiers. Do not mint sessions or bypass owner sign-in for testing.
7. Commit only named source/migration/test/doc files and push `fork main` (`yangkai422-web/shipwords`), never origin/upstream. Leave unrelated e2e text files alone.

Rollback: the previous Worker version metadata is in the ignored deployment backup. Analytics migrations are additive; do not drop customer tables or roll back the live database merely to revert the page.
## Cloudflare backfill semantics

- The daily reference column prefers `daily_visitors` (including a real zero) and otherwise uses the imported CF unique count. `daily.visitors` in the API remains first-party-only; `cfVisitors`, `cfPageViews` and `cfRequests` are separate fields. KPI totals for each source remain separate and are never added together.
- The same date string represents different windows: CF UTC 2026-11-10 is Shanghai 2026-11-10 08:00 through 2026-11-11 08:00. Daily zone aggregates cannot be correctly shifted by eight hours into exact Shanghai-day unique counts; no such conversion is attempted. Do not derive order conversion rates from these mismatched windows.
- CF zone traffic may include crawlers, threats, API calls, static assets, the admin and www hosts. Requests are not people; page views are not unique visitors; summed daily UV is not a cross-day unique population. The first-party launch day is also partial.
- `cfHistory` reports the imported range, dataset, latest fetch timestamp and partial UTC dates. Missing dates remain null; data outside the saved range is not assumed zero. Partial snapshots remain partial even after the calendar day has ended until a newer import replaces them.
- Metric SQL is kept in ignored `.wrangler/`, never mixed with schema migrations or committed. Its UPSERT is keyed by `day_utc`; only a same/newer fetch may replace a row, and a complete row cannot be downgraded to a partial snapshot. Imports never modify `daily_visitors` or `analytics_meta`.
- Apply the additive schema migration with the existing local Wrangler, then `pnpm exec wrangler d1 execute DB --remote --file .wrangler/<data-only-backfill>.sql`. Before/after counts and the previous deployment are backed up in `.wrangler/cf-history-backup-20261111/`. The production Worker only reads D1; dashboard visits do not call the Analytics API.
- Future refresh is optional. It would need separately provisioning the scoped token as a Worker secret through an approved secure path, plus a small scheduled fetch. This release intentionally does neither; first-party tracking continues normally after the historical backfill.


## Visitor dimensions (2026-11-11 upgrade)

- First-party dimensions begin with the first eligible request after this deployment; exact enable time is stored as analytics_meta.dimensions_started_at and displayed in Asia/Shanghai. Earlier UV cannot be enriched. A visitor already counted earlier that day is not counted again just to fill dimensions.
- Each new Shanghai-day pseudonym increments six marginal aggregate counters in daily_visitor_dimensions: country (request.cf.country only), device, OS family, browser family, normalized referrer platform, and utm_source. The aggregate increment and original dedup marker run in one serial atomic D1 batch. No dimensions are added to individual pseudonym rows; no raw IP/UA, full referrer, URL or path is saved. No cross-dimension profiles. The existing exclusions and HMAC are unchanged. Both first-party tables retain 90 rolling days.
- Device/OS/browser use coarse UA heuristics (iPad/mobile/desktop and major families). Country is network egress, not nationality; VPNs/proxies affect it. Missing/unknown buckets are explicit.
- Referer is reduced to an allowlisted platform (Google, X/Twitter, Product Hunt, Reddit etc.), internal, direct/missing, unknown or other; unknown raw domains/subdomains are never persisted. Internal navigation is not original acquisition. Browsers/apps may strip Referer. utm_source is independent, lowercased and limited to 40 safe campaign-label characters; URLs/emails/IPs/paths are redacted. Do not use personal information in campaign labels. These are first eligible document-visit attribution, not session/last-touch attribution.
- Imported CF dimensions are separate in cf_daily_dimensions by UTC day, dataset, dimension and value, with fetch timestamp and partial flag. countryMap from httpRequests1dGroups: 2026-10-29 through 2026-11-11 UTC (14 dates), 22,882 requests at this snapshot. httpRequestsAdaptiveGroups country/device/OS/browser each cover the same 14 UTC dates, 22,853 requests per dimension. This zone actually allowed the full requested range; do not infer a shorter retention from the plan name. Returned settings: notOlderThan=2678400s, maxDuration=2592000s. Nov 11 is partial; earlier days complete. These are request counts, NOT uniques or page views; may include bots/API/static/admin and sampling estimates. Different datasets/fetch times can differ and must never be added.
- clientRefererHost was denied for this zone by GraphQL (authz); no alternate gated field or raw URL was queried to evade this. No historical referrer data was imported. utm_source is not available in these aggregates; no historical UTM import. First-party source/UTM collection works going forward. No analytics token was copied to susu or deployed; it stayed in the box environment. No scheduled refresh.
- Selected-range source tables show up to 15 categories plus remaining categories combined, counts and percentage of the entire same-source/same-dimension total including unknowns. Chinese country names accompany codes. Dataset coverage and partial snapshots are shown explicitly. First-party and each CF dataset remain separate. Missing coverage is not zero.
- Site tests use canonical migrations directly. Re-run pnpm test and pnpm check before production deployment. Anonymous 404 is expected; use the normal owner email login, never mint sessions.
