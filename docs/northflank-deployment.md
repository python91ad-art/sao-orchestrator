# Northflank Deployment Guide for SAO

This guide covers deploying the Situational Arbitrage Orchestrator (SAO) on Northflank using Docker containers.

## Prerequisites

- A Northflank account (https://northflank.com)
- Your SAO project code (with Dockerfile)
- Environment variable values ready (see `.env.example`)

---

## Step 1: Create a MySQL Database on Northflank

1. In your Northflank project, go to **Add Service** → **MySQL**
2. Choose a plan (free tier works for testing)
3. Note the following connection details from the Northflank dashboard:
   - **Host** (e.g. `mysql.example-db.svc.cluster.local` or the external host)
   - **Port** (default 3306)
   - **Username** (default: root)
   - **Password** (auto-generated or set by you)
   - **Database name** (e.g. `sao`)

## Step 2: Create a Docker Application Service

1. In the same Northflank project, go to **Add Service** → **Docker**
2. **Build method:** Build from repository
3. Connect your Git repository or select manual upload
4. Northflank will detect the Dockerfile automatically
5. Set the **container port** to `3000`

## Step 3: Configure Environment Variables

In the Northflank service settings, add these environment variables:

### Required
| Variable | Value |
|---|---|
| `PORT` | `3000` |
| `NODE_ENV` | `production` |
| `DB_HOST` | Your Northflank MySQL host |
| `DB_PORT` | `3306` |
| `DB_USER` | Your MySQL username (e.g. `root`) |
| `DB_PASSWORD` | Your MySQL password |
| `DB_NAME` | `sao` (or your database name) |
| `JWT_SECRET` | Generate with `openssl rand -hex 32` |
| `GROQ_API_KEY` | Your Groq API key |
| `GOOGLE_SEARCH_API_KEY` | Your Google Search API key |
| `GOOGLE_SEARCH_CX` | Your Google Search CX ID |

### Application Integrations
| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | Your GitHub token |
| `STRIPE_SECRET_KEY` | Your Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Your Stripe webhook secret |
| `RESEND_API_KEY` | Your Resend API key |
| `SLACK_BOT_TOKEN` | Your Slack bot token |
| `SLACK_CHANNEL` | `#alerts` |
| `CORS_ORIGIN` | Your Northflank public URL (e.g. `https://sao.example.com`) |
| `FRONTEND_URL` | Your Northflank public URL |

### Optional
| Variable | Value |
|---|---|
| `CLOUDFLARE_R2_ACCESS_KEY_ID` | R2 access key |
| `CLOUDFLARE_R2_SECRET_ACCESS_KEY` | R2 secret key |
| `CLOUDFLARE_R2_BUCKET_NAME` | R2 bucket name |
| `VITE_ANALYTICS_ENDPOINT` | Umami endpoint |
| `VITE_ANALYTICS_WEBSITE_ID` | Umami website ID |

## Step 4: Configure Health Checks

In Northflank service settings, set:
- **Health check path:** `/api/health`
- **Port:** `3000`

Northflank will monitor `/api/health` and restart the container if it fails.

## Step 5: Deploy and Run Migrations

1. Deploy the service (Northflank will build the Docker image)
2. Once running, open a shell in the container (Northflank → Service → Shell):
   ```bash
   node run-migration.js
   ```
3. Create the admin user:
   ```bash
   node setup-admin.js admin@example.com yourpassword
   ```

## Step 6: Verify the Deployment

```bash
# From the Northflank shell:
curl http://localhost:3000/api/health
# Expected: {"status":"healthy","timestamp":"...","uptime":...}

curl http://localhost:3000/api/ready
# Expected: {"status":"ready","database":"connected"}
```

Or from your browser:
```
https://your-northflank-url/api/health
```

## Step 7: WebSocket Configuration

Northflank supports WebSocket connections automatically. The `/ws` endpoint is served on the same port as HTTP (3000). No special configuration is needed — Northflank's load balancer handles WebSocket upgrade requests.

## Step 8: Custom Domain (Optional)

1. In Northflank → Service → Networking, add a custom domain
2. Point your domain DNS to the Northflank-provided CNAME or A record
3. Northflank provides automatic TLS/HTTPS for custom domains
4. Update `FRONTEND_URL` and `CORS_ORIGIN` to match your domain

---

## Data Migration from Railway (If Needed)

If you have existing data in Railway MySQL:

```bash
# Export from Railway
mysqldump -h caboose.proxy.rlwy.net -P 47789 -u root -p railway > sao_backup.sql

# Import to Northflank MySQL
# Connect to your Northflank MySQL (use the external host from Northflank dashboard)
mysql -h YOUR_NORTHFLANK_MYSQL_HOST -P 3306 -u root -p sao < sao_backup.sql
```

---

## Troubleshooting

### Check logs
In Northflank → Service → Logs, check for:
- `DB connection successful` — database is connected
- `Database and Core Loop State successfully initialized.` — Core Loop is ready
- `SAO running on port 3000` — server is up

### Database connection issues
Verify your `DB_HOST` is correct. Northflank internal hostnames (e.g. `mysql.svc.cluster.local`) only work from within the same Northflank project. Use the external host if the database is on a different provider.

### Port issues
The application listens on `process.env.PORT || 3000`. Northflank injects the `PORT` variable automatically — do not hardcode a different port.
