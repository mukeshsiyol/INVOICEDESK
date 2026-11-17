# InvoiceDesk — AI-Powered Accounts Payable Automation

InvoiceDesk transforms unstructured vendor invoice PDFs (both native text and scanned image PDFs) into verified, explainable AP decisions (`APPROVE`, `REVIEW`, `REJECT`) using Google AI Studio Gemini structured extraction, deterministic Decimal validation, purchase order matching, and an immutable audit trail.

## Quick Start (Local Development)

1. **Install dependencies** (requires **Node.js 22+** for built-in `node:sqlite`):
   ```bash
   npm install
   ```

2. **Configure environment variables** (copy `.env.example` to `.env`):
   ```bash
   cp .env.example .env
   ```
   Set your Google AI Studio API key in `.env`:
   ```env
   GEMINI_API_KEY="your-google-ai-studio-api-key"
   # Optional model override for exported deployments:
   # GEMINI_MODEL="gemini-4-hydrogen"
   JWT_SECRET="replace-with-a-32-character-random-secret"
   APP_ENV="demo"
   ENABLE_DEMO_ROLE_SWITCHER="true"
   # Set to "false" to enforce login cookies in production:
   PAUSE_AUTH_FOR_DEMO="true"
   ```

3. **Run development server** (Express API + Vite middleware on port `3000`):
   ```bash
   npm run dev
   ```

4. **Build & run production server**:
   ```bash
   npm run build
   npm start
   ```

## Publishing / Deploying Anywhere

InvoiceDesk adapts automatically between stateful Node servers and serverless environments:

### Option A — Google AI Studio / Cloud Run / Railway / Render / Fly.io / Docker *(Recommended for full persistence & live SSE)*
The included `Dockerfile` builds the Vite SPA and runs the Express + SQLite server on port `3000` with persistent local storage (`./data`) and real-time Server-Sent Events (`/api/v1/runs/:runId/events`).

- **Build command:** `npm ci && npm run build`
- **Start command:** `npm start`
- **Render Blueprint (`render.yaml`):** Connect your GitHub repo via **New → Blueprint** in Render; it automatically uses `Dockerfile` (Node 22), `/api/v1/health`, and prompts you for `GEMINI_API_KEY`.
- **Required env vars:** `GEMINI_API_KEY` (and set `PAUSE_AUTH_FOR_DEMO="false"` + `JWT_SECRET` if deploying for real multi-user login)
- **Docker:**
  ```bash
  docker build -t invoicedesk .
  docker run -p 3000:3000 -e GEMINI_API_KEY="your-key" invoicedesk
  ```

### Option B — Vercel (`vercel.json` + `api/index.ts`)
Preconfigured with `vercel.json`, `api/index.ts`, and `"engines": { "node": "22.x" }`:
- Deploy directly via **Vercel Dashboard** (import repo) or **Vercel CLI** (`npx vercel --prod`).
- Add `GEMINI_API_KEY` in Vercel **Project Settings → Environment Variables**.
- **Serverless behavior note:** When `VERCEL=1` is detected, SQLite and uploaded PDFs store automatically in `/tmp/invoicedesk-data` and pipeline execution completes inline per request (`maxDuration: 60`s). Because `/tmp` is ephemeral across serverless cold starts, use **Option A** (Cloud Run / Railway / Render / Docker) for durable database persistence across restarts.

## OpenAPI 3.1 Specification

Once running, the OpenAPI 3.1.0 specification is served at:
- `GET /api/v1/openapi.json`

## Edge Cases Covered in Sample Suite (`/upload`)

- **Happy Path:** Verified vendor, exact Decimal math, sufficient PO balance → `APPROVE`.
- **E1 (Scanned Image PDF):** Zero embedded text triggers Vision OCR fallback and conservative confidence routing → `REVIEW` (`LOW_EXTRACTION_CONFIDENCE`).
- **E2 (Renamed / Re-hashed Duplicate):** Different filename & SHA-256 hash caught by `(vendor_id, normalized_invoice_number)` check → `REJECT` (`DUPLICATE_INVOICE_NUMBER`).
- **E3 (Split PO Consumption):** Cumulative 3-part invoice stream against a single Purchase Order until remaining balance is exceeded → `APPROVE`, `APPROVE`, then `REVIEW` (`PO_BALANCE_EXCEEDED`).
- **E4 (Missing Fields & Arithmetic Mismatch):** Missing `invoice_number` + printed total diverging from line-item sum → `REVIEW` (`MISSING_REQUIRED_FIELD`, `ARITHMETIC_MISMATCH`).

