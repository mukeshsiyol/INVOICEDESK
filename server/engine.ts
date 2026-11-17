import type { DatabaseSync } from 'node:sqlite';
import Decimal from 'decimal.js';
import type { ExtractedInvoicePayload } from './extraction.ts';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type DecisionOutcome = 'APPROVE' | 'REVIEW' | 'REJECT';
export type RuleSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'INFO';

export interface TriggeredRule {
  rule_id: string;
  reason_code: string;
  decision: DecisionOutcome;
  severity: RuleSeverity;
  message: string;
  evidence: Record<string, unknown>;
}

export interface ApplicationSettingsRow {
  workspace_name: string;
  default_currency: string;
  max_upload_mb: number;
  ocr_min_chars_per_page: number;
  force_ocr: number;
  tolerance_pct: string;
  tolerance_abs: string;
  tolerance_mode: string;
  confidence_threshold: string;
  auto_approve_max_amount: string | null;
  notify_on_review: number;
  notify_on_failure: number;
}

export interface ValidationResult {
  passed: boolean;
  missingFields: string[];
  arithmeticValid: boolean;
  arithmeticDelta: string | null;
  lineSumDelta: string | null;
  expectedTotal: string | null;
  statedTotal: string | null;
  lowConfidenceFields: Array<{ field: string; confidence: number; threshold: number }>;
  isCreditNote: boolean;
}

export interface VendorVerificationResult {
  matchedVendorId: string | null;
  canonicalName: string | null;
  vendorCode: string | null;
  matchMethod: 'EXACT_NAME' | 'ALIAS' | 'TAX_ID' | 'FUZZY' | 'NONE';
  similarityScore: number;
  vendorStatus: 'APPROVED' | 'UNVERIFIED' | 'BLOCKED' | null;
  extractedVendorName: string | null;
  candidates: Array<{ id: string; canonical_name: string; score: number }>;
}

export interface DuplicateCheckResult {
  isExactFileDuplicate: boolean;
  isBusinessDuplicate: boolean;
  isNearDuplicate: boolean;
  conflictingInvoiceId: string | null;
  conflictingInvoiceNumber: string | null;
  conflictingFilename: string | null;
  conflictingCreatedAt: string | null;
  matchType: 'FILE_SHA256' | 'VENDOR_INVOICE_KEY' | 'NEAR_DUPLICATE' | 'NONE';
}

export interface PoMatchResult {
  matchStatus: 'EXACT' | 'IMPLIED_SINGLE' | 'AMBIGUOUS' | 'NOT_FOUND' | 'VENDOR_MISMATCH' | 'MISSING_REF';
  matchedPoId: string | null;
  matchedPoNumber: string | null;
  poStatus: string | null;
  poCurrency: string | null;
  poOriginalAmount: string | null;
  priorConsumedAmount: string | null;
  poVendorId: string | null;
  candidatePos: Array<{ id: string; po_number: string; remaining_amount: string; currency: string }>;
  priorApprovedInvoices: Array<{ id: string; invoice_number: string | null; total_amount: string; created_at: string }>;
}

export interface ToleranceResult {
  evaluated: boolean;
  currencyMatch: boolean;
  remainingBefore: string | null;
  remainingAfter: string | null;
  overrunAmount: string | null;
  overrunPct: string | null;
  allowedCap: string | null;
  withinTolerance: boolean;
  isPartialInvoice: boolean;
}

