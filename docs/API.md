# SAO — API Documentation

## Overview

All external APIs used by SAO v2.0 are free, open-source, or self-hosted. No monthly subscription costs are required.

---

## LLM — Groq (Free Tier)

**File:** `server/services/llm.ts`

| Function | Model | Purpose |
|---|---|---|
| `callLLM(prompt, opts?)` | Configurable | Raw text generation |
| `callLLMJson(prompt, opts?)` | Configurable | JSON-mode generation (auto-parses) |
| `testGroqConnection()` | llama-3.1-8b-instant | Connection test |

**Default Models:**
- `MODEL_CLASSIFIER` = `llama-3.1-8b-instant` — gap classification, safety checks, audits
- `MODEL_BUSINESS_PLAN` = `llama-3.3-70b-versatile` — business plan generation, auto-fix pivots

**Getting a Groq API Key:**
1. Go to https://console.groq.com/keys
2. Create a free account
3. Generate an API key (starts with `gsk_`)
4. Set `GROQ_API_KEY` in your `.env`

**Rate Limits:** Groq free tier provides generous limits (30 req/min for most models). The SAO retry engine handles rate limiting automatically.

---

## Web Crawler — Self-Hosted (cheerio)

**File:** `server/services/crawler.ts`

No external API needed. Uses `node-fetch` to retrieve HTML and `cheerio` to extract visible text.

| Function | Purpose |
|---|---|
| `crawlUrl(url)` | Fetch HTML, extract text content |
| `extractGapsFromContent(content, sourceUrl)` | LLM-based gap extraction from text |
| `crawlAndExtract(url)` | Crawl + extract in one step |

**tRPC Endpoint:** `discovery.crawl` (POST `{ url: string }`) — crawls a URL and auto-creates gaps

---

## Search — Google Programmable Search (Free Tier)

**File:** `server/services/search.ts`

Uses the Google Custom Search JSON API (100 free queries/day).

| Function | Purpose |
|---|---|
| `search(query, opts?)` | Raw search results |
| `searchForGaps(topic)` | Search + LLM gap extraction |
| `trendingProblems()` | Search for trending pain points |

**New Gap Detection Functions:**
- `detectEcommerceGaps()` — searches for e-commerce supply/demand gaps (out of stock, price mismatches)
- `detectOperationalGaps()` — searches for operational gaps (lead generation, churn, hiring)
- Both use `search()` + `extractGapFromText()` (Groq LLM) internally — no extra API keys needed

**tRPC Endpoints:**
- `discovery.search` (POST `{ query: string }`) — searches and auto-creates gaps
- `discovery.searchRaw` (GET `{ query: string, maxResults?: number }`) — raw search results
- `discovery.trending` (GET) — trending problems

**Getting Google Search Credentials:**
1. Go to https://developers.google.com/custom-search/v1/introduction
2. Create a Custom Search Engine at https://programmablesearchengine.google.com/
3. Get your API key from Google Cloud Console
4. Set `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_CX` in your `.env`

---

## Integrations (Unchanged — All Free)

| Service | File | Env Variables |
|---|---|---|
| GitHub | `server/services/github.ts` | `GITHUB_TOKEN` |
| Stripe | `server/_core/index.ts` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Resend | `server/routers.ts` | `RESEND_API_KEY` |
| Slack | `server/orchestrator.ts`, `server/auditScheduler.ts` | `SLACK_BOT_TOKEN`, `SLACK_CHANNEL` |
| Cloudflare R2 | (configured via env) | `CLOUDFLARE_R2_*` |
| Umami Analytics | (client-side) | `VITE_ANALYTICS_ENDPOINT`, `VITE_ANALYTICS_WEBSITE_ID` |

---

## tRPC Router Overview

| Router | Procedures | Auth |
|---|---|---|
| `auth` | register, login, logout, me, forgotPassword, resetPassword | Public/Protected |
| `gaps` | create, list, get, updateStatus, retry, delete | Protected/Admin |
| `queue` | list, stats, moveUp, moveDown, pause, resume, delete, retry, updatePriority | Protected/Admin |
| `deployments` | list, get, pause, resume, stop, stopAll, resumeAll, audit, stats | Protected/Admin |
| `audit` | list, get | Protected |
| `policies` | list, create, acknowledge, delete | Protected/Admin |
| `coreLoop` | start, stop, runOnce, runAudit, status | Admin/Protected |
| `analytics` | overview, revenueHistory | Protected |
| `discovery` | crawl, search, searchRaw, trending | Admin |
| `integrations` | testGroq, testWooCommerce, testOdoo, testGitHub, testStripe, testResend, testSlack, testGoogleSearch | Admin |
| `settings` | save, testConnection, retryConfig, getRetryConfig, queueLimits, getQueueLimits, setConcurrency, getConcurrency | Admin |
