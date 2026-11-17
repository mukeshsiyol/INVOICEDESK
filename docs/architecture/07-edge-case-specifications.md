# 07 — Edge-Case Specifications & Live Demo Runbook

These four non-trivial edge cases prove InvoiceDesk's robustness across messy real-world PDFs, duplicate detection beyond filenames, stateful multi-invoice PO math, and strict uncertainty handling.

---

## Edge Case E1 — Scanned Invoice Requiring OCR

### Scenario
A vendor mails a paper invoice that was scanned at 200 DPI as an image-only PDF (`nordic_logistics_scan_q3.pdf`). There is **zero** embedded text layer, slight skew, and one slightly smudged digit in the unit price or tax line.

- **Sample Input:**
  - Filename: `nordic_logistics_scan_q3.pdf` (2-page rasterized PDF, 0 native text characters).
  - Vendor on image: `"Nordic Freight & Logistics Ltd."` (seeded Vendor `V-002`, `APPROVED`, alias `"Nordic Freight"`).
  - PO on image: `"PO-2026-205"` (`$12,500.00` open).
  - Invoice #: `"NF-88412"`, Total: `"$4,200.00"`.
- **Expected Extraction:**
  - Stage 2 detects `native_chars_per_page = 0 < 50`, triggers Tesseract OCR (`extraction_mode = "OCR"`).
  - Extracts `vendor.name = "Nordic Freight & Logistics Ltd."`, `invoice_number = "NF-88412"`, `po_number = "PO-2026-205"`, `total_amount = "4200.00"`.
  - **Sub-case E1a (Clean OCR, conf >= 0.85):** All critical fields pass confidence threshold (`0.91`).
  - **Sub-case E1b (Smudged scan, total conf = 0.74 < 0.85):** Extraction succeeds without crashing, but `field_confidence.total_amount = 0.74`.
- **Processing Behavior:**
  - Stage 1: Stores PDF.
  - Stage 2: Native extraction returns 0 chars → visibly transitions Stage 2 sub-step to OCR Fallback → extracts text + OCR confidence → parses structured JSON.
  - Stages 3–7: Arithmetic passes, Vendor matches `APPROVED`, Duplicate check clear, PO `PO-2026-205` has `$12,500.00` remaining.
  - Stage 8: Evaluates confidence gate (`R-13`).
- **Expected Decision:**
  - Sub-case E1a: `APPROVE` (`AUTO_APPROVED_MATCH`).
  - Sub-case E1b (Demo Primary): `REVIEW` (`LOW_EXTRACTION_CONFIDENCE`) — deliberately demonstrating that OCR ambiguity never silently auto-approves.
- **Reason Code:** `LOW_EXTRACTION_CONFIDENCE` (E1b) or `AUTO_APPROVED_MATCH` (E1a).
- **Evidence:** `{ "extraction_mode": "OCR", "native_chars_per_page": 0, "ocr_avg_confidence": 0.79, "low_confidence_fields": [{"field": "total_amount", "confidence": 0.74, "threshold": 0.85}] }`.
- **UI Representation:**
  - Stage 2 timeline node shows `"OCR Fallback Executed (2 pages)"` + expandable raw OCR text preview.
  - Right-pane Extracted Data shows amber warning badge `74% Confidence` next to `Total: $4,200.00`, inviting the reviewer to visually verify against the PDF on the left.
- **Automated Test Cases:**
  - `test_e1_scanned_pdf_triggers_ocr_fallback`: Verify `pypdf` yields `< 50` chars, `extraction_mode == "OCR"` is persisted in Stage 2 `stage_events`.
  - `test_e1_low_ocr_confidence_routes_to_review`: Mock OCR confidence `0.72` on `total_amount` → assert `Decision.outcome == "REVIEW"` and `primary_reason_code == "LOW_EXTRACTION_CONFIDENCE"`.

---

## Edge Case E2 — Duplicate Invoice Uploaded Under a Different Filename

### Scenario
An AP clerk receives the same invoice twice: first as `acme_cloud_april.pdf`, then 3 days later re-exported from the vendor's billing portal as `INV-2026-0419_reissued_copy.pdf` (different PDF metadata timestamp → **different file SHA-256 hash**, so naive file-hash deduplication fails!).

- **Sample Input:**
  - Prior Invoice in DB: `INV-2026-0419` from `Acme Cloud Services` (`V-001`), `$3,450.00`, filename `acme_cloud_april.pdf`, decision `APPROVE`.
  - New Upload: `INV-2026-0419_reissued_copy.pdf`, vendor header `"ACME CLOUD INC."` (alias of `V-001`), invoice number `"INV 2026-0419"` (space instead of hyphen), `$3,450.00`.
- **Expected Extraction:**
  - Extracts `vendor.name = "ACME CLOUD INC."`, `invoice_number = "INV 2026-0419"`, `total_amount = "3450.00"`.
