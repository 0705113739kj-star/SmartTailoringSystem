import { Capacitor } from '@capacitor/core';

const CSRF_STORAGE_KEY = 'tailorpos_csrf_token';
const SESSION_STORAGE_KEY = 'tailorpos_session_token';

export function isMobileNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

function getPreferredStorage(): Storage | undefined {
  try {
    if (isMobileNative() && typeof localStorage !== 'undefined') {
      return localStorage;
    }
    if (typeof sessionStorage !== 'undefined') {
      return sessionStorage;
    }
  } catch {
    // ignore storage errors
  }
  return undefined;
}

function readStoredValue(key: string): string {
  try {
    return getPreferredStorage()?.getItem(key) || '';
  } catch {
    return '';
  }
}

function writeStoredValue(key: string, value: string): void {
  try {
    const store = getPreferredStorage();
    if (!store) return;
    if (value) {
      store.setItem(key, value);
    } else {
      store.removeItem(key);
    }
  } catch {
    // ignore storage errors
  }
}

let inMemoryCsrfToken = readStoredValue(CSRF_STORAGE_KEY);
let inMemorySessionToken = readStoredValue(SESSION_STORAGE_KEY);

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function setCsrfToken(token: string) {
  inMemoryCsrfToken = token || '';
  writeStoredValue(CSRF_STORAGE_KEY, inMemoryCsrfToken);
}

export function setAuthTokens(tokens: { csrfToken?: string; sessionToken?: string }) {
  if (tokens.csrfToken !== undefined) {
    inMemoryCsrfToken = tokens.csrfToken || '';
    writeStoredValue(CSRF_STORAGE_KEY, inMemoryCsrfToken);
  }
  if (tokens.sessionToken !== undefined) {
    inMemorySessionToken = tokens.sessionToken || '';
    writeStoredValue(SESSION_STORAGE_KEY, inMemorySessionToken);
  }
}

export function clearAuthTokens() {
  inMemoryCsrfToken = '';
  inMemorySessionToken = '';
  writeStoredValue(CSRF_STORAGE_KEY, '');
  writeStoredValue(SESSION_STORAGE_KEY, '');
}

function getCsrfTokenFromCookie(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)tailorpos_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function buildAuthHeaders(method: string, extra?: HeadersInit): Record<string, string> {
  const headers = new Headers(extra || {});
  if (inMemorySessionToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${inMemorySessionToken}`);
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrf = inMemoryCsrfToken || getCsrfTokenFromCookie();
    if (csrf) {
      headers.set('X-CSRF-Token', csrf);
    }
  }
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export async function apiRequest<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();

  if (isMobileNative()) {
    const { getMobileBackend } = await import('../mobile/inAppBackend');
    const backend = await getMobileBackend();
    const headers = buildAuthHeaders(method, options.headers);
    let parsedBody: unknown = undefined;
    if (typeof options.body === 'string' && options.body.length > 0) {
      try {
        parsedBody = JSON.parse(options.body);
      } catch {
        parsedBody = options.body;
      }
    } else if (options.body !== undefined) {
      parsedBody = options.body;
    }

    const result = await backend.dispatch({
      method,
      url,
      headers,
      body: parsedBody,
    });

    if (result.status >= 400) {
      const errObj = (result.body || {}) as { error?: string };
      throw new ApiError(
        String(errObj.error || `Request failed with status ${result.status}`),
        result.status
      );
    }
    return (result.body ?? {}) as T;
  }

  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (inMemorySessionToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${inMemorySessionToken}`);
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrf = inMemoryCsrfToken || getCsrfTokenFromCookie();
    if (csrf) {
      headers.set('X-CSRF-Token', csrf);
    }
  }

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || `Request failed (${res.status})` };
  }

  if (!res.ok) {
    throw new ApiError(String(data.error || `Request failed with status ${res.status}`), res.status);
  }
  return data as T;
}

export async function apiDownloadBlob(url: string): Promise<{ blob: Blob; filename: string }> {
  if (isMobileNative()) {
    const { getMobileBackend } = await import('../mobile/inAppBackend');
    const backend = await getMobileBackend();
    const result = await backend.dispatch({
      method: 'GET',
      url,
      headers: buildAuthHeaders('GET'),
    });
    if (result.status >= 400) {
      const errObj = (result.body || {}) as { error?: string };
      throw new ApiError(String(errObj.error || `Download failed (${result.status})`), result.status);
    }
    const bytes = result.body instanceof Uint8Array ? result.body : new Uint8Array(0);
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const filename = result.headers['x-backup-filename'] || 'SmartTailoringSystem_Backup.db';
    return {
      blob: new Blob([copy], { type: 'application/octet-stream' }),
      filename,
    };
  }

  const headers = new Headers();
  if (inMemorySessionToken) {
    headers.set('Authorization', `Bearer ${inMemorySessionToken}`);
  }
  const res = await fetch(url, {
    method: 'GET',
    headers,
    credentials: 'include',
  });
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json?.error) msg = json.error;
    } catch {
      // ignore non-json error
    }
    throw new ApiError(msg, res.status);
  }
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/i);
  const headerName = res.headers.get('X-Backup-Filename') || '';
  const filename = match?.[1] || headerName || 'SmartTailoringSystem_Backup.db';
  const blob = await res.blob();
  return { blob, filename };
}

export async function apiUploadBinary<T>(url: string, data: ArrayBuffer | Uint8Array): Promise<T> {
  const bodyBytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  if (isMobileNative()) {
    const { getMobileBackend } = await import('../mobile/inAppBackend');
    const backend = await getMobileBackend();
    const result = await backend.dispatch({
      method: 'POST',
      url,
      headers: {
        ...buildAuthHeaders('POST'),
        'content-type': 'application/octet-stream',
      },
      body: bodyBytes,
    });
    if (result.status >= 400) {
      const errObj = (result.body || {}) as { error?: string };
      throw new ApiError(String(errObj.error || `Request failed (${result.status})`), result.status);
    }
    return (result.body ?? {}) as T;
  }

  const headers = new Headers();
  headers.set('Content-Type', 'application/octet-stream');
  if (inMemorySessionToken) {
    headers.set('Authorization', `Bearer ${inMemorySessionToken}`);
  }
  const csrf = inMemoryCsrfToken || getCsrfTokenFromCookie();
  if (csrf) {
    headers.set('X-CSRF-Token', csrf);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: bodyBytes as unknown as BodyInit,
    credentials: 'include',
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text || `Request failed (${res.status})` };
  }
  if (!res.ok) {
    throw new ApiError(String(parsed.error || `Request failed with status ${res.status}`), res.status);
  }
  return parsed as T;
}

export function formatMoney(amount: number, currency = 'KES'): string {
  const val = Number(amount || 0);
  return `${currency} ${val.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDate(isoOrDate: string): string {
  if (!isoOrDate) return '—';
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return isoOrDate.slice(0, 10);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function generateUuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
