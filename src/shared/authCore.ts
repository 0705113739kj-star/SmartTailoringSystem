import {
  generateOpaqueTokenPortable,
  hashPasswordPortable,
  hashTokenPortable,
  verifyPasswordPortable,
} from './crypto.ts';
import type { AppNext, AppRequest, AppResponse, AuthContext } from './router.ts';
import { type DbClient, type DbHolder, nowIso } from './schema.ts';

export type { AuthContext };

export const SESSION_COOKIE_NAME = 'tailorpos_session';
export const CSRF_COOKIE_NAME = 'tailorpos_csrf';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function unwrapDb(dbOrHolder: DbClient | DbHolder): DbClient {
  return 'current' in dbOrHolder ? dbOrHolder.current : dbOrHolder;
}

export const hashPassword = hashPasswordPortable;
export const verifyPassword = verifyPasswordPortable;
export const hashToken = hashTokenPortable;
export const generateOpaqueToken = generateOpaqueTokenPortable;

export async function seedDefaultEstimationRules(tx: DbClient, businessId: number): Promise<void> {
  const now = nowIso();
  const defaults = [
    {
      garment_type: 'Suit',
      design_style: 'Two-Piece Classic',
      base_fabric_meters: 3.2,
      fabric_width_cm: 150,
      allowance_percent: 10,
      lining_ratio: 0.75,
      interfacing_meters: 0.8,
      thread_spools: 2,
      buttons_count: 6,
      zippers_count: 1,
      notes: 'Standard two-piece suit (jacket + trouser) on 150cm suiting width.',
    },
    {
      garment_type: 'Jacket',
      design_style: 'Single-Breasted Blazer',
      base_fabric_meters: 1.9,
      fabric_width_cm: 150,
      allowance_percent: 10,
      lining_ratio: 0.85,
      interfacing_meters: 0.75,
      thread_spools: 1,
      buttons_count: 5,
      zippers_count: 0,
      notes: 'Structured tailored jacket with full or half canvas.',
    },
    {
      garment_type: 'Trouser',
      design_style: 'Tailored Pleated / Flat-Front',
      base_fabric_meters: 1.35,
      fabric_width_cm: 150,
      allowance_percent: 8,
      lining_ratio: 0.35,
      interfacing_meters: 0.25,
      thread_spools: 1,
      buttons_count: 2,
      zippers_count: 1,
      notes: 'Standard full-length trouser with pocket bags and waistband.',
    },
    {
      garment_type: 'Shirt',
      design_style: 'Long-Sleeve Dress Shirt',
      base_fabric_meters: 1.85,
      fabric_width_cm: 145,
      allowance_percent: 8,
      lining_ratio: 0,
      interfacing_meters: 0.4,
      thread_spools: 1,
      buttons_count: 10,
      zippers_count: 0,
      notes: 'Collar and cuff fusible interfacing included.',
    },
    {
      garment_type: 'Dress',
      design_style: 'A-Line / Evening Dress',
      base_fabric_meters: 2.6,
      fabric_width_cm: 145,
      allowance_percent: 12,
      lining_ratio: 0.85,
      interfacing_meters: 0.3,
      thread_spools: 1,
      buttons_count: 1,
      zippers_count: 1,
      notes: 'Full-length or knee-length dress with invisible zip.',
    },
    {
      garment_type: 'Skirt',
      design_style: 'Pencil / Pleated Skirt',
      base_fabric_meters: 1.25,
      fabric_width_cm: 145,
      allowance_percent: 8,
      lining_ratio: 0.8,
      interfacing_meters: 0.2,
      thread_spools: 1,
      buttons_count: 1,
      zippers_count: 1,
      notes: 'Lined skirt with concealed zipper.',
    },
  ];

  for (const r of defaults) {
    await tx.insert(
      `INSERT INTO fabric_estimation_rules
        (business_id, garment_type, design_style, base_fabric_meters, fabric_width_cm, allowance_percent, lining_ratio, interfacing_meters, thread_spools, buttons_count, zippers_count, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        businessId,
        r.garment_type,
        r.design_style,
        r.base_fabric_meters,
        r.fabric_width_cm,
        r.allowance_percent,
        r.lining_ratio,
        r.interfacing_meters,
        r.thread_spools,
        r.buttons_count,
        r.zippers_count,
        r.notes,
        now,
      ]
    );
  }
}

export function isHttpsRequest(req: AppRequest): boolean {
  const rawProto = req.headers['x-forwarded-proto'];
  const protoStr = Array.isArray(rawProto) ? rawProto[0] : rawProto;
  const proto = String(protoStr || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return Boolean(req.secure || proto === 'https');
}

export function extractBearerToken(req: AppRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    return token || null;
  }
  return null;
}

export function getCookieOptions(req: AppRequest, httpOnly: boolean) {
  const isHttps = isHttpsRequest(req);
  return {
    httpOnly,
    sameSite: (isHttps ? 'none' : 'lax') as 'none' | 'lax',
    secure: isHttps,
    path: '/',
  };
}

export async function createSessionForUser(
  dbOrHolder: DbClient | DbHolder,
  userId: number,
  businessId: number,
  req: AppRequest,
  res: AppResponse
): Promise<{ csrfToken: string; sessionToken: string }> {
  const db = unwrapDb(dbOrHolder);
  const rawToken = generateOpaqueToken();
  const tokenHash = hashToken(rawToken);
  const csrfToken = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  await db.insert(
    `INSERT INTO sessions (user_id, business_id, token_hash, csrf_token, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, businessId, tokenHash, csrfToken, expiresAt, nowIso()]
  );

  res.cookie(SESSION_COOKIE_NAME, rawToken, {
    ...getCookieOptions(req, true),
    maxAge: SESSION_TTL_MS,
  });
  res.cookie(CSRF_COOKIE_NAME, csrfToken, {
    ...getCookieOptions(req, false),
    maxAge: SESSION_TTL_MS,
  });

  return { csrfToken, sessionToken: rawToken };
}

export function clearSessionCookies(req: AppRequest, res: AppResponse): void {
  res.clearCookie(SESSION_COOKIE_NAME, getCookieOptions(req, true));
  res.clearCookie(CSRF_COOKIE_NAME, getCookieOptions(req, false));
}

export async function resolveAuthFromRequest(
  dbOrHolder: DbClient | DbHolder,
  req: AppRequest
): Promise<AuthContext | null> {
  const db = unwrapDb(dbOrHolder);
  const candidates = [extractBearerToken(req), req.cookies?.[SESSION_COOKIE_NAME]].filter(
    (t): t is string => typeof t === 'string' && t.length > 0
  );
  if (candidates.length === 0) return null;

  for (const rawToken of candidates) {
    const tokenHash = hashToken(rawToken);
    const row = await db.queryOne<{
      user_id: number;
      business_id: number;
      csrf_token: string;
      expires_at: string;
      full_name: string;
      username: string;
      email: string;
      phone: string;
      business_name: string;
      business_address: string;
      receipt_footer: string;
      currency: string;
    }>(
      `SELECT s.user_id, s.business_id, s.csrf_token, s.expires_at,
              u.full_name, u.username, u.email, u.phone,
              b.name AS business_name, b.address AS business_address, b.receipt_footer, b.currency
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN businesses b ON b.id = s.business_id
       WHERE s.token_hash = $1`,
      [tokenHash]
    );

    if (!row) continue;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await db.execute(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
      continue;
    }

    return {
      userId: Number(row.user_id),
      businessId: Number(row.business_id),
      fullName: row.full_name,
      username: row.username || '',
      email: row.email,
      phone: row.phone,
      businessName: row.business_name,
      businessAddress: row.business_address || '',
      receiptFooter: row.receipt_footer || '',
      currency: row.currency || 'KES',
      csrfToken: row.csrf_token,
    };
  }

  return null;
}

export function createAuthMiddleware(dbOrHolder: DbClient | DbHolder) {
  return async (req: AppRequest, res: AppResponse, next?: AppNext) => {
    try {
      const auth = await resolveAuthFromRequest(dbOrHolder, req);
      if (!auth) {
        return res.status(401).json({ error: 'Authentication required. Please log in.' });
      }
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())) {
        const headerCsrf = req.headers['x-csrf-token'];
        if (!headerCsrf || headerCsrf !== auth.csrfToken) {
          return res.status(403).json({ error: 'Invalid or missing CSRF security token.' });
        }
      }
      req.auth = auth;
      if (next) await next();
    } catch (err) {
      if (next) await next(err);
    }
  };
}