- **Processing Behavior:**
  - Stage 4: Normalizes `"ACME CLOUD INC."` via vendor alias → resolves canonical `vendor_id = V-001`.
  - Stage 5: File SHA-256 check returns `false` (different PDF bytes). Business-key check normalizes `"INV 2026-0419"` → `"INV20260419"`, queries `(vendor_id = V-001, norm_invoice_no = "INV20260419")`, and **catches the prior invoice**.
  - Stage 8: Triggers Rule `R-02` (`REJECT`, Tier 1 Precedence). PO balance is **not** debited again.
- **Expected Decision:** `REJECT`.
- **Reason Code:** `DUPLICATE_INVOICE`.
- **Evidence:** `{ "file_hash_match": false, "business_key_match": true, "normalized_key": "V-001|INV20260419", "conflicting_invoice_id": "<uuid>", "conflicting_invoice_number": "INV-2026-0419", "conflicting_filename": "acme_cloud_april.pdf", "conflicting_uploaded_at": "2026-11-14T10:15:00Z" }`.
- **UI Representation:**
  - Red Decision Banner: `REJECTED — Duplicate Invoice Detected`.
  - Duplicate Evidence Card displays side-by-side comparison and a clickable link `View Original Invoice (acme_cloud_april.pdf) →`.
- **Automated Test Cases:**
  - `test_e2_different_filename_and_hash_catches_business_duplicate`: Upload two distinct PDFs with `"INV-2026-0419"` and `"INV 2026-0419"` under vendor alias → assert 2nd run produces `REJECT`, `DUPLICATE_INVOICE`, and `po.consumed_amount` remains unchanged.

---

## Edge Case E3 — Multiple Invoices Against One Purchase Order (Split Invoices)

### Scenario
A consulting vendor (`Vertex Security Partners`, `V-003`) holds one large Purchase Order `PO-2026-300` for `$10,000.00`. Instead of one invoice, they submit **three sequential milestone invoices**:
1. **Invoice A (`VS-101`):** `$4,000.00` (40% kickoff)
2. **Invoice B (`VS-102`):** `$4,000.00` (40% midpoint)
3. **Invoice C (`VS-103`):** `$2,250.00` (final bill — total cumulative `$10,250.00`, exceeding remaining `$2,000.00` by `$250.00` / `2.5%` > `$10.00` tolerance cap).

- **Sample Input:** `PO-2026-300` (`original_amount = 10000.00`, `consumed_amount = 0.00`, `status = OPEN`). Three sequential PDFs referencing `PO-2026-300`.
- **Expected Extraction:** All three extract `po_number = "PO-2026-300"`, clean confidence (`> 0.94`), totals `4000.00`, `4000.00`, `2250.00`.
- **Processing Behavior:**
  - **Run A (`VS-101`):** Stage 7 sees `remaining_before = 10000.00 >= 4000.00` → `APPROVE` → atomic DB update sets `po.consumed_amount = 4000.00`, `po.status = PARTIALLY_CONSUMED`.
  - **Run B (`VS-102`):** Stage 7 reads `remaining_before = 6000.00 >= 4000.00` → `APPROVE` → atomic DB update sets `po.consumed_amount = 8000.00`, `po.status = PARTIALLY_CONSUMED`.
  - **Run C (`VS-103`):** Stage 7 reads `remaining_before = 2000.00`. `invoice.total = 2250.00`. Overrun = `$250.00`. Allowed tolerance = `min(2% * $10,000 = $200, $10.00) = $10.00`. Since `$250.00 > $10.00`, triggers Rule `R-11` (`TOLERANCE_EXCEEDED`). `po.consumed_amount` stays `$8,000.00`.
- **Expected Decision:**
  - `VS-101`: `APPROVE` (`AUTO_APPROVED_MATCH`)
  - `VS-102`: `APPROVE` (`AUTO_APPROVED_MATCH`)
  - `VS-103`: `REVIEW` (`TOLERANCE_EXCEEDED`)
- **Reason Code:** `TOLERANCE_EXCEEDED` (for `VS-103`).
- **Evidence (for `VS-103`):** `{ "po_number": "PO-2026-300", "po_original_amount": "10000.00", "prior_approved_invoices": [{"invoice_number": "VS-101", "amount": "4000.00"}, {"invoice_number": "VS-102", "amount": "4000.00"}], "prior_consumed_amount": "8000.00", "remaining_before": "2000.00", "current_invoice_total": "2250.00", "overrun_amount": "250.00", "allowed_tolerance_cap": "10.00" }`.
- **UI Representation:**
  - PO Reconciliation Card shows visual stacked breakdown bar: `$8,000.00 Prior Approved` + `$2,250.00 Current` vs. `$10,000.00 PO Cap` (`+$250.00 Overrun` highlighted in amber/red) with clickable links to `VS-101` and `VS-102`.
