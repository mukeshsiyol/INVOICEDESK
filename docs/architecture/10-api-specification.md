# 10 — REST & SSE API Specification

Base URL prefix: `/api/v1`  
Content-Type: `application/json` (except `multipart/form-data` for uploads, `application/pdf` for documents, `text/csv` for exports, `text/event-stream` for SSE).

---

## 1. Common Conventions & Error Envelope

- **Authentication:** All endpoints (except `POST /auth/login` and `GET /health`) require a valid `HttpOnly` JWT session cookie (`invoicedesk_session`). Unauthenticated requests return `401 Unauthorized`.
- **RBAC:** Insufficient role permissions return `403 Forbidden`.
- **Error Envelope:**
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Reviewer note must be at least 10 characters.",
    "request_id": "req_01J...",
    "details": { "field": "note" }
  }
}
```

---

## 2. Authentication Endpoints

| Method | Path | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| `POST` | `/auth/login` | Public | Verify email/password, set `HttpOnly` session cookie. |
| `POST` | `/auth/logout` | Any Auth | Clear session cookie. |
| `GET` | `/auth/me` | Any Auth | Return current user profile, role, and theme preference. |
| `POST` | `/auth/demo-switch` | Any Auth (Only when `APP_ENV=demo`) | Switch active seeded persona (`OPERATOR` / `REVIEWER` / `ADMIN`) and log `AUTH_DEMO_SWITCH`. |

**`GET /auth/me` Response (`200 OK`):**
```json
{
  "id": "uuid",
  "email": "reviewer@invoicedesk.io",
  "full_name": "David Park",
  "role": "REVIEWER",
  "theme_preference": "light",
  "demo_mode": true
}
```

---

## 3. Invoice Upload, Listing, Details & Document Access

### 3.1 `POST /invoices/precheck-hash`
- **Auth:** `OPERATOR | REVIEWER | ADMIN`
- **Request:** `{ "hashes": [{ "client_id": "f1", "sha256": "a3f1..." }] }`
- **Response (`200 OK`):** `{ "matches": [{ "client_id": "f1", "is_duplicate": true, "existing_invoice_id": "uuid", "existing_filename": "acme.pdf", "existing_invoice_number": "INV-2026-0419" }] }`

### 3.2 `POST /invoices/upload`
- **Auth:** `OPERATOR | REVIEWER | ADMIN`
- **Request:** `multipart/form-data` with `files[]` (`1..10` PDF files, max `25 MB` each) + optional `auto_start: boolean = true`.
- **Validation:** Magic byte `%PDF-` check (`415` if non-PDF), size limit (`413`), batch limit (`400`).
- **Response (`202 Accepted`):**
```json
{
  "accepted": [
    {
      "invoice_id": "uuid",
      "run_id": "uuid",
      "original_filename": "acme_cloud_april.pdf",
      "file_sha256": "...",
      "processing_status": "QUEUED"
    }
  ],
  "rejected_files": []
}
```

### 3.3 `GET /invoices`
- **Auth:** `OPERATOR | REVIEWER | ADMIN`
- **Query Params:** `q`, `decision` (`APPROVE|REVIEW|REJECT|PENDING`), `processing_status`, `review_status`, `vendor_id`, `attention` (`true|false`), `date_from`, `date_to`, `sort` (`-created_at|total_amount|...`), `page` (`1`), `page_size` (`20`).
- **Response (`200 OK`):** `{ "items": [InvoiceSummaryDTO], "total": 142, "page": 1, "page_size": 20 }`

### 3.4 `GET /invoices/export`
- **Auth:** `OPERATOR | REVIEWER | ADMIN`
- **Query Params:** Same filters as `GET /invoices`, plus optional `ids[]`.
- **Response (`200 OK`):** `text/csv` attachment stream (`invoicedesk_export_YYYY-MM-DD.csv`).

### 3.5 `GET /invoices/:invoiceId`
- **Auth:** `OPERATOR | REVIEWER | ADMIN`
- **Query Params:** Optional `run_id` (defaults to `latest_run_id`).
- **Response (`200 OK`):** Complete Processing Workspace payload:
  - `invoice` (metadata, orthogonal statuses, extracted header fields, vendor summary, PO summary)
  - `active_run` (`run_id`, `run_number`, `status`, `extraction_mode`, `duration_ms`, `raw_extracted_json`)
  - `runs_history` (`[{ run_id, run_number, trigger_type, status, started_at, duration_ms }]`)
  - `stage_events` (`StageEventDTO[]` ordered `1..8`)
  - `line_items` (`InvoiceLineDTO[]`)
  - `decision` (`DecisionDTO | null` including `triggered_rules`, `explanation`, `evidence_snapshot`)
  - `review_actions` (`ReviewActionDTO[]`)
  - `po_reconciliation` (PO original, prior approved invoices list, remaining before/after, tolerance cap)

### 3.6 `GET /invoices/:invoiceId/document`
- **Auth:** `OPERATOR | REVIEWER | ADMIN`
- **Response (`200 OK`):** Raw PDF stream with `Content-Type: application/pdf`, `Content-Disposition: inline; filename="invoice.pdf"`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=300`.

