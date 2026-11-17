export const DEFAULT_REJECTION_SUBJECT_TEMPLATE =
  'Action Required: Invoice [Invoice Number] Rejected — [Primary Reason Code]';

export const DEFAULT_REJECTION_BODY_TEMPLATE = `Dear [Vendor Name] Billing Team,

Thank you for submitting invoice [Invoice Number] ([Invoice Amount]) referencing Purchase Order [PO Number]. After review by [Workspace Name] Accounts Payable, we are unable to approve this invoice for payment.

Reason for Rejection:
[Reason for Rejection]

Required Next Steps:
[Remediation Steps]

Please submit a corrected invoice or supporting documentation referencing [Invoice Number] so we can expedite processing.

Regards,
Accounts Payable Team
[Workspace Name]`;

export interface RejectionPlaceholderToken {
  token: string;
  label: string;
  description: string;
  sampleValue: string;
}

export const REJECTION_PLACEHOLDER_TOKENS: RejectionPlaceholderToken[] = [
  {
    token: '[Vendor Name]',
    label: 'Vendor Name',
    description: 'Matched canonical vendor or extracted supplier name',
    sampleValue: 'Summit Precision Supplies',
  },
  {
    token: '[Invoice Number]',
    label: 'Invoice Number',
    description: 'Extracted invoice number or uploaded filename',
    sampleValue: 'INV-2026-0311',
  },
  {
    token: '[Reason for Rejection]',
    label: 'Reason for Rejection',
    description: 'AI-generated explanation or deterministic rule reason',
    sampleValue:
      'Invoice INV-2026-0311 references PO-2026-900 which is currently CLOSED, and line-item arithmetic shows a $45.00 discrepancy.',
  },
  {
    token: '[Detailed Explanation]',
    label: 'Detailed Explanation',
    description: 'Full AI audit breakdown citing rules and evidence',
    sampleValue:
      'Rule R-09 triggered because PO-2026-900 has status CLOSED ($0.00 remaining balance). Subtotal ($1,200.00) + Tax ($120.00) = $1,320.00 vs stated total $1,365.00.',
  },
  {
    token: '[Remediation Steps]',
    label: 'Remediation Steps',
    description: 'Bulleted checklist of required vendor corrections',
    sampleValue:
      '- Obtain an active Purchase Order from your buyer contact.\n- Correct the invoice total arithmetic to $1,320.00 and resubmit.',
  },
  {
    token: '[Primary Reason Code]',
    label: 'Primary Reason Code',
    description: 'Deterministic engine code (e.g. DUPLICATE_INVOICE)',
    sampleValue: 'PO_CLOSED_OR_CANCELLED',
  },
  {
    token: '[PO Number]',
    label: 'PO Number',
    description: 'Matched or extracted Purchase Order reference',
    sampleValue: 'PO-2026-900',
  },
  {
    token: '[Invoice Amount]',
    label: 'Invoice Amount',
    description: 'Formatted currency and invoice grand total',
    sampleValue: '$1,365.00',
  },
  {
    token: '[Invoice Date]',
    label: 'Invoice Date',
    description: 'Extracted invoice issue date',
    sampleValue: '2026-10-18',
  },
  {
    token: '[Workspace Name]',
    label: 'Workspace Name',
    description: 'Configured organization workspace name',
    sampleValue: 'InvoiceDesk',
  },
];

export interface RejectionTemplateContext {
  vendorName?: string | null;
  invoiceNumber?: string | null;
  reasonForRejection?: string | null;
  detailedExplanation?: string | null;
  remediationSteps?: string[] | string | null;
  primaryReasonCode?: string | null;
  poNumber?: string | null;
  invoiceAmount?: string | null;
  invoiceDate?: string | null;
  workspaceName?: string | null;
}

export function formatRemediationStepsText(steps: string[] | string | null | undefined): string {
  if (!steps) {
    return '- Review the discrepancy noted above and submit an updated PDF invoice.';
  }
  if (typeof steps === 'string') {
    return steps.trim() || '- Review the discrepancy noted above and submit an updated PDF invoice.';
  }
  const clean = steps.map((s) => s.trim()).filter(Boolean);
  if (clean.length === 0) {
    return '- Review the discrepancy noted above and submit an updated PDF invoice.';
  }
  return clean.map((s) => (s.startsWith('-') || s.startsWith('•') ? s : `- ${s}`)).join('\n');
}

export function renderRejectionTemplate(
  template: string,
  ctx: RejectionTemplateContext
): { rendered: string; unresolvedTokens: string[] } {
  const replacements: Record<string, string> = {
    '[Vendor Name]': ctx.vendorName?.trim() || 'Vendor',
    '[Invoice Number]': ctx.invoiceNumber?.trim() || 'Unnumbered Invoice',
    '[Reason for Rejection]':
      ctx.reasonForRejection?.trim() || 'Invoice failed Accounts Payable validation policy.',
    '[Detailed Explanation]':
      ctx.detailedExplanation?.trim() ||
      ctx.reasonForRejection?.trim() ||
      'Invoice failed Accounts Payable validation policy.',
    '[Remediation Steps]': formatRemediationStepsText(ctx.remediationSteps),
    '[Primary Reason Code]': ctx.primaryReasonCode?.trim() || 'POLICY_REJECTION',
    '[PO Number]': ctx.poNumber?.trim() || 'N/A',
    '[Invoice Amount]': ctx.invoiceAmount?.trim() || 'N/A',
    '[Invoice Date]': ctx.invoiceDate?.trim() || 'N/A',
    '[Workspace Name]': ctx.workspaceName?.trim() || 'InvoiceDesk',
  };

  let out = template;
  for (const [token, value] of Object.entries(replacements)) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), value);
  }

  const remainingMatches = out.match(/\[[^\]\n]{2,40}\]/g) || [];
  const unresolvedTokens = Array.from(new Set(remainingMatches));
  return { rendered: out, unresolvedTokens };
}

export function buildSampleRejectionContext(workspaceName = 'InvoiceDesk'): RejectionTemplateContext {
  const map = Object.fromEntries(REJECTION_PLACEHOLDER_TOKENS.map((t) => [t.token, t.sampleValue]));
  return {
    vendorName: map['[Vendor Name]'],
    invoiceNumber: map['[Invoice Number]'],
    reasonForRejection: map['[Reason for Rejection]'],
    detailedExplanation: map['[Detailed Explanation]'],
    remediationSteps: map['[Remediation Steps]'],
    primaryReasonCode: map['[Primary Reason Code]'],
    poNumber: map['[PO Number]'],
    invoiceAmount: map['[Invoice Amount]'],
    invoiceDate: map['[Invoice Date]'],
    workspaceName: workspaceName || map['[Workspace Name]'],
  };
}
