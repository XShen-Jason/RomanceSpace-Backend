# RomanceSpace Backend

VPS API server — CQRS write-side. Handles all writes to Cloudflare R2/KV. The Cloudflare Worker is read-only.

## Stack

- Node.js + Express
- `@aws-sdk/client-s3` → Cloudflare R2 (S3-compatible)
- Cloudflare KV REST API
- Cloudflare Cache Purge API (CDN invalidation)
- Supabase (future: user auth & data)

## Quick Start

```bash
npm install
cp .env.example .env   # fill in all values
npm run dev            # node --watch (Node 18+)
```

Server listens on `http://0.0.0.0:3000` by default.

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Health check |
| POST | `/api/template/upload` | X-Admin-Key | Upload template files to R2 |
| GET | `/api/template/list` | — | List all registered templates |
| GET | `/api/template/preview/:name` | — | Preview template with schema defaults |
| POST | `/api/project/render` | X-Admin-Key | Render & store user page to R2 |
| GET | `/api/project/:subdomain` | X-Admin-Key | Get project config from KV |

### POST /api/template/upload

```bash
curl -X POST http://localhost:3000/api/template/upload \
  -H "X-Admin-Key: your-key" \
  -F "templateName=love_letter" \
  -F "index.html=@./index.html" \
  -F "schema.json=@./schema.json"
```

Response: `{ success, templateName, version, fields, filesUploaded, previewUrl }`

### POST /api/project/render

```bash
curl -X POST http://localhost:3000/api/project/render \
  -H "X-Admin-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"subdomain":"sweeties","type":"love_letter","data":{"title":"Hello Darling"}}'
```

Response: `{ success, subdomain, url, previewUrl, isUpdate }`

## Environment Variables

See `.env.example` for all required variables.

## Deploy (VPS)

```bash
# Install PM2 globally
npm install -g pm2

# Start with PM2
pm2 start src/app.js --name romancespace-backend
pm2 save
pm2 startup
```

## What's NOT yet implemented (to do later)

- **Supabase integration**: user auth, user data storage (env vars pre-configured)
- **Async batch re-render**: when a template is updated, old user pages are NOT automatically re-rendered yet (a log warning is printed instead). Needs a job queue (BullMQ + Redis).
- **Rate limiting / HTTPS**: use nginx or Caddy as a reverse proxy in production
