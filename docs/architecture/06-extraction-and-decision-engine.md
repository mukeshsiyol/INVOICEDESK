# 06 — Extraction Architecture & Deterministic Decision Engine

## 1. Extraction Pipeline Architecture

InvoiceDesk strictly separates **probabilistic document extraction** (OCR + LLM) from **deterministic financial decision-making** (Python `Decimal` rule engine).

```text
PDF Bytes
  │
  ▼
[1. PDF Validation] ──(Magic bytes %PDF-, page count, unencrypted)
  │
  ▼
[2. Native Text Extraction] ──(pypdf / pdfplumber per page)
  │
  ├──(avg_chars/page >= 50)──────────────────────────┐
  │                                                  │
  ▼ (avg_chars/page < 50: Scanned PDF)               ▼
[3. OCR Fallback (Tesseract @ 300 DPI)] ──► [4. Provider-Independent LLM Extractor]
                                                     │  (Untrusted text delimiters + JSON Schema)
                                                     ▼
                                            [5. Pydantic Schema Validation]
                                                     │  (Nulls preserved; zero invented numbers)
                                                     ▼
                                            [6. Deterministic Financial Validation (Stage 3+)]
```

### 1.1 Provider-Independent Extractor Interface

To ensure the LLM provider can be swapped without modifying orchestration or financial rules:

```python
class ExtractionProvider(Protocol):
    provider_name: str
    model_name: str

    async def extract_invoice(
        self,
        *,
        document_text: str,
        page_images: list[bytes] | None,
        extraction_mode: Literal["NATIVE_TEXT", "OCR", "HYBRID"],
        ocr_confidence: float | None,
    ) -> ExtractedInvoicePayload:
        ...
```

- **Default Implementation (`GeminiExtractionProvider`):** Uses `@google/genai` / `google-genai` (`gemini-2.5-flash`) with `response_schema` enforced structured JSON output and `temperature = 0.0`.
- **OCR Strategy:** `pypdfium2` renders low-text pages to 300 DPI PNGs → `pytesseract` extracts text + word-level confidences (`image_to_data`). If `ocr_confidence < 0.65` (e.g., heavily skewed or stamped scan), `page_images` are also passed to Gemini Vision (`HYBRID` mode) while tagging affected fields with conservative confidence scores.
- **Anti-Hallucination Contract:** System prompt explicitly instructs: *"If a field (invoice_number, po_number, tax, date, etc.) is not explicitly visible in the document, return `null` with `confidence: 0.0`. NEVER guess, calculate, or invent missing invoice numbers, PO numbers, dates, or totals."*

---

