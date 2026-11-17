# InvoiceDesk — 5-Minute Live Demo Narration Script

Use this cue sheet alongside `node scripts/record-demo.mjs` (or while recording live in Loom / OBS / QuickTime).

---

## 0:00 – 0:45 | Overview Dashboard (`/`) & Purchase Orders (`/purchase-orders`)
- **On Screen:** Open `/` (Overview Dashboard), then click **Purchase Orders** (`/purchase-orders`).
- **Narration:**
  > "This is **InvoiceDesk**, an AI-powered Accounts Payable automation platform that converts raw vendor invoice PDFs into verified, explainable `APPROVE`, `REVIEW`, and `REJECT` decisions.
  > All dashboard metrics here are SQLite-backed—showing throughput, pending exception reviews, and live Purchase Order balances like `PO-104` at `$13,500.00` remaining."

## 0:45 – 1:45 | Happy Path Live Execution (`/upload` → `/invoices/:id?live=true`)
- **On Screen:** Navigate to `/upload`, click **Run Live** on **Happy Path — Acme Cloud Services**, watch the 8 stages stream in real time.
- **Narration:**
  > "When we submit a real vendor PDF, InvoiceDesk executes an 8-stage pipeline: file validation, native PDF text inspection vs. OCR routing, Gemini structured JSON extraction, deterministic `decimal.js` arithmetic verification, vendor verification, duplicate checking, PO matching, and automated decisioning.
  > Acme Cloud Services passes every check and settles cleanly to `APPROVE` with a complete rule trace."

## 1:45 – 2:45 | Edge Cases `E1` (OCR Scan) & `E2` (Duplicate) (`/upload`)
- **On Screen:** Run **E1 — Scanned Image-Only PDF (OCR)**, then **E2 — Renamed Duplicate (Different Hash)**.
- **Narration:**
  > "Real AP teams receive messy edge cases. `E1` is an image-only scan with zero embedded text (`0 chars/page`). InvoiceDesk automatically routes to Gemini Vision OCR, transcribes the pages, and routes to `REVIEW` under low extraction confidence instead of silently guessing.
  > `E2` tests a renamed and re-hashed PDF with the same vendor and normalized invoice number—our `(vendor_id, normalized_invoice_number)` guard catches it immediately and triggers `REJECT` (`DUPLICATE_INVOICE_NUMBER`)."

## 2:45 – 3:45 | Edge Cases `E3` (Split PO) & `E4` (Math Mismatch) (`/upload`)
- **On Screen:** Run **E3 (1/3 – 3/3)** or **E4 — Missing Fields & Math Error**.
- **Narration:**
  > "For split milestones (`E3`), consecutive invoices draw down the remaining Purchase Order balance until the third invoice exceeds the remaining funds and automatically holds for `REVIEW`.
  > In `E4`, InvoiceDesk refuses to hallucinate a missing invoice number or auto-correct bad math—it reports `MISSING_REQUIRED_FIELD` and `ARITHMETIC_MISMATCH` verbatim."

## 3:45 – 4:30 | Human Review & Role-Based Access (`/reviews`)
- **On Screen:** Switch the top-right persona menu to `REVIEWER`, open **Review Queue** (`/reviews`), inspect side-by-side PDF evidence, and approve or reject an exception with a note.
- **Narration:**
  > "Switching to the `REVIEWER` persona unlocks exception resolution. Reviewers inspect the original PDF side-by-side with extracted line items and rule triggers before recording a mandatory review note."

## 4:30 – 5:00 | Immutable Audit Trail & OpenAPI 3.1 (`/audit` & `/api/v1/openapi.json`)
- **On Screen:** Open **Audit Trail** (`/audit`), toggle Light/Dark theme, and mention `/api/v1/openapi.json`.
- **Narration:**
  > "Every automated decision and human override is recorded permanently in the Audit Trail, and the entire platform exposes an OpenAPI 3.1 specification at `/api/v1/openapi.json` ready for ERP integration."
