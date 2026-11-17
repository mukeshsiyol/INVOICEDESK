export function buildOpenApiSpec(serverOrigin: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'InvoiceDesk AP Automation API',
      version: '1.0.0',
      description:
        'Accounts Payable Automation Platform API powered by Google AI Studio Gemini structured extraction, deterministic Decimal validation, PO matching, and immutable audit logging.',
    },
    servers: [
      {
        url: `${serverOrigin}/api/v1`,
        description: 'InvoiceDesk API v1',
      },
    ],
    tags: [
      { name: 'System', description: 'Health and OpenAPI metadata' },
      { name: 'Auth', description: 'Session authentication and demo persona switching' },
      { name: 'Invoices', description: 'PDF ingestion, pipeline execution, inspection, and export' },
      { name: 'Runs', description: '8-stage pipeline run status and SSE streaming' },
      { name: 'Reviews', description: 'Exception review queue and human decision overrides' },
      { name: 'Procurement', description: 'Vendors and Purchase Orders' },
      { name: 'Analytics', description: 'Operational KPIs and reporting' },
      { name: 'Audit & Settings', description: 'Immutable audit trail and policy configuration' },
    ],
    paths: {
      '/health': {
        get: {
          tags: ['System'],
          summary: 'Health check',
          responses: { '200': { description: 'Service status' } },
        },
      },
      '/openapi.json': {
        get: {
          tags: ['System'],
          summary: 'Download OpenAPI 3.1 specification',
          responses: { '200': { description: 'OpenAPI 3.1 JSON document' } },
        },
      },
      '/auth/me': {
        get: {
          tags: ['Auth'],
          summary: 'Get current active user and demo/auth status',
          responses: { '200': { description: 'User profile' } },
        },
      },
      '/auth/login': {
        post: {
          tags: ['Auth'],
          summary: 'Authenticate with email and password',
          responses: { '200': { description: 'Session cookie issued' } },
        },
      },
      '/auth/demo-switch': {
        post: {
          tags: ['Auth'],
          summary: 'Switch active demo persona (OPERATOR | REVIEWER | ADMIN)',
          responses: { '200': { description: 'Updated persona session' } },
        },
      },
      '/fixtures': {
        get: {
          tags: ['Invoices'],
          summary: 'List real downloadable edge-case and demo PDF fixtures',
          responses: { '200': { description: 'List of PDF fixtures' } },
        },
      },
      '/invoices/upload': {
        post: {
          tags: ['Invoices'],
          summary: 'Upload up to 10 PDF invoices (multipart/form-data) and optionally start processing',
          responses: { '202': { description: 'Accepted invoices and queued run IDs' } },
        },
      },
      '/invoices/upload-fixture': {
        post: {
          tags: ['Invoices'],
          summary: 'Ingest and run a built-in demo/edge-case PDF fixture',
          responses: { '202': { description: 'Accepted fixture invoice and run ID' } },
        },
      },
      '/invoices': {
        get: {
          tags: ['Invoices'],
          summary: 'Query paginated invoice ledger with search, filters, and sorting',
          responses: { '200': { description: 'Paginated invoice list' } },
        },
      },
      '/invoices/export': {
        get: {
          tags: ['Invoices'],
          summary: 'Export filtered or selected invoices as CSV',
          responses: { '200': { description: 'CSV file download' } },
        },
      },
      '/invoices/{invoiceId}': {
        get: {
          tags: ['Invoices'],
          summary: 'Get full invoice detail, active run, 8-stage events, line items, and decision evidence',
          parameters: [
            { name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'run_id', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Complete processing workspace payload' } },
        },
      },
      '/invoices/{invoiceId}/document': {
        get: {
          tags: ['Invoices'],
          summary: 'Stream stored original PDF document',
          parameters: [{ name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'application/pdf binary stream' } },
        },
      },
      '/invoices/{invoiceId}/start': {
        post: {
          tags: ['Invoices'],
          summary: 'Manually start an unstarted QUEUED processing run',
          parameters: [{ name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '202': { description: 'Processing run started' } },
        },
      },
      '/invoices/{invoiceId}/retry': {
        post: {
          tags: ['Invoices'],
          summary: 'Trigger a new processing run for a completed or failed invoice',
          parameters: [{ name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '202': { description: 'New processing run queued and started' } },
        },
      },
      '/invoices/{invoiceId}/review': {
        post: {
          tags: ['Reviews'],
          summary: 'Submit human APPROVE_OVERRIDE or REJECT_OVERRIDE with mandatory justification note (REVIEWER/ADMIN)',
          parameters: [{ name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Review action persisted and PO debited if approved' } },
        },
      },
      '/runs': {
        get: {
          tags: ['Runs'],
          summary: 'List all historical and active pipeline execution runs',
          responses: { '200': { description: 'Paginated processing runs' } },
        },
      },
      '/runs/{runId}/events': {
        get: {
          tags: ['Runs'],
          summary: 'Server-Sent Events (SSE) stream of 8-stage progress with Last-Event-ID replay',
          parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'text/event-stream' } },
        },
      },
      '/reviews': {
        get: {
          tags: ['Reviews'],
          summary: 'List pending or resolved exception invoices in the Review Queue',
          responses: { '200': { description: 'Review queue items' } },
        },
      },
      '/purchase-orders': {
        get: {
          tags: ['Procurement'],
          summary: 'List purchase orders with real-time utilization metrics',
          responses: { '200': { description: 'Purchase orders list' } },
        },
        post: {
          tags: ['Procurement'],
          summary: 'Create a purchase order (ADMIN)',
          responses: { '201': { description: 'Created purchase order' } },
        },
      },
      '/vendors': {
        get: {
          tags: ['Procurement'],
          summary: 'List vendor master directory with aliases and exception counts',
          responses: { '200': { description: 'Vendor list' } },
        },
        post: {
          tags: ['Procurement'],
          summary: 'Register a vendor (ADMIN)',
          responses: { '201': { description: 'Created vendor' } },
        },
      },
      '/analytics/overview': {
        get: {
          tags: ['Analytics'],
          summary: 'Overview KPIs, volume trends, decision distribution, and recent activity',
          responses: { '200': { description: 'Overview dashboard metrics' } },
        },
      },
      '/analytics/metrics': {
        get: {
          tags: ['Analytics'],
          summary: 'Detailed operational metrics and exception distributions',
          responses: { '200': { description: 'Analytics metrics' } },
        },
      },
      '/audit-logs': {
        get: {
          tags: ['Audit & Settings'],
          summary: 'Query immutable audit log trail (REVIEWER/ADMIN)',
          responses: { '200': { description: 'Audit events' } },
        },
      },
      '/audit-logs/export': {
        get: {
          tags: ['Audit & Settings'],
          summary: 'Export immutable audit trail as CSV (ADMIN)',
          responses: { '200': { description: 'CSV download' } },
        },
      },
      '/settings': {
        get: {
          tags: ['Audit & Settings'],
          summary: 'Read workspace extraction, tolerance, confidence, and runtime status',
          responses: { '200': { description: 'Workspace settings' } },
        },
        patch: {
          tags: ['Audit & Settings'],
          summary: 'Update tolerance, OCR, and confidence policies (ADMIN)',
          responses: { '200': { description: 'Updated' } },
        },
      },
    },
  };
}