## 2. Canonical Extracted Invoice JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ExtractedInvoicePayload",
  "type": "object",
  "required": [
    "document_type",
    "vendor",
    "invoice_number",
    "invoice_date",
    "due_date",
    "po_number",
    "currency",
    "subtotal",
    "tax_amount",
    "discount_amount",
    "total_amount",
    "line_items",
    "field_confidence",
    "extraction_evidence"
  ],
  "properties": {
    "document_type": { "type": "string", "enum": ["INVOICE", "CREDIT_NOTE", "UNKNOWN"] },
    "vendor": {
      "type": "object",
      "properties": {
        "name": { "type": ["string", "null"] },
        "tax_id": { "type": ["string", "null"] },
        "address": { "type": ["string", "null"] }
      }
    },
    "invoice_number": { "type": ["string", "null"] },
    "invoice_date": { "type": ["string", "null"], "format": "date" },
    "due_date": { "type": ["string", "null"], "format": "date" },
    "po_number": { "type": ["string", "null"] },
    "currency": { "type": ["string", "null"], "pattern": "^[A-Z]{3}$" },
    "subtotal": { "type": ["string", "null"], "description": "Exact decimal string e.g. '1250.00'" },
    "tax_amount": { "type": ["string", "null"] },
    "tax_mode": { "type": "string", "enum": ["SEPARATED", "EMBEDDED", "EXEMPT", "UNKNOWN"] },
    "discount_amount": { "type": ["string", "null"] },
    "total_amount": { "type": ["string", "null"] },
    "line_items": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["line_number", "description", "line_total"],
        "properties": {
          "line_number": { "type": "integer" },
          "description": { "type": "string" },
          "is_bundled": { "type": "boolean" },
          "quantity": { "type": ["string", "null"] },
          "unit_price": { "type": ["string", "null"] },
          "tax_amount": { "type": ["string", "null"] },
          "line_total": { "type": "string" }
        }
      }
    },
    "field_confidence": {
      "type": "object",
      "description": "0.00 to 1.00 confidence per key field",
      "properties": {
        "vendor_name": { "type": "number", "minimum": 0, "maximum": 1 },
        "invoice_number": { "type": "number", "minimum": 0, "maximum": 1 },
        "invoice_date": { "type": "number", "minimum": 0, "maximum": 1 },
        "po_number": { "type": "number", "minimum": 0, "maximum": 1 },
        "currency": { "type": "number", "minimum": 0, "maximum": 1 },
        "subtotal": { "type": "number", "minimum": 0, "maximum": 1 },
        "tax_amount": { "type": "number", "minimum": 0, "maximum": 1 },
        "total_amount": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    },
    "extraction_evidence": {
      "type": "object",
      "description": "Verbatim source snippet & page number supporting each extracted value",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "page": { "type": "integer" },
          "snippet": { "type": "string" }
        }
      }
    }
  }
}
```

### Handling Special Document Characteristics
- **Bundled vs. Itemized Lines:** `is_bundled: true` captures lump-sum descriptions ("Q2 Retainer Services — $12,000.00") with `quantity: null`, `unit_price: null`, `line_total: "12000.00"` without failing line-item validation.
- **Embedded vs. Separated Tax:** When tax is embedded ("Total incl. GST $1,100.00"), `tax_mode = "EMBEDDED"`, `subtotal` may be `null` or `1100.00` depending on document disclosure; arithmetic validation checks `subtotal + tax_amount == total_amount` only when both `subtotal` and `tax_amount` are explicitly stated.
- **Credit Notes:** Recognized via negative totals or `"CREDIT NOTE"` / `"CREDIT MEMO"` headers → `document_type = "CREDIT_NOTE"`, routed explicitly via Rule `R-14`.

---

## 3. Deterministic Decision Engine Rules

All monetary comparisons use Python `decimal.Decimal` with `ROUND_HALF_UP` quantized to `0.0001` internally (`0.01` for final currency variance display).

### 3.1 Complete Rule Catalog

| Rule ID | Category | Conditions | Decision | Reason Code | Severity | Explanation Template & Evidence |
| :--- | :--- | :--- | :---: | :--- | :---: | :--- |
| **R-01** | Blocked Vendor | Matched `vendor.verification_status == 'BLOCKED'` | `REJECT` | `VENDOR_BLOCKED` | `CRITICAL` | "Vendor '{canonical_name}' is blocked in procurement master." Evidence: `{vendor_id, status}`. |
| **R-02** | Exact Duplicate | `file_sha256` OR `(vendor_id, normalized_invoice_number)` matches an existing non-rejected invoice | `REJECT` | `DUPLICATE_INVOICE` | `CRITICAL` | "Duplicate of existing invoice {conflict_inv_no} (file '{conflict_filename}')." Evidence: `{conflict_invoice_id, match_type}`. |
| **R-03** | Closed PO | Matched PO has `status == 'CLOSED'` (or `CANCELLED`) | `REJECT` | `PO_CLOSED` | `CRITICAL` | "Referenced PO {po_number} is CLOSED and cannot accept new charges." Evidence: `{po_id, po_status}`. |
| **R-04** | Currency Mismatch | `invoice.currency` != `po.currency` (both non-null) | `REJECT` | `CURRENCY_MISMATCH` | `CRITICAL` | "Invoice currency ({inv_curr}) does not match PO {po_number} currency ({po_curr})." Evidence: `{inv_curr, po_curr}`. |
| **R-05** | Missing Critical Fields | Any of `vendor_name`, `invoice_number`, `invoice_date`, `currency`, `total_amount` is `null` or `total_amount <= 0` (unless Credit Note) | `REVIEW` | `MISSING_REQUIRED_FIELD` | `HIGH` | "Missing critical invoice fields: {missing_fields}. Manual entry/verification required." Evidence: `{missing_fields[]}`. |
| **R-06** | Arithmetic Inconsistency | `subtotal + tax - discount != total_amount` (delta `> $0.02`) OR `sum(line_total) != subtotal` (delta `> $0.02`) | `REVIEW` | `ARITHMETIC_MISMATCH` | `HIGH` | "Document arithmetic mismatch: calculated {calc_total} vs stated {total_amount} (delta {delta})." Evidence: `{subtotal, tax, discount, stated_total, line_sum}`. |
| **R-07** | Unverified / Unknown Vendor | Vendor not matched (`NONE`), fuzzy match only (`FUZZY`), or `verification_status == 'UNVERIFIED'` | `REVIEW` | `VENDOR_UNVERIFIED` | `HIGH` | "Vendor '{extracted_name}' could not be matched to an APPROVED vendor." Evidence: `{match_method, candidates[]}`. |
| **R-08** | Missing PO Reference | `invoice.po_number` is `null` (even if an implied PO candidate exists) | `REVIEW` | `PO_MISSING` | `MEDIUM` | "Invoice does not state a PO number. Suggested candidate(s): {candidates}." Evidence: `{candidate_po_ids[]}`. |
| **R-09** | PO Not Found / Vendor Mismatch | Extracted `po_number` not found in DB, OR PO belongs to a different `vendor_id` | `REVIEW` | `PO_INVALID_OR_MISMATCH` | `HIGH` | "PO {po_number} not found or belongs to another vendor." Evidence: `{extracted_po, po_vendor_id, inv_vendor_id}`. |
| **R-10** | Ambiguous PO Match | Multiple open POs match vendor/line criteria when resolving implied PO | `REVIEW` | `PO_AMBIGUOUS` | `MEDIUM` | "Multiple open POs ({po_list}) could apply; human selection required." Evidence: `{candidate_po_ids[]}`. |
| **R-11** | Tolerance Exceeded (Over-PO) | `invoice.total > po_remaining_before` AND `overrun > min(po.original * tol_pct, tol_abs)` | `REVIEW` | `TOLERANCE_EXCEEDED` | `HIGH` | "Invoice ({total}) exceeds PO {po_number} remaining balance ({remaining}) by {overrun} ({overrun_pct}%), exceeding cap ({allowed_cap})." Evidence: `{po_original, prior_consumed, remaining, overrun, allowed_cap}`. |
| **R-12** | Within Tolerance (Minor Variance) | `0 < (invoice.total - po_remaining_before) <= allowed_cap` | `APPROVE` (Note) | `WITHIN_TOLERANCE` | `INFO` | "Invoice exceeds PO remaining balance by {overrun}, within allowed tolerance ({allowed_cap}). Auto-approved." Evidence: `{overrun, allowed_cap}`. |
| **R-13** | Low Extraction Confidence | Any required field confidence `< settings.confidence_threshold` (default `0.85`) | `REVIEW` | `LOW_EXTRACTION_CONFIDENCE` | `MEDIUM` | "Extraction confidence below {threshold}% on: {low_fields}." Evidence: `{field_confidence, threshold}`. |
| **R-14** | Credit Note | `document_type == 'CREDIT_NOTE'` | `REVIEW` | `CREDIT_NOTE_REVIEW` | `MEDIUM` | "Document identified as a Credit Note ({total}); requires AP review before ledger credit." Evidence: `{document_type, total}`. |
| **R-15** | Near-Duplicate Warning | Same vendor + identical total + date within `±3 days` (different invoice #) | `REVIEW` | `NEAR_DUPLICATE_WARNING` | `MEDIUM` | "Resembles recent invoice {conflict_inv_no} from same vendor for identical amount {total}." Evidence: `{conflict_invoice_id}`. |
| **R-16** | High-Value Policy Cap | `invoice.total > settings.auto_approve_max_amount` (if configured, e.g. `$25,000`) | `REVIEW` | `EXCEEDS_AUTO_APPROVE_CAP` | `MEDIUM` | "Invoice amount ({total}) exceeds straight-through auto-approval limit ({cap})." Evidence: `{total, cap}`. |
| **R-00** | Clean Straight-Through | None of `R-01`–`R-16` (except optional `R-12` minor tolerance) triggered; all checks pass | `APPROVE` | `AUTO_APPROVED_MATCH` | `INFO` | "Verified vendor, unique invoice, exact arithmetic, high confidence, and PO {po_number} balance sufficient." Evidence: `{po_number, remaining_after}`. |

---

## 4. Decision Precedence Policy

Because multiple rules can trigger simultaneously on a messy invoice (e.g., an invoice might have *both* `LOW_EXTRACTION_CONFIDENCE` (`REVIEW`) and `DUPLICATE_INVOICE` (`REJECT`)), the engine enforces strict deterministic precedence:

1. **Tier 1 — `REJECT` Rules (`R-01` → `R-02` → `R-03` → `R-04`):**
   - If **any** `REJECT` rule triggers, final `business_decision = REJECT`.
   - `primary_reason_code` is selected by rule priority order (`VENDOR_BLOCKED` > `DUPLICATE_INVOICE` > `PO_CLOSED` > `CURRENCY_MISMATCH`).
2. **Tier 2 — `REVIEW` Rules (`R-05` → `R-06` → `R-07` → `R-08` → `R-09` → `R-10` → `R-11` → `R-13` → `R-14` → `R-15` → `R-16`):**
   - If zero `REJECT` rules triggered and **one or more** `REVIEW` rules triggered, final `business_decision = REVIEW`.
   - `primary_reason_code` is the highest-severity (`HIGH` before `MEDIUM`) / lowest rule number triggered; *all* triggered rules are stored in `triggered_rules[]` and displayed in the UI so the reviewer fixes everything in one pass.
3. **Tier 3 — `APPROVE` (`R-12` or `R-00`):**
   - Only reachable when **zero** `REJECT` and **zero** `REVIEW` rules trigger. Uncertainty never auto-approves.

---

## 5. Multi-Invoice PO Balance Calculation & Split Invoices

When a vendor splits one Purchase Order across multiple invoices (Edge Case E3):
- Let $O = \text{po.original\_amount}$.
- Let $C_{\text{prior}} = \sum_{i \in \text{ApprovedInvoices(PO)}} i.\text{total\_amount}$ (persisted atomically as `po.consumed_amount` under row lock `SELECT ... FOR UPDATE`).
- Remaining balance prior to current invoice: $R_{\text{before}} = O - C_{\text{prior}}$.
- For an incoming invoice with amount $A$:
  - **Valid Partial / Split Invoice:** If $A < R_{\text{before}}$, the invoice is **within remaining commitment**. If approved, $C_{\text{new}} = C_{\text{prior}} + A$, $R_{\text{after}} = O - C_{\text{new}} > 0$, and PO status becomes `PARTIALLY_CONSUMED`.
  - **Final Consuming Invoice:** If $A == R_{\text{before}}$ (or within tolerance $A - R_{\text{before}} \le \text{allowed\_cap}$), PO status becomes `FULLY_CONSUMED` upon approval ($R_{\text{after}} = \max(0, O - C_{\text{new}})$).
  - **Over-Consuming Invoice:** If $A - R_{\text{before}} > \text{allowed\_cap}$, `R-11` (`TOLERANCE_EXCEEDED`) triggers `REVIEW`, and `po.consumed_amount` is **not** modified unless an AP Manager explicitly overrides and approves it.

---

## 6. Reviewer Override & Immutability Contract

When an AP Manager resolves a `REVIEW` item (`POST /api/v1/invoices/:id/review`):
1. A mandatory `note` (`>= 10` characters) is validated and stored in `review_actions`.
2. The `decisions` row created by Stage 8 is **immutable**—its `outcome` (`REVIEW`) is never updated.
3. `invoices.review_status` transitions to `APPROVED_BY_HUMAN` or `REJECTED_BY_HUMAN`.
4. If `APPROVED_BY_HUMAN` and linked to a PO, `po.consumed_amount` is incremented atomically inside the same DB transaction (unless already consumed by a prior approval).
5. `audit_logs` records `{ original_decision: "REVIEW", override_decision: "APPROVED_BY_HUMAN", actor_id, note }`.