### 3.7 `GET /invoices/:invoiceId/ocr-text`
- **Auth:** `OPERATOR | REVIEWER | ADMIN`
- **Response (`200 OK`):** `{ "extraction_mode": "OCR", "pages": [{ "page": 1, "text": "...", "ocr_confidence": 0.87 }] }`

---

## 4. Processing Runs, Live SSE Stream & Retries

### 4.1 `GET /runs`
- **Auth:** `OPERATOR | REVIEWER | ADMIN`
- **Query Params:** `status`, `trigger_type`, `page`, `page_size`.
- **Response (`200 OK`):** Paginated list of `ProcessingRunSummaryDTO`.

### 4.2 `GET /runs/:runId`
- **Auth:** `OPERATOR | REVIEWER | ADMIN`
- **Response (`200 OK`):** Run state + all persisted `stage_events[]` + `decision`.

### 4.3 `GET /runs/:runId/events` (Server-Sent Events — SSE)
- **Auth:** `OPERATOR | REVIEWER | ADMIN` (authenticated via `HttpOnly` cookie automatically sent by browser `EventSource` with `withCredentials: true`).
- **Headers Supported:** `Last-Event-ID: <bigint_stage_event_id>`.
- **Reconnection & Replay Behavior:**
  1. On connect, backend queries `SELECT * FROM stage_events WHERE run_id = :runId AND id > :lastEventId ORDER BY id ASC`.
  2. Immediately flushes all missed persisted events in exact order.
  3. If the run is already `COMPLETED` or `FAILED`, emits final `run_completed` / `run_failed` event and closes stream cleanly (`retry: 3000` disabled or client closes `EventSource` upon terminal event).
  4. While `RUNNING`, subscribes to `sse_broker` and emits `:heartbeat` comments every `15s` to prevent proxy idle timeouts.

**SSE Event Schemas:**
```text
id: 401
event: stage_started
data: {"run_id":"...","stage_number":2,"stage_code":"STAGE_2_EXTRACTION","status":"STARTED","summary":"Extracting PDF text and running OCR check...","timestamp":"2026-11-17T08:30:01Z"}

id: 402
event: stage_completed
data: {"run_id":"...","stage_number":2,"stage_code":"STAGE_2_EXTRACTION","status":"COMPLETED","duration_ms":2840,"summary":"OCR Fallback executed (2 pages, 87% OCR confidence)","evidence":{"extraction_mode":"OCR","native_chars_per_page":0},"timestamp":"2026-11-17T08:30:04Z"}

id: 409
event: stage_failed
data: {"run_id":"...","stage_number":2,"stage_code":"STAGE_2_EXTRACTION","status":"FAILED","duration_ms":5120,"summary":"LLM extraction provider timed out after 2 retries.","error_code":"PROVIDER_TIMEOUT","timestamp":"2026-11-17T08:30:06Z"}

id: 416
event: run_completed
data: {"run_id":"...","invoice_id":"...","processing_status":"COMPLETED","business_decision":"REVIEW","primary_reason_code":"LOW_EXTRACTION_CONFIDENCE","duration_ms":4320}
```

