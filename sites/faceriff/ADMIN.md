# FaceRiff owner dashboard

- Open `/login?next=%2Fadmin`, sign in with the verified owner email, then `/admin`.
- `ADMIN_EMAILS` is a comma-separated, case-insensitive **server-only Worker secret**. An empty/missing allowlist denies everyone. Never expose it in client public-config or commit its value. The production owner was confirmed against D1; only that account is allowed.
- GET/HEAD only; the Worker checks the existing better-auth session and verified email before sending HTML, JSON, or R2 outputs. Other users and logged-out requests receive 404. `Cache-Control: private, no-store`, noindex and frame-ancestors none are set.
- Endpoints: `/admin`, `/api/admin/dashboard`, `/api/admin/output?job=job_ID`. Output access is restricted to succeeded jobs and their own `jobs/job_ID/N.mp4|webm` R2 prefix. Photos, prompts, tokens and unmasked customer emails are never returned.

## Metrics

All dates and displayed times are Asia/Shanghai (UTC+8). Presets include today and the preceding 6/29 days; today is partial. Custom ranges are capped at 90 days.

- Visitors: successful browser HTML document requests, first-party HMAC-SHA256(IP + user-agent + Shanghai day), keyed using the existing auth secret with a separate analytics context. No cookie, raw IP, raw UA, path or cross-day identifier is stored. Known bots, admin, APIs, static files and prefetch are excluded. Daily deduplication uses the D1 composite primary key. SPA-only navigations are not additional document visits. Shared IP/UA can undercount; network changes can overcount.
- `daily_visitors` keeps a rolling 90-day window, cleaned on subsequent visits. Collection starts on the first tracked request after deployment (`analytics_meta.tracking_started_at`); earlier days show unavailable, not zero. Daily totals are summed UV, not cross-day distinct people.
- Cloudflare historical zone analytics are not imported: the existing Wrangler OAuth grants contain zone read but no Analytics read scope. Do not read OAuth token files to query Analytics. History starts with this implementation.
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

Work in the approved C-drive checkout, not the old D-drive copy. Run `pnpm install --frozen-lockfile`, site `pnpm typecheck`, `pnpm test`, `pnpm build`, and root `pnpm check:packages`. Site tests use isolated local D1/R2 and the actual migrations.

Use the site's installed Wrangler (4.153.0), account `62ffbf61f44b6e2e24c9c0d483181eec`, Worker `faceriff`. Do not use another Cloudflare account/MCP. Preserve the existing production secrets; `.dev.vars` values are not deployed automatically. `ADMIN_EMAILS` was uploaded additively as a Worker secret with the code; later deployments preserve it.

1. Save D1 Time Travel bookmark and schema, plus the current Worker version metadata in ignored `.wrangler/` before changes.
2. `pnpm exec wrangler d1 migrations list DB --remote`, then `pnpm exec wrangler d1 migrations apply DB --remote` for the additive analytics tables.
3. Build with the existing Vite plugin. It generates `dist/server/wrangler.json` and `.wrangler/deploy/config.json` pointing to this checkout. Never deploy the copied stale build from another path.
4. `pnpm exec wrangler deploy --dry-run --keep-vars --containers-rollout=immediate`.
5. `pnpm exec wrangler deploy --keep-vars --containers-rollout=immediate --message "Owner dashboard"`. For initial allowlist provisioning only, add a gitignored `--secrets-file` JSON containing `ADMIN_EMAILS`; never commit that file.
6. Check logged-out `/admin` and all admin APIs are 404/no-store; homepage, login, pricing and public config remain healthy. Verify visitors in D1 with no raw identifiers. Do not mint sessions or bypass owner sign-in for testing.
7. Commit only named source/migration/test/doc files and push `fork main` (`yangkai422-web/shipwords`), never origin/upstream. Leave unrelated e2e text files alone.

Rollback: the previous Worker version metadata is in the ignored deployment backup. Analytics migrations are additive; do not drop customer tables or roll back the live database merely to revert the page.