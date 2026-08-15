# Changelog

All notable changes to the Situational Arbitrage Orchestrator (SAO) project.

---

## v2.0 — 2026-07-22

### Breaking Changes
- **Removed OpenAI dependency** — all LLM calls now use Groq (`llama-3.3-70b-versatile` for business plans, `llama-3.1-8b-instant` for classification)
- **Removed Anthropic dependency** — classification moved to Groq
- **Removed Firecrawl dependency** — replaced with self-hosted cheerio crawler
- **Removed Tavily dependency** — replaced with Google Programmable Search (100 free queries/day)
- **Removed WooCommerce integration** — replaced with `detectEcommerceGaps()` using Google Search + Groq
- **Removed Odoo integration** — replaced with `detectOperationalGaps()` using Google Search + Groq
- **Deleted files:** `firecrawlToGap.ts`, `tavilySearch.ts`, `woocommerce.ts`, `odoo.ts`
- **Removed env vars:** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `FIRECRAWL_API_KEY`, `TAVILY_API_KEY`, `WOOCOMMERCE_URL`, `WOOCOMMERCE_CONSUMER_KEY`, `WOOCOMMERCE_CONSUMER_SECRET`, `ODOO_URL`, `ODOO_DATABASE`, `ODOO_USERNAME`, `ODOO_PASSWORD`
- **Added env vars:** `GROQ_API_KEY`, `GOOGLE_SEARCH_API_KEY`, `GOOGLE_SEARCH_CX`

### Added
- `server/services/llm.ts` — Unified Groq LLM wrapper (`callLLM`, `callLLMJson`, model constants)
- `server/services/crawler.ts` — Self-hosted cheerio web crawler (`crawlUrl`, `extractGapsFromContent`, `crawlAndExtract`)
- `server/services/search.ts` — Google Custom Search + `detectEcommerceGaps()` + `detectOperationalGaps()` + `extractGapFromText()`
- `server/orchestrator.ts` — Auto-discovery: core loop now calls `detectEcommerceGaps()` + `detectOperationalGaps()` on each tick, queues new gaps with dedup via SHA-256 hash
- `client/src/pages/dashboard/Settings.tsx` — Updated test connection fields (Groq, Google Search, GitHub, Slack, Resend, Stripe)
- `.env.template` — Clean template with only free API keys
- `docs/API.md` — Updated with new gap detection function documentation

### Changed
- `package.json` — Removed `openai`, `@anthropic-ai/sdk`; added `groq-sdk`, `cheerio`
- `server/_core/index.ts` — Removed WooCommerce/Odoo test endpoints
- `server/routers.ts` — Removed `testWooCommerce` and `testOdoo` procedures; updated `testConnection` service enum
- `client/src/lib/trpc.ts` — Removed WooCommerce/Odoo type definitions
- `client/src/pages/dashboard/Settings.tsx` — Removed WooCommerce/Odoo state, localStorage, and UI sections
- `README.md` — Updated architecture, tech stack, env vars, and installation guide
- All server files — Migrated from `OpenAI`/`Anthropic` SDK calls to unified `callLLM`/`callLLMJson`

### Verification
- Server TypeScript: `tsc --noEmit` → 0 errors
- Client Vite build: 1881 modules transformed → 388KB JS / 26KB CSS (106KB gzipped)
- No references to OpenAI, Anthropic, Firecrawl, Tavily, WooCommerce, or Odoo in any source file

---

## v1.0 — 2026-07-21

### Added
- 9-table MySQL schema (users, gaps, queue_items, deployments, audit_logs, policies, recurring_actors, deployment_health_checks, core_loop_state)
- 49 tRPC procedures across 10 routers
- Core loop orchestrator with AI classification (safe/unsafe/gray/false) + business plan generation
- Worker pool with configurable concurrency (1-10 workers)
- 4 queue types: synthesis, deployment, audit, maintenance
- 3-day audit scheduler with auto-fix + Slack notifications
- Health checker with ban risk assessment
- WebSocket real-time event broadcasting on `/ws` endpoint
- Retry engine with exponential backoff + jitter + rate limiting
- Stripe webhook for revenue tracking
- bcrypt auth + HMAC-signed session cookies
- React 19 frontend with 12 components
- Luxury OKLCH dark theme (Deep Indigo / Warm Gold / Rich Ruby)
- Mobile responsive layout with hamburger menu
- Priority levels 1-10 with color-coded badges
- Advanced analytics dashboard with funnel metrics
- Idempotent migration script (`run-migration.js`)
- Admin user setup script (`setup-admin.js`)