### 4.4 `POST /invoices/:invoiceId/retry`
- **Auth:** `OPERATOR | REVIEWER | ADMIN`
- **Request:** `{ "reason": "Transient LLM timeout" }` (optional)
- **Validation:** Returns `409 Conflict` if a run for this invoice is already `QUEUED` or `RUNNING`.
- **Response (`202 Accepted`):** `{ "invoice_id": "uuid", "run_id": "new_uuid", "run_number": 2, "processing_status": "QUEUED" }`.

---

## 5. Review Queue & Reviewer Actions

| Method | Path | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| `GET` | `/reviews` | `OPERATOR (read) | REVIEWER | ADMIN` | List `PENDING_REVIEW` (or `RESOLVED`) items with category filter (`ALL`, `VARIANCE`, `CONFIDENCE_MISSING`, `VENDOR_PO`). |
| `POST` | `/reviews/:invoiceId/assign` | `REVIEWER | ADMIN` | `{ "reviewer_id": "uuid" }` — assign/claim exception. |
| `POST` | `/invoices/:invoiceId/review` | `REVIEWER | ADMIN` | Submit human override (`APPROVE_OVERRIDE` or `REJECT_OVERRIDE`). |

**`POST /invoices/:invoiceId/review` Request:**
```json
{
  "action": "REJECT_OVERRIDE",
  "note": "Confirmed with vendor that PO-2026-300 cap is firm at $10,000. Requesting credit memo for $250 overrun."
}
```
- **Validation:** `note.strip().length >= 10` (`422` if shorter); invoice must currently have `review_status == 'PENDING_REVIEW'` (`409` if already resolved).
- **Response (`200 OK`):** Updated `review_status`, preserved `original_decision`, new `ReviewActionDTO`, updated `po_remaining_amount`.

---

## 6. Vendors & Purchase Orders

| Method | Path | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| `GET` | `/vendors` | Any Auth | Search/filter vendor directory + aggregated PO/invoice counts. |
| `GET` | `/vendors/:vendorId` | Any Auth | Vendor profile, aliases, linked POs, invoice history. |
| `POST` | `/vendors` | `ADMIN` | Create vendor (`canonical_name`, `aliases[]`, `tax_id`, `verification_status`). |
| `PATCH` | `/vendors/:vendorId` | `ADMIN` (full) / `REVIEWER` (status only) | Update aliases or verification status; writes `audit_logs`. |
| `GET` | `/purchase-orders` | Any Auth | Search/filter PO directory (`status`, `vendor_id`, `sort`). |
| `GET` | `/purchase-orders/:poId` | Any Auth | PO detail, line items, and linked invoices drawdown list. |
| `POST` | `/purchase-orders` | `ADMIN` | Create PO + line items (`original_amount > 0`). |
| `PATCH` | `/purchase-orders/:poId` | `ADMIN` | Update status (`CLOSED`/`OPEN`) or amount (`>= consumed_amount`, else `422`). |

---

## 7. Analytics, Search, Audit Trail & Settings

| Method | Path | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| `GET` | `/analytics/overview?window=30d` | Any Auth | KPIs, daily trend series, decision donut counts for Screen 01. |
| `GET` | `/analytics/metrics?window=30d&vendor_id=...` | Any Auth | All 7 metric values + numerators/denominators + exception/confidence distributions for Screen 08. |
| `GET` | `/analytics/export?window=30d` | Any Auth | CSV summary export. |
| `GET` | `/search?q=...` | Any Auth | Global `Cmd+K` search across Invoices, POs, and Vendors (max 5 per group). |
| `GET` | `/audit-logs` | `REVIEWER | ADMIN` | Paginated, filterable immutable audit trail (`action`, `resource_type`, `actor_id`, `q`). |
| `GET` | `/audit-logs/export` | `ADMIN` | CSV export of audit log. |
| `GET` | `/settings` | Any Auth | Current policy thresholds & processing settings. |
| `PATCH` | `/settings` | `ADMIN` | Update tolerances/confidence threshold; writes `SETTINGS_UPDATED` audit log. |
| `PATCH` | `/users/me/preferences` | Any Auth | Persist user `theme_preference` (`light | dark | system`). |
| `GET` / `POST` / `PATCH` | `/users` | `ADMIN` | List, create, update role, or deactivate users. |