export function normalizeDocNumber(val: string | null | undefined): string | null {
  if (!val) return null;
  const cleaned = val.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

export function normalizeVendorName(val: string | null | undefined): string {
  if (!val) return '';
  return val
    .toLowerCase()
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|gmbh|plc|pty)\b\.?/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      map.set(bg, (map.get(bg) ?? 0) + 1);
    }
    return map;
  };
  const mapA = bigrams(a);
  const mapB = bigrams(b);
  let overlap = 0;
  for (const [bg, countA] of mapA.entries()) {
    const countB = mapB.get(bg) ?? 0;
    overlap += Math.min(countA, countB);
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

export function parseDecimalSafe(val: string | null | undefined): Decimal | null {
  if (val === null || val === undefined) return null;
  const cleaned = String(val).replace(/[$,\s]/g, '').trim();
  if (!cleaned) return null;
  try {
    return new Decimal(cleaned);
  } catch {
    return null;
  }
}

export function runStage3Validation(
  extracted: ExtractedInvoicePayload,
  settings: ApplicationSettingsRow
): ValidationResult {
  const missingFields: string[] = [];
  if (!extracted.vendor.name?.trim()) missingFields.push('vendor_name');
  if (!extracted.invoice_number?.trim()) missingFields.push('invoice_number');
  if (!extracted.invoice_date?.trim()) missingFields.push('invoice_date');
  if (!extracted.currency?.trim()) missingFields.push('currency');

  const totalDec = parseDecimalSafe(extracted.total_amount);
  const isCreditNote =
    extracted.document_type === 'CREDIT_NOTE' || (totalDec !== null && totalDec.isNegative());

  if (totalDec === null || (!isCreditNote && totalDec.lte(0))) {
    missingFields.push('total_amount');
  }

  const subDec = parseDecimalSafe(extracted.subtotal);
  const taxDec = parseDecimalSafe(extracted.tax_amount) ?? new Decimal(0);
  const discDec = parseDecimalSafe(extracted.discount_amount) ?? new Decimal(0);

  let arithmeticValid = true;
  let arithmeticDelta: string | null = null;
  let expectedTotal: string | null = null;
  let lineSumDelta: string | null = null;
  const roundingTol = new Decimal('0.02');

  if (totalDec !== null && subDec !== null) {
    const calc = subDec.plus(taxDec).minus(discDec);
    expectedTotal = calc.toFixed(2);
    const delta = totalDec.minus(calc);
    if (delta.abs().gt(roundingTol)) {
      arithmeticValid = false;
      arithmeticDelta = delta.toFixed(2);
    } else {
      arithmeticDelta = '0.00';
    }
  }

  if (extracted.line_items.length > 0 && subDec !== null) {
    let lineSum = new Decimal(0);
    let allLinesValid = true;
    for (const line of extracted.line_items) {
      const lt = parseDecimalSafe(line.line_total);
      if (lt === null) {
        allLinesValid = false;
        break;
      }
      lineSum = lineSum.plus(lt);
    }
    if (allLinesValid) {
      const lDelta = subDec.minus(lineSum);
      if (lDelta.abs().gt(roundingTol)) {
        arithmeticValid = false;
        lineSumDelta = lDelta.toFixed(2);
      }
    }
  }

  const threshold = Number(settings.confidence_threshold || '0.85');
  const criticalKeys: Array<keyof ExtractedInvoicePayload['field_confidence']> = [
    'vendor_name',
    'invoice_number',
    'invoice_date',
    'currency',
    'total_amount',
  ];
  const lowConfidenceFields: Array<{ field: string; confidence: number; threshold: number }> = [];

  for (const key of criticalKeys) {
    if (missingFields.includes(key)) continue;
    const conf = extracted.field_confidence[key];
    if (typeof conf === 'number' && conf < threshold) {
      lowConfidenceFields.push({ field: key, confidence: Number(conf.toFixed(3)), threshold });
    }
  }
  if (extracted.po_number && extracted.field_confidence.po_number < threshold) {
    lowConfidenceFields.push({
      field: 'po_number',
      confidence: Number(extracted.field_confidence.po_number.toFixed(3)),
      threshold,
    });
  }

  return {
    passed: missingFields.length === 0 && arithmeticValid && lowConfidenceFields.length === 0 && !isCreditNote,
    missingFields,
    arithmeticValid,
    arithmeticDelta,
    lineSumDelta,
    expectedTotal,
    statedTotal: totalDec ? totalDec.toFixed(2) : null,
    lowConfidenceFields,
    isCreditNote,
  };
}

export function runStage4VendorVerification(
  db: DatabaseSync,
  extracted: ExtractedInvoicePayload
): VendorVerificationResult {
  const rawName = extracted.vendor.name?.trim() || null;
  const rawTaxId = extracted.vendor.tax_id?.trim() || null;

  const vendors = db
    .prepare(
      'SELECT id, vendor_code, canonical_name, normalized_name, aliases, tax_id, verification_status FROM vendors'
    )
    .all() as Array<{
    id: string;
    vendor_code: string;
    canonical_name: string;
    normalized_name: string;
    aliases: string;
    tax_id: string | null;
    verification_status: 'APPROVED' | 'UNVERIFIED' | 'BLOCKED';
  }>;

  if (rawTaxId) {
    const normTax = rawTaxId.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const byTax = vendors.find(
      (v) => v.tax_id && v.tax_id.replace(/[^A-Z0-9]/gi, '').toUpperCase() === normTax
    );
    if (byTax) {
      return {
        matchedVendorId: byTax.id,
        canonicalName: byTax.canonical_name,
        vendorCode: byTax.vendor_code,
        matchMethod: 'TAX_ID',
        similarityScore: 1,
        vendorStatus: byTax.verification_status,
        extractedVendorName: rawName,
        candidates: [],
      };
    }
  }

  if (!rawName) {
    return {
      matchedVendorId: null,
      canonicalName: null,
      vendorCode: null,
      matchMethod: 'NONE',
      similarityScore: 0,
      vendorStatus: null,
      extractedVendorName: null,
      candidates: [],
    };
  }

  const normInput = normalizeVendorName(rawName);

  for (const v of vendors) {
    if (v.normalized_name === normInput || v.canonical_name.toLowerCase() === rawName.toLowerCase()) {
      return {
        matchedVendorId: v.id,
        canonicalName: v.canonical_name,
        vendorCode: v.vendor_code,
        matchMethod: 'EXACT_NAME',
        similarityScore: 1,
        vendorStatus: v.verification_status,
        extractedVendorName: rawName,
        candidates: [],
      };
    }
  }

  for (const v of vendors) {
    let aliases: string[] = [];
    try {
      aliases = JSON.parse(v.aliases);
    } catch {
      aliases = [];
    }
    const matchedAlias = aliases.some(
      (a) => a.toLowerCase() === rawName.toLowerCase() || normalizeVendorName(a) === normInput
    );
    if (matchedAlias) {
      return {
        matchedVendorId: v.id,
        canonicalName: v.canonical_name,
        vendorCode: v.vendor_code,
        matchMethod: 'ALIAS',
        similarityScore: 1,
        vendorStatus: v.verification_status,
        extractedVendorName: rawName,
        candidates: [],
      };
    }
  }

  const scored = vendors
    .map((v) => {
      let aliases: string[] = [];
      try {
        aliases = JSON.parse(v.aliases);
      } catch {
        aliases = [];
      }
      const scores = [
        diceSimilarity(normInput, v.normalized_name),
        ...aliases.map((a) => diceSimilarity(normInput, normalizeVendorName(a))),
      ];
      return {
        v,
        score: Math.max(...scores),
      };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (top && top.score >= 0.72) {
    return {
      matchedVendorId: top.v.id,
      canonicalName: top.v.canonical_name,
      vendorCode: top.v.vendor_code,
      matchMethod: 'FUZZY',
      similarityScore: Number(top.score.toFixed(3)),
      vendorStatus: top.v.verification_status,
      extractedVendorName: rawName,
      candidates: scored.slice(0, 3).map((s) => ({
        id: s.v.id,
        canonical_name: s.v.canonical_name,
        score: Number(s.score.toFixed(3)),
      })),
    };
  }

  return {
    matchedVendorId: null,
    canonicalName: null,
    vendorCode: null,
    matchMethod: 'NONE',
    similarityScore: top ? Number(top.score.toFixed(3)) : 0,
    vendorStatus: null,
    extractedVendorName: rawName,
    candidates: scored
      .filter((s) => s.score > 0.35)
      .slice(0, 3)
      .map((s) => ({
        id: s.v.id,
        canonical_name: s.v.canonical_name,
        score: Number(s.score.toFixed(3)),
      })),
  };
}

export function runStage5DuplicateDetection(
  db: DatabaseSync,
  invoiceId: string,
  fileSha256: string,
  vendorResult: VendorVerificationResult,
  extracted: ExtractedInvoicePayload
): DuplicateCheckResult {
  // 1. Exact binary SHA-256 check against prior non-failed invoices
  const fileMatch = db
    .prepare(
      `SELECT id, invoice_number, original_filename, created_at
       FROM invoices
       WHERE file_sha256 = ? AND id != ? AND processing_status = 'COMPLETED' AND business_decision != 'REJECT'
       ORDER BY created_at ASC LIMIT 1`
    )
    .get(fileSha256, invoiceId) as
    | { id: string; invoice_number: string | null; original_filename: string; created_at: string }
    | undefined;

  if (fileMatch) {
    return {
      isExactFileDuplicate: true,
      isBusinessDuplicate: true,
      isNearDuplicate: false,
      conflictingInvoiceId: fileMatch.id,
      conflictingInvoiceNumber: fileMatch.invoice_number,
      conflictingFilename: fileMatch.original_filename,
      conflictingCreatedAt: fileMatch.created_at,
      matchType: 'FILE_SHA256',
    };
  }

  // 2. Semantic business-key check: (vendor_id, normalized_invoice_number)
  const normInvNo = normalizeDocNumber(extracted.invoice_number);
  if (vendorResult.matchedVendorId && normInvNo) {
    const bizMatch = db
      .prepare(
        `SELECT id, invoice_number, original_filename, created_at
         FROM invoices
         WHERE vendor_id = ? AND normalized_invoice_number = ? AND id != ?
           AND processing_status = 'COMPLETED'
           AND (business_decision = 'APPROVE' OR review_status = 'APPROVED_BY_HUMAN' OR business_decision = 'REVIEW')
         ORDER BY created_at ASC LIMIT 1`
      )
      .get(vendorResult.matchedVendorId, normInvNo, invoiceId) as
      | { id: string; invoice_number: string | null; original_filename: string; created_at: string }
      | undefined;

    if (bizMatch) {
      return {
        isExactFileDuplicate: false,
        isBusinessDuplicate: true,
        isNearDuplicate: false,
        conflictingInvoiceId: bizMatch.id,
        conflictingInvoiceNumber: bizMatch.invoice_number,
        conflictingFilename: bizMatch.original_filename,
        conflictingCreatedAt: bizMatch.created_at,
        matchType: 'VENDOR_INVOICE_KEY',
      };
    }
  }

  // 3. Near-duplicate heuristic: same vendor + exact total + invoice_date within +-3 days
  const totalDec = parseDecimalSafe(extracted.total_amount);
  if (vendorResult.matchedVendorId && totalDec && extracted.invoice_date) {
    const candidates = db
      .prepare(
        `SELECT id, invoice_number, original_filename, total_amount, invoice_date, created_at
         FROM invoices
         WHERE vendor_id = ? AND id != ? AND processing_status = 'COMPLETED' AND business_decision != 'REJECT'
           AND total_amount IS NOT NULL AND invoice_date IS NOT NULL`
      )
      .all(vendorResult.matchedVendorId, invoiceId) as Array<{
      id: string;
      invoice_number: string | null;
      original_filename: string;
      total_amount: string;
      invoice_date: string;
      created_at: string;
    }>;

    const currDateMs = Date.parse(extracted.invoice_date);
    for (const c of candidates) {
      const cTotal = parseDecimalSafe(c.total_amount);
      const cDateMs = Date.parse(c.invoice_date);
      if (
        cTotal &&
        cTotal.eq(totalDec) &&
        !Number.isNaN(currDateMs) &&
        !Number.isNaN(cDateMs) &&
        Math.abs(currDateMs - cDateMs) <= 3 * 24 * 60 * 60 * 1000
      ) {
        return {
          isExactFileDuplicate: false,
          isBusinessDuplicate: false,
          isNearDuplicate: true,
          conflictingInvoiceId: c.id,
          conflictingInvoiceNumber: c.invoice_number,
          conflictingFilename: c.original_filename,
          conflictingCreatedAt: c.created_at,
          matchType: 'NEAR_DUPLICATE',
        };
      }
    }
  }

  return {
    isExactFileDuplicate: false,
    isBusinessDuplicate: false,
    isNearDuplicate: false,
    conflictingInvoiceId: null,
    conflictingInvoiceNumber: null,
    conflictingFilename: null,
    conflictingCreatedAt: null,
    matchType: 'NONE',
  };
}

export function runStage6PoMatching(
  db: DatabaseSync,
  extracted: ExtractedInvoicePayload,
  vendorResult: VendorVerificationResult
): PoMatchResult {
  const normPo = normalizeDocNumber(extracted.po_number);

  const fetchPriorInvoices = (poId: string) =>
    db
      .prepare(
        `SELECT id, invoice_number, total_amount, created_at
         FROM invoices
         WHERE purchase_order_id = ? AND po_consumed_applied = 1
         ORDER BY created_at ASC`
      )
      .all(poId) as Array<{ id: string; invoice_number: string | null; total_amount: string; created_at: string }>;

  if (normPo) {
    const po = db
      .prepare(
        `SELECT id, po_number, vendor_id, currency, original_amount, consumed_amount, status
         FROM purchase_orders WHERE normalized_po_number = ?`
      )
      .get(normPo) as
      | {
          id: string;
          po_number: string;
          vendor_id: string;
          currency: string;
          original_amount: string;
          consumed_amount: string;
          status: string;
        }
      | undefined;

    if (!po) {
      return {
        matchStatus: 'NOT_FOUND',
        matchedPoId: null,
        matchedPoNumber: extracted.po_number,
        poStatus: null,
        poCurrency: null,
        poOriginalAmount: null,
        priorConsumedAmount: null,
        poVendorId: null,
        candidatePos: [],
        priorApprovedInvoices: [],
      };
    }

    if (vendorResult.matchedVendorId && po.vendor_id !== vendorResult.matchedVendorId) {
      return {
        matchStatus: 'VENDOR_MISMATCH',
        matchedPoId: po.id,
        matchedPoNumber: po.po_number,
        poStatus: po.status,
        poCurrency: po.currency,
        poOriginalAmount: po.original_amount,
        priorConsumedAmount: po.consumed_amount,
        poVendorId: po.vendor_id,
        candidatePos: [],
        priorApprovedInvoices: fetchPriorInvoices(po.id),
      };
    }

    return {
      matchStatus: 'EXACT',
      matchedPoId: po.id,
      matchedPoNumber: po.po_number,
      poStatus: po.status,
      poCurrency: po.currency,
      poOriginalAmount: po.original_amount,
      priorConsumedAmount: po.consumed_amount,
      poVendorId: po.vendor_id,
      candidatePos: [],
      priorApprovedInvoices: fetchPriorInvoices(po.id),
    };
  }

  // No explicit PO number extracted -> inspect open POs for matched vendor as implied candidates
  if (vendorResult.matchedVendorId) {
    const openPos = db
      .prepare(
        `SELECT id, po_number, currency, original_amount, consumed_amount, status
         FROM purchase_orders
         WHERE vendor_id = ? AND status IN ('OPEN', 'PARTIALLY_CONSUMED')
         ORDER BY issued_date DESC`
      )
      .all(vendorResult.matchedVendorId) as Array<{
      id: string;
      po_number: string;
      currency: string;
      original_amount: string;
      consumed_amount: string;
      status: string;
    }>;

    const candidates = openPos.map((p) => ({
      id: p.id,
      po_number: p.po_number,
      remaining_amount: new Decimal(p.original_amount).minus(p.consumed_amount).toFixed(2),
      currency: p.currency,
    }));

    return {
      matchStatus: openPos.length > 1 ? 'AMBIGUOUS' : openPos.length === 1 ? 'IMPLIED_SINGLE' : 'MISSING_REF',
      matchedPoId: null,
      matchedPoNumber: null,
      poStatus: null,
      poCurrency: null,
      poOriginalAmount: null,
      priorConsumedAmount: null,
      poVendorId: null,
      candidatePos: candidates,
      priorApprovedInvoices: [],
    };
  }

  return {
    matchStatus: 'MISSING_REF',
    matchedPoId: null,
    matchedPoNumber: null,
    poStatus: null,
    poCurrency: null,
    poOriginalAmount: null,
    priorConsumedAmount: null,
    poVendorId: null,
    candidatePos: [],
    priorApprovedInvoices: [],
  };
}

export function runStage7ToleranceVerification(
  poMatch: PoMatchResult,
  extracted: ExtractedInvoicePayload,
  settings: ApplicationSettingsRow
): ToleranceResult {
  const totalDec = parseDecimalSafe(extracted.total_amount);

  if (
    poMatch.matchStatus !== 'EXACT' ||
    !poMatch.poOriginalAmount ||
    !poMatch.priorConsumedAmount ||
    totalDec === null
  ) {
    return {
      evaluated: false,
      currencyMatch: true,
      remainingBefore: null,
      remainingAfter: null,
      overrunAmount: null,
      overrunPct: null,
      allowedCap: null,
      withinTolerance: false,
      isPartialInvoice: false,
    };
  }

  const currencyMatch =
    !extracted.currency || extracted.currency.toUpperCase() === (poMatch.poCurrency || '').toUpperCase();

  const poOriginal = new Decimal(poMatch.poOriginalAmount);
  const priorConsumed = new Decimal(poMatch.priorConsumedAmount);
  const remainingBefore = Decimal.max(new Decimal(0), poOriginal.minus(priorConsumed));
  const remainingAfter = Decimal.max(new Decimal(0), remainingBefore.minus(totalDec));

  const tolPct = new Decimal(settings.tolerance_pct || '2.00');
  const tolAbs = new Decimal(settings.tolerance_abs || '10.0000');
  const pctAllowance = poOriginal.mul(tolPct.div(100));

  let allowedCap: Decimal;
  if (settings.tolerance_mode === 'MAX_OF_PCT_AND_ABS') {
    allowedCap = Decimal.max(pctAllowance, tolAbs);
  } else if (settings.tolerance_mode === 'PCT_ONLY') {
    allowedCap = pctAllowance;
  } else {
    allowedCap = Decimal.min(pctAllowance, tolAbs);
  }

  if (totalDec.lte(remainingBefore)) {
    return {
      evaluated: true,
      currencyMatch,
      remainingBefore: remainingBefore.toFixed(2),
      remainingAfter: remainingAfter.toFixed(2),
      overrunAmount: '0.00',
      overrunPct: '0.00',
      allowedCap: allowedCap.toFixed(2),
      withinTolerance: true,
      isPartialInvoice: totalDec.lt(remainingBefore),
    };
  }

  const overrun = totalDec.minus(remainingBefore);
  const overrunPct = poOriginal.gt(0) ? overrun.div(poOriginal).mul(100) : new Decimal(100);
  const withinTolerance = overrun.lte(allowedCap);

  return {
    evaluated: true,
    currencyMatch,
    remainingBefore: remainingBefore.toFixed(2),
    remainingAfter: remainingAfter.toFixed(2),
    overrunAmount: overrun.toFixed(2),
    overrunPct: overrunPct.toFixed(2),
    allowedCap: allowedCap.toFixed(2),
    withinTolerance,
    isPartialInvoice: false,
  };
}

export function runStage8DecisionGeneration(params: {
  validation: ValidationResult;
  vendor: VendorVerificationResult;
  duplicate: DuplicateCheckResult;
  poMatch: PoMatchResult;
  tolerance: ToleranceResult;
  extracted: ExtractedInvoicePayload;
  settings: ApplicationSettingsRow;
}): {
  outcome: DecisionOutcome;
  primaryReasonCode: string;
  triggeredRules: TriggeredRule[];
  explanation: string;
  evidenceSnapshot: Record<string, unknown>;
} {
  const { validation, vendor, duplicate, poMatch, tolerance, extracted, settings } = params;
  const triggered: TriggeredRule[] = [];

  // Tier 1: REJECT Rules (R-01 .. R-04)
  if (vendor.vendorStatus === 'BLOCKED') {
    triggered.push({
      rule_id: 'R-01',
      reason_code: 'VENDOR_BLOCKED',
      decision: 'REJECT',
      severity: 'CRITICAL',
      message: `Vendor '${vendor.canonicalName}' is marked BLOCKED in the vendor master registry.`,
      evidence: { vendor_id: vendor.matchedVendorId, vendor_status: vendor.vendorStatus },
    });
  }

  if (duplicate.isExactFileDuplicate || duplicate.isBusinessDuplicate) {
    triggered.push({
      rule_id: 'R-02',
      reason_code: 'DUPLICATE_INVOICE',
      decision: 'REJECT',
      severity: 'CRITICAL',
      message: `Duplicate of existing invoice ${duplicate.conflictingInvoiceNumber ?? 'record'} (uploaded as '${duplicate.conflictingFilename}').`,
      evidence: {
        match_type: duplicate.matchType,
        conflicting_invoice_id: duplicate.conflictingInvoiceId,
        conflicting_invoice_number: duplicate.conflictingInvoiceNumber,
        conflicting_filename: duplicate.conflictingFilename,
      },
    });
  }

  if (poMatch.poStatus === 'CLOSED' || poMatch.poStatus === 'CANCELLED') {
    triggered.push({
      rule_id: 'R-03',
      reason_code: 'PO_CLOSED',
      decision: 'REJECT',
      severity: 'CRITICAL',
      message: `Referenced purchase order ${poMatch.matchedPoNumber} has status ${poMatch.poStatus} and cannot accept new charges.`,
      evidence: { po_id: poMatch.matchedPoId, po_number: poMatch.matchedPoNumber, po_status: poMatch.poStatus },
    });
  }

  if (poMatch.matchStatus === 'EXACT' && !tolerance.currencyMatch) {
    triggered.push({
      rule_id: 'R-04',
      reason_code: 'CURRENCY_MISMATCH',
      decision: 'REJECT',
      severity: 'CRITICAL',
      message: `Invoice currency (${extracted.currency}) does not match PO ${poMatch.matchedPoNumber} currency (${poMatch.poCurrency}).`,
      evidence: { invoice_currency: extracted.currency, po_currency: poMatch.poCurrency },
    });
  }

  // Tier 2: REVIEW Rules (R-05 .. R-16)
  if (validation.missingFields.length > 0) {
    triggered.push({
      rule_id: 'R-05',
      reason_code: 'MISSING_REQUIRED_FIELD',
      decision: 'REVIEW',
      severity: 'HIGH',
      message: `Missing required invoice fields: ${validation.missingFields.join(', ')}.`,
      evidence: { missing_fields: validation.missingFields },
    });
  }

  if (!validation.arithmeticValid) {
    triggered.push({
      rule_id: 'R-06',
      reason_code: 'ARITHMETIC_MISMATCH',
      decision: 'REVIEW',
      severity: 'HIGH',
      message: `Document arithmetic inconsistency detected (calculated ${validation.expectedTotal ?? 'lines'} vs. stated ${validation.statedTotal ?? 'subtotal'}, delta ${validation.arithmeticDelta ?? validation.lineSumDelta}).`,
      evidence: {
        expected_total: validation.expectedTotal,
        stated_total: validation.statedTotal,
        arithmetic_delta: validation.arithmeticDelta,
        line_sum_delta: validation.lineSumDelta,
      },
    });
  }

  if (
    !vendor.matchedVendorId ||
    vendor.matchMethod === 'FUZZY' ||
    vendor.vendorStatus === 'UNVERIFIED'
  ) {
    triggered.push({
      rule_id: 'R-07',
      reason_code: 'VENDOR_UNVERIFIED',
      decision: 'REVIEW',
      severity: 'HIGH',
      message: !vendor.matchedVendorId
        ? `Extracted vendor '${vendor.extractedVendorName ?? 'Unknown'}' did not match any approved vendor.`
        : vendor.matchMethod === 'FUZZY'
          ? `Vendor '${vendor.extractedVendorName}' only matched '${vendor.canonicalName}' via fuzzy similarity (${Math.round(vendor.similarityScore * 100)}%).`
          : `Matched vendor '${vendor.canonicalName}' has UNVERIFIED status.`,
      evidence: {
        extracted_vendor: vendor.extractedVendorName,
        match_method: vendor.matchMethod,
        similarity: vendor.similarityScore,
        vendor_status: vendor.vendorStatus,
        candidates: vendor.candidates,
      },
    });
  }

  if (poMatch.matchStatus === 'MISSING_REF' || poMatch.matchStatus === 'IMPLIED_SINGLE') {
    triggered.push({
      rule_id: 'R-08',
      reason_code: 'PO_MISSING',
      decision: 'REVIEW',
      severity: 'MEDIUM',
      message:
        poMatch.matchStatus === 'IMPLIED_SINGLE'
          ? `No PO number was stated on the invoice. Implied candidate ${poMatch.candidatePos[0]?.po_number} requires human confirmation.`
          : 'Invoice does not state a purchase order reference.',
      evidence: { candidate_pos: poMatch.candidatePos },
    });
  } else if (poMatch.matchStatus === 'NOT_FOUND' || poMatch.matchStatus === 'VENDOR_MISMATCH') {
    triggered.push({
      rule_id: 'R-09',
      reason_code: 'PO_INVALID_OR_MISMATCH',
      decision: 'REVIEW',
      severity: 'HIGH',
      message:
        poMatch.matchStatus === 'VENDOR_MISMATCH'
          ? `PO ${poMatch.matchedPoNumber} belongs to a different vendor than '${vendor.canonicalName ?? vendor.extractedVendorName}'.`
          : `Extracted PO reference '${poMatch.matchedPoNumber}' was not found in the procurement ledger.`,
      evidence: { match_status: poMatch.matchStatus, extracted_po: extracted.po_number },
    });
  } else if (poMatch.matchStatus === 'AMBIGUOUS') {
    triggered.push({
      rule_id: 'R-10',
      reason_code: 'PO_AMBIGUOUS',
      decision: 'REVIEW',
      severity: 'MEDIUM',
      message: `No PO number stated and vendor has ${poMatch.candidatePos.length} open POs (${poMatch.candidatePos.map((c) => c.po_number).join(', ')}).`,
      evidence: { candidate_pos: poMatch.candidatePos },
    });
  }

  if (tolerance.evaluated && !tolerance.withinTolerance) {
    triggered.push({
      rule_id: 'R-11',
      reason_code: 'TOLERANCE_EXCEEDED',
      decision: 'REVIEW',
      severity: 'HIGH',
      message: `Invoice total ($${extracted.total_amount}) exceeds PO ${poMatch.matchedPoNumber} remaining balance ($${tolerance.remainingBefore}) by $${tolerance.overrunAmount} (${tolerance.overrunPct}%), surpassing allowed cap ($${tolerance.allowedCap}).`,
      evidence: {
        po_number: poMatch.matchedPoNumber,
        po_original: poMatch.poOriginalAmount,
        prior_consumed: poMatch.priorConsumedAmount,
        remaining_before: tolerance.remainingBefore,
        overrun_amount: tolerance.overrunAmount,
        allowed_cap: tolerance.allowedCap,
      },
    });
  }

  if (validation.lowConfidenceFields.length > 0) {
    triggered.push({
      rule_id: 'R-13',
      reason_code: 'LOW_EXTRACTION_CONFIDENCE',
      decision: 'REVIEW',
      severity: 'MEDIUM',
      message: `Extraction confidence fell below ${Math.round(Number(settings.confidence_threshold) * 100)}% on: ${validation.lowConfidenceFields.map((f) => `${f.field} (${Math.round(f.confidence * 100)}%)`).join(', ')}.`,
      evidence: { low_confidence_fields: validation.lowConfidenceFields },
    });
  }

  if (validation.isCreditNote) {
    triggered.push({
      rule_id: 'R-14',
      reason_code: 'CREDIT_NOTE_REVIEW',
      decision: 'REVIEW',
      severity: 'MEDIUM',
      message: `Document classified as a Credit Note (${extracted.total_amount ?? 'N/A'}); requires AP Manager approval before ledger application.`,
      evidence: { document_type: extracted.document_type, total: extracted.total_amount },
    });
  }

  if (duplicate.isNearDuplicate) {
    triggered.push({
      rule_id: 'R-15',
      reason_code: 'NEAR_DUPLICATE_WARNING',
      decision: 'REVIEW',
      severity: 'MEDIUM',
      message: `Resembles prior invoice ${duplicate.conflictingInvoiceNumber} from the same vendor for an identical amount within 3 days.`,
      evidence: { conflicting_invoice_id: duplicate.conflictingInvoiceId },
    });
  }

  const totalDec = parseDecimalSafe(extracted.total_amount);
  const autoCap = parseDecimalSafe(settings.auto_approve_max_amount);
  if (totalDec && autoCap && totalDec.gt(autoCap)) {
    triggered.push({
      rule_id: 'R-16',
      reason_code: 'EXCEEDS_AUTO_APPROVE_CAP',
      decision: 'REVIEW',
      severity: 'MEDIUM',
      message: `Invoice amount ($${totalDec.toFixed(2)}) exceeds straight-through auto-approval ceiling ($${autoCap.toFixed(2)}).`,
      evidence: { total: totalDec.toFixed(2), auto_approve_max_amount: autoCap.toFixed(2) },
    });
  }

  // Tier 3: Precedence Resolution
  const rejectRules = triggered.filter((r) => r.decision === 'REJECT');
  const reviewRules = triggered.filter((r) => r.decision === 'REVIEW');

  let outcome: DecisionOutcome;
  let primaryReasonCode: string;
  let explanation: string;

  if (rejectRules.length > 0) {
    outcome = 'REJECT';
    primaryReasonCode = rejectRules[0].reason_code;
    explanation = rejectRules.map((r) => r.message).join(' ');
  } else if (reviewRules.length > 0) {
    const severityRank: Record<RuleSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 };
    const sorted = [...reviewRules].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
    outcome = 'REVIEW';
    primaryReasonCode = sorted[0].reason_code;
    explanation = sorted.map((r) => r.message).join(' ');
  } else {
    const overrunDec = parseDecimalSafe(tolerance.overrunAmount);
    if (overrunDec && overrunDec.gt(0) && tolerance.withinTolerance) {
      triggered.push({
        rule_id: 'R-12',
        reason_code: 'WITHIN_TOLERANCE',
        decision: 'APPROVE',
        severity: 'INFO',
        message: `Minor overrun of $${tolerance.overrunAmount} against PO ${poMatch.matchedPoNumber} is within allowed tolerance cap ($${tolerance.allowedCap}).`,
        evidence: { overrun_amount: tolerance.overrunAmount, allowed_cap: tolerance.allowedCap },
      });
      primaryReasonCode = 'WITHIN_TOLERANCE';
      explanation = `All validation, vendor, and duplicate checks passed. Minor PO variance ($${tolerance.overrunAmount}) is within policy tolerance ($${tolerance.allowedCap}).`;
    } else {
      triggered.push({
        rule_id: 'R-00',
        reason_code: 'AUTO_APPROVED_MATCH',
        decision: 'APPROVE',
        severity: 'INFO',
        message: `Verified vendor '${vendor.canonicalName}', unique invoice, exact arithmetic, high confidence, and sufficient balance on PO ${poMatch.matchedPoNumber} ($${tolerance.remainingAfter} remaining after invoice).`,
        evidence: {
          po_number: poMatch.matchedPoNumber,
          remaining_before: tolerance.remainingBefore,
          remaining_after: tolerance.remainingAfter,
          is_partial_invoice: tolerance.isPartialInvoice,
        },
      });
      primaryReasonCode = 'AUTO_APPROVED_MATCH';
      explanation = triggered[0].message;
    }
    outcome = 'APPROVE';
  }

  return {
    outcome,
    primaryReasonCode,
    triggeredRules: triggered,
    explanation,
    evidenceSnapshot: {
      validation,
      vendor,
      duplicate,
      poMatch,
      tolerance,
      settings_applied: {
        tolerance_pct: settings.tolerance_pct,
        tolerance_abs: settings.tolerance_abs,
        tolerance_mode: settings.tolerance_mode,
        confidence_threshold: settings.confidence_threshold,
        auto_approve_max_amount: settings.auto_approve_max_amount,
      },
    },
  };
}