- **Automated Test Cases:**
  - `test_e3_split_invoices_cumulative_po_balance`: Sequentially process `$4,000`, `$4,000`, `$2,250` against `$10,000` PO → assert `APPROVE`, `APPROVE`, `REVIEW` (`TOLERANCE_EXCEEDED`) and `po.consumed_amount == Decimal("8000.0000")`.
  - `test_e3_concurrent_po_approval_lock`: Submit two `$6,000` invoices concurrently against a `$10,000` PO → assert `SELECT FOR UPDATE` ensures exactly one approves and the second catches the overrun as `REVIEW`.

---

## Edge Case E4 — Missing or Inconsistent Financial Information

### Scenario
A small contractor sends a poorly formatted PDF (`summit_design_draft.pdf`) where:
- There is **no invoice number** (`null`).
- There is **no explicit PO number** (`null`).
- Line items list `$1,200.00 + $300.00 = $1,500.00`, Tax says `$120.00`, yet the stated Grand Total says `"$1,720.00"` (`$100.00` discrepancy).

- **Sample Input:** `summit_design_draft.pdf` from `Summit Design Studio` (`V-004`, `APPROVED`).
- **Expected Extraction:** `invoice_number: null`, `po_number: null`, `subtotal: "1500.00"`, `tax_amount: "120.00"`, `total_amount: "1720.00"`. **Crucial:** LLM does *not* invent an invoice number or fix the total to `1620.00`.
- **Processing Behavior:**
  - Stage 3 flags `MISSING_REQUIRED_FIELD` (`["invoice_number"]`) AND `ARITHMETIC_MISMATCH` (`1500.00 + 120.00 = 1620.00 != 1720.00`, delta `+$100.00`).
  - Stage 4 matches vendor `Summit Design Studio`.
  - Stage 5 skips business-key duplicate check (cannot key on null `invoice_number`, logs skipped reason).
  - Stage 6 notes `po_number` is `null`, checks vendor's open POs (`PO-2026-401`) as an unconfirmed implied candidate (`R-08`).
  - Stage 8 aggregates all triggered rules (`R-05`, `R-06`, `R-08`).
- **Expected Decision:** `REVIEW` (multiple high-severity exceptions).
- **Reason Code:** Primary: `MISSING_REQUIRED_FIELD`; Secondary Triggered Rules: `["ARITHMETIC_MISMATCH", "PO_MISSING"]`.
- **Evidence:** `{ "missing_fields": ["invoice_number"], "arithmetic": {"expected_total": "1620.00", "stated_total": "1720.00", "delta": "100.00"}, "implied_po_candidates": ["PO-2026-401"] }`.
- **UI Representation:**
  - Extracted Data panel highlights `Invoice Number` with a red `MISSING` badge (never `"N/A"`).
  - Arithmetic Proof Card highlights `$1,500.00 + $120.00 = $1,620.00 ≠ $1,720.00 (Delta: +$100.00)`.
  - Reviewer sees all 3 issues listed clearly and can click `Reject (Request Corrected Invoice from Vendor)` with mandatory note.
- **Automated Test Cases:**
  - `test_e4_missing_invoice_number_and_math_error`: Process `summit_design_draft.pdf` → assert `invoice_number is None` in DB, `Decision.outcome == "REVIEW"`, and `triggered_rules` contains `MISSING_REQUIRED_FIELD`, `ARITHMETIC_MISMATCH`, and `PO_MISSING`.

---

## 5. Five-Minute Demo & Live Interview Runbook

| Timestamp | Action | What Audience Sees |
| :--- | :--- | :--- |
| **0:00 – 0:45** | **Dashboard & Context** | Overview Dashboard (`/`) with real DB-derived KPIs, PO utilization, and Purchase Orders directory (`/purchase-orders`). |
| **0:45 – 2:00** | **Happy Path Live Run** | Upload clean PDF (`acme_cloud_april.pdf`) → watch 8 stages stream live via SSE in Split-Screen Processing Workspace (`/invoices/:id`) → `APPROVE` + PO balance decrements in real time. |
| **2:00 – 3:15** | **Edge Case E2 (Duplicate)** | Upload `INV-2026-0419_reissued_copy.pdf` (different filename & hash) → Stage 5 catches normalized vendor+invoice key → `REJECT (DUPLICATE_INVOICE)` with link to original. |
| **3:15 – 4:15** | **Edge Case E3 / E1 (Split PO Overrun or OCR Scan)** | Run `VS-103` (`$2,250` against `$2,000` remaining) → `REVIEW (TOLERANCE_EXCEEDED)` showing cumulative prior invoices `VS-101` + `VS-102`. |
| **4:15 – 5:00** | **Human Review & Audit Trail** | Switch to Reviewer persona → open Review Queue (`/reviews`) → Reject/Approve with mandatory note → show Audit Trail (`/audit`) preserving `Original: REVIEW` alongside override. |
