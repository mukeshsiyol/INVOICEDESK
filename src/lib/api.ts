export type UserRole = 'OPERATOR' | 'REVIEWER' | 'ADMIN';

export interface UserProfile {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  theme_preference: 'light' | 'dark' | 'system';
  is_active: number;
  demo_mode?: boolean;
  auth_paused?: boolean;
}

export class ApiError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const DEMO_ROLE_STORAGE_KEY = 'invoicedesk_demo_role';

export async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  const headers: Record<string, string> = isFormData
    ? {}
    : { 'Content-Type': 'application/json' };

  const storedDemoRole =
    typeof window !== 'undefined' ? window.localStorage.getItem(DEMO_ROLE_STORAGE_KEY) : null;
  if (storedDemoRole === 'OPERATOR' || storedDemoRole === 'REVIEWER' || storedDemoRole === 'ADMIN') {
    headers['X-Demo-Role'] = storedDemoRole;
  }

  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      ...headers,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  if (!res.ok) {
    let payload: any = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    const errObj = payload?.error;
    throw new ApiError(
      res.status,
      errObj?.code || `HTTP_${res.status}`,
      errObj?.message || res.statusText || 'Request failed',
      errObj?.details || {}
    );
  }

  return res.json() as Promise<T>;
}

export function formatCurrency(val: string | number | null | undefined, currency = 'USD'): string {
  if (val === null || val === undefined || val === '') return '—';
  const num = typeof val === 'number' ? val : Number(val);
  if (Number.isNaN(num)) return String(val);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  } catch {
    return `${currency} ${num.toFixed(2)}`;
  }
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
