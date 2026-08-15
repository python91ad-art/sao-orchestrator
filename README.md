# Situational Arbitrage Orchestrator (SAO) v2.0

An automated market gap detection and business deployment platform. The SAO discovers situational arbitrage opportunities via Google Search + Groq LLM, classifies them with AI, generates business plans, deploys micro-startups, and audits them on a 3-day cycle — all from a luxury OKLCH dark-themed dashboard.

**v2.0 Changes:** Removed all paid/proprietary APIs (OpenAI, Anthropic, Firecrawl, Tavily, WooCommerce, Odoo). Now 100% free APIs: Groq LLM, Google Custom Search, self-hosted cheerio crawler. Gap detection runs automatically via Google Search + Groq — no extra API keys needed.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 5, Tailwind CSS, Lucide Icons |
| Backend | Express, tRPC v11, TypeScript |
| Database | MySQL 8.0+, Drizzle ORM |
| AI | Groq `llama-3.3-70b-versatile` (business plans), `llama-3.1-8b-instant` (classification) — Free Tier |
| Auth | bcrypt password hashing, HMAC-signed session cookies, JWT |
| Real-time | WebSocket (ws library) on `/ws` endpoint |
| Search | Google Programmable Search (100 free queries/day) |
| Crawler | Self-hosted cheerio (no API key needed) |
| Integrations | Stripe, GitHub, Slack, Resend, Cloudflare R2, Umami |

---

## Deployment

SAO is deployed as a Docker container. It works with any container hosting platform (Northflank, local Docker, etc.).

### Environment Variables

The application uses generic environment variables for database configuration:

| Variable | Description |
|---|---|
| `DB_HOST` | MySQL hostname |
| `DB_PORT` | MySQL port (default 3306) |
| `DB_USER` | MySQL username |
| `DB_PASSWORD` | MySQL password |
| `DB_NAME` | MySQL database name |
| `PORT` | Application port (default 3000) |
| `JWT_SECRET` | Session signing secret |
| `FRONTEND_URL` | Frontend URL for CORS (e.g. https://your-domain.com) |

See `.env.example` for the complete list.

---

## Local / Quick Start Setup

### Prerequisites

1. **Node.js** 20+ — [Download here](https://nodejs.org/)
2. **pnpm** — Install: `npm install -g pnpm`
3. **MySQL** 8+ — Local MySQL instance or Docker container (`docker-compose up -d mysql`)

### Step 1: Install Dependencies

```bash
pnpm install
```

### Step 2: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and set the required values (see `.env.example` for full list).

### Step 3: Run Database Migration

```bash
node run-migration.js
```

This creates all 9 tables with the latest schema (idempotent — safe to run multiple times).

### Step 4: Create Admin User

```bash
node setup-admin.js admin@example.com yourpassword
```

### Step 5: Start the Server

```bash
# Development mode (hot reload — starts both frontend + backend)
pnpm dev

# Or production mode
pnpm build:client && pnpm start

# Or using Docker Compose (starts MySQL + app)
docker-compose up -d --build
```

### Step 6: Open the Dashboard

Navigate to `http://localhost:3000` and log in with your admin credentials.

---

## Architecture

```
SAO/
├── client/                    # React 19 frontend
│   ├── src/
│   │   ├── components/
│   │   │   └── DashboardLayout.tsx
│   │   ├── hooks/
│   │   │   ├── useAuth.tsx
│   │   │   └── useWebSocket.ts
│   │   ├── lib/
│   │   │   └── trpc.ts
│   │   └── pages/
│   │       ├── Login.tsx
│   │       ├── Dashboard.tsx
│   │       └── dashboard/
│   │           ├── Overview.tsx
│   │           ├── Gaps.tsx
│   │           ├── Queue.tsx
│   │           ├── Deployments.tsx
│   │           ├── AuditLog.tsx
│   │           ├── Analytics.tsx
│   │           ├── Policies.tsx
│   │           └── Settings.tsx
│   ├── tailwind.config.js
│   ├── vite.config.ts
│   └── index.html
├── server/                    # Express + tRPC backend
│   ├── _core/
│   │   ├── index.ts            # Server bootstrap, middleware, health endpoints
│   │   ├── context.ts          # tRPC request context
│   │   ├── cookies.ts          # Session signing/verification
│   │   └── trpc.ts            # tPC router/procedure helpers
│   ├── db.ts                   # Database config + all CRUD helpers
│   ├── routers.ts              # 49 tRPC procedures
│   ├── orchestrator.ts         # Core Loop + worker pool
│   ├── auditScheduler.ts       # 3-day audit cycle
│   ├── healthChecker.ts        # Deployment health monitoring
│   ├── retryEngine.ts          # Retry + rate limiting
│   ├── websocket.ts            # WebSocket server
│   └── services/
│       ├── llm.ts              # Groq LLM adapter
│       ├── search.ts           # Google Custom Search
│       ├── crawler.ts          # Cheerio web crawler
│       └── github.ts           # GitHub integration
├── drizzle/
│   ├── schema.ts               # 9-table Drizzle schema
│   └── migrations/             # SQL migration files
├── Dockerfile                  # Production container
├── docker-compose.yml          # MySQL + app for local dev
├── run-migration.js            # Idempotent DB migration
├── setup-admin.js              # Admin user creation
├── verify.js                   # Diagnostic test suite
├── drizzle.config.ts           # Drizzle Kit config
└── .env.example                # Environment template
```

---

## Database Schema (9 tables)

| Table | Purpose |
|---|---|
| `users` | Admin/user accounts with bcrypt-hashed passwords |
| `gaps` | Discovered market gaps with classification status |
| `queue_items` | Processing queue (synthesis, deployment, audit, maintenance) |
| `deployments` | Active micro-startup deployments with Stripe integration |
| `audit_logs` | Audit decision history with ban risk assessment |
| `policies` | Policy enforcement rules |
| `recurring_actors` | Pattern detection for recurring gap sources |
| `deployment_health_checks` | Health check records for deployments |
| `core_loop_state` | Singleton state for the Core Loop engine |

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Liveness check (always 200 when process is alive) |
| `/api/ready` | GET | Readiness check (tests database connectivity) |
| `/api/trpc/*` | GET/POST | tRPC procedures (49 endpoints) |
| `/api/stripe/webhook` | POST | Stripe webhook handler |
| `/ws` | WebSocket | Real-time event broadcasting |

---

## Scripts

| Command | Description |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Start dev mode (hot reload, frontend + backend) |
| `pnpm dev:server` | Start backend only (hot reload) |
| `pnpm dev:client` | Start frontend only (Vite dev server) |
| `pnpm build:client` | Build production frontend to `dist/client` |
| `pnpm start` | Start production server (`tsx server/_core/index.ts`) |
| `node run-migration.js` | Run database migration (idempotent) |
| `node setup-admin.js` | Create admin user |
| `node verify.js` | Run diagnostic test suite |

---

## Changelog

### v2.0
- Removed all paid APIs (OpenAI, Anthropic, Firecrawl, Tavily, WooCommerce, Odoo)
- Replaced with Groq LLM (free), Google Custom Search (free 100/day), self-hosted cheerio crawler
- Added `detectEcommerceGaps()` + `detectOperationalGaps()` auto-discovery in core loop
- All API keys configured in `.env`
- Provider-neutral database configuration using `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- Docker container deployment ready
