import {
  clearSessionCookies,
  createAuthMiddleware,
  createSessionForUser,
  extractBearerToken,
  generateOpaqueToken,
  hashPassword,
  hashToken,
  resolveAuthFromRequest,
  seedDefaultEstimationRules,
  SESSION_COOKIE_NAME,
  verifyPassword,
} from './authCore.ts';
import { setPreference } from './backupShared.ts';
import type { AppRequest, AppResponse, AppRouter } from './router.ts';
import { type DbClient, type DbHolder, nowIso, todayDate } from './schema.ts';

const VALID_ORDER_STATUSES = [
  'Pending',
  'In Progress',
  'Completed',
  'Ready for Collection',
  'Collected',
  'Cancelled',
] as const;

async function nextSequenceCode(
  db: DbClient,
  table: 'customers' | 'tailoring_orders' | 'payments' | 'materials',
  col: string,
  prefix: string,
  businessId: number
): Promise<string> {
  const row = await db.queryOne<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM ${table} WHERE business_id = $1`,
    [businessId]
  );
  let num = Number(row?.cnt || 0) + 1;
  while (true) {
    const candidate = `${prefix}-${String(num).padStart(4, '0')}`;
    const exists = await db.queryOne<{ id: number }>(
      `SELECT id FROM ${table} WHERE business_id = $1 AND ${col} = $2`,
      [businessId, candidate]
    );
    if (!exists) return candidate;
    num += 1;
  }
}

export function createProxiedDb(holder: DbHolder): DbClient {
  return {
    get dialect() {
      return holder.current.dialect;
    },
    get dbPath() {
      return holder.current.dbPath;
    },
    query: (...args) => holder.current.query(...args),
    queryOne: (...args) => holder.current.queryOne(...args),
    execute: (...args) => holder.current.execute(...args),
    insert: (...args) => holder.current.insert(...args),
    transaction: (...args) => holder.current.transaction(...args),
    checkpoint: () => holder.current.checkpoint(),
    backupTo: (dest) => holder.current.backupTo(dest),
    getSchemaVersion: () => holder.current.getSchemaVersion(),
    close: () => holder.current.close(),
  };
}

export function registerCorePosRoutes(router: AppRouter, holder: DbHolder): void {
  const db = createProxiedDb(holder);
  const requireAuth = createAuthMiddleware(holder);

  // =========================================================================
  // AUTHENTICATION & REGISTRATION (Independent Businesses)
  // =========================================================================

  router.post('/auth/register', async (req: AppRequest, res: AppResponse) => {
    try {
      const { businessName, ownerName, username, email, phone, password, confirmPassword, currency } = req.body || {};

      if (!businessName?.trim() || !ownerName?.trim() || !email?.trim() || !phone?.trim() || !password) {
        return res.status(400).json({ error: 'All registration fields are required.' });
      }
      const normalizedEmail = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
      }
      const cleanUsername = String(username || '').trim().toLowerCase();
      if (cleanUsername && !/^[a-z0-9._-]{3,32}$/.test(cleanUsername)) {
        return res.status(400).json({
          error: 'Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens.',
        });
      }
      if (String(password).length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
      }
      if (password !== confirmPassword) {
        return res.status(400).json({ error: 'Passwords do not match.' });
      }

      const existingUser = await db.queryOne<{ id: number }>(
        `SELECT id FROM users WHERE LOWER(email) = $1`,
        [normalizedEmail]
      );
      if (existingUser) {
        return res.status(409).json({ error: 'An account with this email address already exists.' });
      }
      if (cleanUsername) {
        const existingUsername = await db.queryOne<{ id: number }>(
          `SELECT id FROM users WHERE LOWER(username) = $1`,
          [cleanUsername]
        );
        if (existingUsername) {
          return res.status(409).json({ error: 'This username is already taken.' });
        }
      }

      const now = nowIso();
      const passwordHash = hashPassword(String(password));
      const cleanCurrency = (currency && String(currency).trim().toUpperCase()) || 'KES';

      const created = await db.transaction(async (tx) => {
        const businessId = await tx.insert(
          `INSERT INTO businesses (name, owner_name, email, phone, currency, address, receipt_footer, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [String(businessName).trim(), String(ownerName).trim(), normalizedEmail, String(phone).trim(), cleanCurrency, '', '', now]
        );
        const userId = await tx.insert(
          `INSERT INTO users (business_id, full_name, username, email, phone, password_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [businessId, String(ownerName).trim(), cleanUsername, normalizedEmail, String(phone).trim(), passwordHash, now]
        );
        await seedDefaultEstimationRules(tx, businessId);
        return { businessId, userId };
      });

      const { csrfToken, sessionToken } = await createSessionForUser(db, created.userId, created.businessId, req, res);

      return res.status(201).json({
        user: {
          userId: created.userId,
          businessId: created.businessId,
          fullName: String(ownerName).trim(),
          username: cleanUsername,
          email: normalizedEmail,
          phone: String(phone).trim(),
          businessName: String(businessName).trim(),
          businessAddress: '',
          receiptFooter: '',
          currency: cleanCurrency,
          csrfToken,
          sessionToken,
        },
      });
    } catch (err) {
      console.error('Register error:', err);
      return res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
  });

  router.post('/auth/login', async (req: AppRequest, res: AppResponse) => {
    try {
      const { email, password } = req.body || {};
      if (!email?.trim() || !password) {
        return res.status(400).json({ error: 'Email or username and password are required.' });
      }
      const identifier = String(email).trim().toLowerCase();
      const user = await db.queryOne<{
        id: number;
        business_id: number;
        full_name: string;
        username: string;
        email: string;
        phone: string;
        password_hash: string;
        business_name: string;
        business_address: string;
        receipt_footer: string;
        currency: string;
      }>(
        `SELECT u.id, u.business_id, u.full_name, u.username, u.email, u.phone, u.password_hash,
                b.name AS business_name, b.address AS business_address, b.receipt_footer, b.currency
         FROM users u
         JOIN businesses b ON b.id = u.business_id
         WHERE LOWER(u.email) = $1 OR (u.username IS NOT NULL AND u.username != '' AND LOWER(u.username) = $1)`,
        [identifier]
      );

      if (!user || !verifyPassword(String(password), user.password_hash)) {
        return res.status(401).json({ error: 'Invalid credentials. Check your email/username and password.' });
      }

      const { csrfToken, sessionToken } = await createSessionForUser(
        db,
        Number(user.id),
        Number(user.business_id),
        req,
        res
      );
      return res.json({
        user: {
          userId: Number(user.id),
          businessId: Number(user.business_id),
          fullName: user.full_name,
          username: user.username || '',
          email: user.email,
          phone: user.phone,
          businessName: user.business_name,
          businessAddress: user.business_address || '',
          receiptFooter: user.receipt_footer || '',
          currency: user.currency || 'KES',
          csrfToken,
          sessionToken,
        },
      });
    } catch (err) {
      console.error('Login error:', err);
      return res.status(500).json({ error: 'Login failed. Please try again.' });
    }
  });

  router.post('/auth/logout', async (req: AppRequest, res: AppResponse) => {
    const tokens = [extractBearerToken(req), req.cookies?.[SESSION_COOKIE_NAME]].filter(
      (t): t is string => typeof t === 'string' && t.length > 0
    );
    for (const rawToken of tokens) {
      await db.execute(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(rawToken)]);
    }
    clearSessionCookies(req, res);
    return res.json({ ok: true });
  });

  router.get('/auth/me', async (req: AppRequest, res: AppResponse) => {
    const auth = await resolveAuthFromRequest(db, req);
    if (!auth) return res.status(401).json({ error: 'Not authenticated' });
    return res.json({ user: auth });
  });

  router.post('/auth/forgot-password', async (req: AppRequest, res: AppResponse) => {
    const { email } = req.body || {};
    if (!email?.trim()) {
      return res.status(400).json({ error: 'Email address is required.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await db.queryOne<{ id: number }>(
      `SELECT id FROM users WHERE LOWER(email) = $1`,
      [normalizedEmail]
    );
    if (user) {
      const rawReset = generateOpaqueToken().slice(0, 12).toUpperCase();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await db.insert(
        `INSERT INTO password_resets (user_id, token_hash, expires_at, used, created_at)
         VALUES ($1, $2, $3, 0, $4)`,
        [user.id, hashToken(rawReset), expiresAt, nowIso()]
      );
      return res.json({
        message: 'Local reset code generated. Enter this code below to set a new password.',
        devResetCode: rawReset,
      });
    }
    return res.json({
      message: 'If a local account matches that email, a reset code has been generated.',
    });
  });

  router.post('/auth/reset-password', async (req: AppRequest, res: AppResponse) => {
    const { email, resetCode, newPassword } = req.body || {};
    if (!email?.trim() || !resetCode?.trim() || !newPassword) {
      return res.status(400).json({ error: 'Email, reset code, and new password are required.' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }
    const user = await db.queryOne<{ id: number }>(
      `SELECT id FROM users WHERE email = $1`,
      [String(email).trim().toLowerCase()]
    );
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset code.' });
    }
    const tokenHash = hashToken(String(resetCode).trim().toUpperCase());
    const resetRow = await db.queryOne<{ id: number; expires_at: string; used: number }>(
      `SELECT id, expires_at, used FROM password_resets
       WHERE user_id = $1 AND token_hash = $2 AND used = 0
       ORDER BY id DESC LIMIT 1`,
      [user.id, tokenHash]
    );
    if (!resetRow || new Date(resetRow.expires_at).getTime() <= Date.now()) {
      return res.status(400).json({ error: 'Invalid or expired reset code.' });
    }
    await db.transaction(async (tx) => {
      await tx.execute(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
        hashPassword(String(newPassword)),
        user.id,
      ]);
      await tx.execute(`UPDATE password_resets SET used = 1 WHERE id = $1`, [resetRow.id]);
      await tx.execute(`DELETE FROM sessions WHERE user_id = $1`, [user.id]);
    });
    return res.json({ message: 'Password updated successfully. You may now log in.' });
  });

  // =========================================================================
  // ALL ROUTES BELOW REQUIRE AUTHENTICATION + CSRF + BUSINESS ISOLATION
  // =========================================================================
  router.use(requireAuth);

  // =========================================================================
  // ACCOUNT & BUSINESS SETTINGS
  // =========================================================================

  router.put('/settings/profile', async (req: AppRequest, res: AppResponse) => {
    try {
      const auth = req.auth!;
      const {
        fullName,
        username,
        email,
        phone,
        businessName,
        currency,
        businessAddress,
        receiptFooter,
      } = req.body || {};

      const cleanFullName = String(fullName ?? '').trim();
      const cleanEmail = String(email ?? '').trim().toLowerCase();
      const cleanPhone = String(phone ?? '').trim();
      const cleanBusinessName = String(businessName ?? '').trim();
      const cleanUsername = String(username ?? '').trim().toLowerCase();
      const cleanCurrency = String(currency ?? auth.currency ?? 'KES').trim().toUpperCase() || 'KES';
      const cleanAddress = String(businessAddress ?? '').trim();
      const cleanFooter = String(receiptFooter ?? '').trim();

      if (!cleanFullName || !cleanEmail || !cleanPhone || !cleanBusinessName) {
        return res.status(400).json({
          error: 'Owner name, email address, phone number, and business name are required.',
        });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
      }
      if (cleanUsername && !/^[a-z0-9._-]{3,32}$/.test(cleanUsername)) {
        return res.status(400).json({
          error: 'Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens.',
        });
      }

      const dupEmail = await db.queryOne<{ id: number }>(
        `SELECT id FROM users WHERE LOWER(email) = $1 AND id != $2`,
        [cleanEmail, auth.userId]
      );
      if (dupEmail) {
        return res.status(409).json({ error: 'Another account already uses this email address.' });
      }

      if (cleanUsername) {
        const dupUsername = await db.queryOne<{ id: number }>(
          `SELECT id FROM users WHERE LOWER(username) = $1 AND id != $2`,
          [cleanUsername, auth.userId]
        );
        if (dupUsername) {
          return res.status(409).json({ error: 'This username is already taken by another account.' });
        }
      }

      await db.transaction(async (tx) => {
        await tx.execute(
          `UPDATE users SET full_name = $1, username = $2, email = $3, phone = $4 WHERE id = $5 AND business_id = $6`,
          [cleanFullName, cleanUsername, cleanEmail, cleanPhone, auth.userId, auth.businessId]
        );
        await tx.execute(
          `UPDATE businesses SET name = $1, owner_name = $2, email = $3, phone = $4, currency = $5, address = $6, receipt_footer = $7 WHERE id = $8`,
          [
            cleanBusinessName,
            cleanFullName,
            cleanEmail,
            cleanPhone,
            cleanCurrency,
            cleanAddress,
            cleanFooter,
            auth.businessId,
          ]
        );
      });

      const updated = await resolveAuthFromRequest(db, req);
      return res.json({ user: updated, message: 'Account and workshop settings updated.' });
    } catch (err) {
      console.error('Update profile settings error:', err);
      return res.status(500).json({ error: 'Failed to update settings.' });
    }
  });

  router.put('/settings/password', async (req: AppRequest, res: AppResponse) => {
    try {
      const auth = req.auth!;
      const { currentPassword, newPassword, confirmPassword } = req.body || {};
      if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ error: 'Current password, new password, and confirmation are required.' });
      }
      if (String(newPassword).length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
      }
      if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'New password and confirmation do not match.' });
      }

      const userRow = await db.queryOne<{ id: number; password_hash: string }>(
        `SELECT id, password_hash FROM users WHERE id = $1 AND business_id = $2`,
        [auth.userId, auth.businessId]
      );
      if (!userRow || !verifyPassword(String(currentPassword), userRow.password_hash)) {
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }

      const activeRawToken = extractBearerToken(req) || req.cookies?.[SESSION_COOKIE_NAME];
      const activeHash = activeRawToken ? hashToken(activeRawToken) : '';

      await db.transaction(async (tx) => {
        await tx.execute(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
          hashPassword(String(newPassword)),
          auth.userId,
        ]);
        if (activeHash) {
          await tx.execute(`DELETE FROM sessions WHERE user_id = $1 AND token_hash != $2`, [
            auth.userId,
            activeHash,
          ]);
        }
      });

      return res.json({ message: 'Password updated successfully.' });
    } catch (err) {
      console.error('Update password error:', err);
      return res.status(500).json({ error: 'Failed to update password.' });
    }
  });

  router.put('/backup/preferences', async (req: AppRequest, res: AppResponse) => {
    try {
      const bid = req.auth!.businessId;
      const days = Number(req.body?.reminderDays ?? 7);
      if (!Number.isFinite(days) || days < 0 || days > 365) {
        return res.status(400).json({ error: 'Reminder interval must be between 0 and 365 days.' });
      }
      await setPreference(db, bid, 'backup_reminder_days', String(Math.round(days)));
      return res.json({ reminderDays: Math.round(days) });
    } catch (err) {
      console.error('Backup preferences error:', err);
      return res.status(500).json({ error: 'Failed to update backup reminder setting.' });
    }
  });

  // Full business-scoped snapshot for initial load
  router.get('/bootstrap', async (req: AppRequest, res: AppResponse) => {
    try {
      const bid = req.auth!.businessId;
      const [
        customers,
        measurements,
        measurementHistory,
        orders,
        estimationRules,
        estimations,
        materials,
        usageRecords,
        inventoryTransactions,
        payments,
        expenses,
      ] = await Promise.all([
        db.query(`SELECT * FROM customers WHERE business_id = $1 ORDER BY id DESC`, [bid]),
        db.query(
          `SELECT m.*, c.full_name AS customer_name, c.customer_number
           FROM measurements m
           JOIN customers c ON c.id = m.customer_id AND c.business_id = m.business_id
           WHERE m.business_id = $1 ORDER BY m.updated_at DESC`,
          [bid]
        ),
        db.query(
          `SELECT * FROM measurement_history WHERE business_id = $1 ORDER BY id DESC`,
          [bid]
        ),
        db.query(
          `SELECT o.*, c.full_name AS customer_name, c.customer_number, c.phone AS customer_phone,
                  COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.id AND p.business_id = o.business_id AND p.status = 'Completed'), 0) AS total_paid
           FROM tailoring_orders o
           JOIN customers c ON c.id = o.customer_id AND c.business_id = o.business_id
           WHERE o.business_id = $1 ORDER BY o.id DESC`,
          [bid]
        ),
        db.query(`SELECT * FROM fabric_estimation_rules WHERE business_id = $1 ORDER BY garment_type ASC`, [bid]),
        db.query(
          `SELECT fe.*, o.order_number, o.garment_type
           FROM fabric_estimations fe
           JOIN tailoring_orders o ON o.id = fe.order_id AND o.business_id = fe.business_id
           WHERE fe.business_id = $1 ORDER BY fe.id DESC`,
          [bid]
        ),
        db.query(`SELECT * FROM materials WHERE business_id = $1 ORDER BY name ASC`, [bid]),
        db.query(
          `SELECT u.*, m.name AS material_name, m.unit AS material_unit, o.order_number
           FROM material_usage_records u
           JOIN materials m ON m.id = u.material_id AND m.business_id = u.business_id
           JOIN tailoring_orders o ON o.id = u.order_id AND o.business_id = u.business_id
           WHERE u.business_id = $1 ORDER BY u.id DESC`,
          [bid]
        ),
        db.query(
          `SELECT t.*, m.name AS material_name, m.unit AS material_unit, o.order_number
           FROM inventory_transactions t
           JOIN materials m ON m.id = t.material_id AND m.business_id = t.business_id
           LEFT JOIN tailoring_orders o ON o.id = t.order_id AND o.business_id = t.business_id
           WHERE t.business_id = $1 ORDER BY t.id DESC LIMIT 200`,
          [bid]
        ),
        db.query(
          `SELECT p.*, c.full_name AS customer_name, c.customer_number, o.order_number, o.agreed_price
           FROM payments p
           JOIN customers c ON c.id = p.customer_id AND c.business_id = p.business_id
           JOIN tailoring_orders o ON o.id = p.order_id AND o.business_id = p.business_id
           WHERE p.business_id = $1 ORDER BY p.id DESC`,
          [bid]
        ),
        db.query(
          `SELECT e.*, o.order_number
           FROM business_expenses e
           LEFT JOIN tailoring_orders o ON o.id = e.order_id AND o.business_id = e.business_id
           WHERE e.business_id = $1 ORDER BY e.expense_date DESC, e.id DESC`,
          [bid]
        ),
      ]);

      return res.json({
        syncedAt: nowIso(),
        customers,
        measurements,
        measurementHistory,
        orders,
        estimationRules,
        estimations,
        materials,
        usageRecords,
        inventoryTransactions,
        payments,
        expenses,
      });
    } catch (err) {
      console.error('Bootstrap error:', err);
      return res.status(500).json({ error: 'Failed to load business workspace data.' });
    }
  });

  // =========================================================================
  // MODULE 1: DASHBOARD
  // =========================================================================

  router.get('/dashboard', async (req: AppRequest, res: AppResponse) => {
    try {
      const bid = req.auth!.businessId;
      const today = todayDate();

      const [custRow, orders, payments, materials] = await Promise.all([
        db.queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM customers WHERE business_id = $1`, [bid]),
        db.query<{
          id: number;
          order_number: string;
          customer_id: number;
          customer_name: string;
          garment_type: string;
          status: string;
          agreed_price: number;
          order_date: string;
          expected_completion_date: string;
          total_paid: number;
        }>(
          `SELECT o.id, o.order_number, o.customer_id, c.full_name AS customer_name, o.garment_type,
                  o.status, o.agreed_price, o.order_date, o.expected_completion_date,
                  COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.id AND p.business_id = o.business_id AND p.status = 'Completed'), 0) AS total_paid
           FROM tailoring_orders o
           JOIN customers c ON c.id = o.customer_id AND c.business_id = o.business_id
           WHERE o.business_id = $1
           ORDER BY o.id DESC`,
          [bid]
        ),
        db.query<{
          id: number;
          receipt_number: string;
          order_number: string;
          customer_name: string;
          amount: number;
          payment_method: string;
          payment_type: string;
          status: string;
          paid_at: string;
        }>(
          `SELECT p.id, p.receipt_number, o.order_number, c.full_name AS customer_name,
                  p.amount, p.payment_method, p.payment_type, p.status, p.paid_at
           FROM payments p
           JOIN tailoring_orders o ON o.id = p.order_id AND o.business_id = p.business_id
           JOIN customers c ON c.id = p.customer_id AND c.business_id = p.business_id
           WHERE p.business_id = $1
           ORDER BY p.id DESC LIMIT 8`,
          [bid]
        ),
        db.query<{ id: number; name: string; category: string; unit: string; current_qty: number; min_stock_level: number }>(
          `SELECT id, name, category, unit, current_qty, min_stock_level
           FROM materials WHERE business_id = $1 AND current_qty <= min_stock_level
           ORDER BY current_qty ASC`,
          [bid]
        ),
      ]);

      const activeOrders = orders.filter((o) => o.status !== 'Cancelled');
      const totalSales = activeOrders.reduce((s, o) => s + Number(o.agreed_price || 0), 0);
      const outstandingBalances = activeOrders.reduce(
        (s, o) => s + Math.max(0, Number(o.agreed_price || 0) - Number(o.total_paid || 0)),
        0
      );

      const statusCounts = {
        Pending: 0,
        'In Progress': 0,
        Completed: 0,
        'Ready for Collection': 0,
        Collected: 0,
        Cancelled: 0,
      } as Record<string, number>;

      for (const o of orders) {
        statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
      }

      const upcomingDeadlines = orders
        .filter((o) => ['Pending', 'In Progress'].includes(o.status) && o.expected_completion_date >= today)
        .sort((a, b) => a.expected_completion_date.localeCompare(b.expected_completion_date))
        .slice(0, 6);

      const monthBuckets: Record<string, { month: string; sales: number; orders: number; collections: number }> = {};
      for (let i = 5; i >= 0; i -= 1) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        const key = d.toISOString().slice(0, 7);
        monthBuckets[key] = { month: key, sales: 0, orders: 0, collections: 0 };
      }
      for (const o of activeOrders) {
        const m = (o.order_date || '').slice(0, 7);
        if (monthBuckets[m]) {
          monthBuckets[m].sales += Number(o.agreed_price || 0);
          monthBuckets[m].orders += 1;
        }
      }
      const allCompletedPayments = await db.query<{ amount: number; paid_at: string }>(
        `SELECT amount, paid_at FROM payments WHERE business_id = $1 AND status = 'Completed'`,
        [bid]
      );
      for (const p of allCompletedPayments) {
        const m = (p.paid_at || '').slice(0, 7);
        if (monthBuckets[m]) {
          monthBuckets[m].collections += Number(p.amount || 0);
        }
      }

      return res.json({
        kpis: {
          totalCustomers: Number(custRow?.total || 0),
          totalOrders: orders.length,
          pendingOrders: statusCounts.Pending,
          inProgressOrders: statusCounts['In Progress'],
          completedOrders: statusCounts.Completed,
          readyForCollectionOrders: statusCounts['Ready for Collection'],
          totalSales,
          outstandingBalances,
          lowStockCount: materials.length,
        },
        statusCounts,
        lowStockMaterials: materials,
        recentOrders: orders.slice(0, 6),
        recentPayments: payments,
        upcomingDeadlines,
        monthlyPerformance: Object.values(monthBuckets),
      });
    } catch (err) {
      console.error('Dashboard error:', err);
      return res.status(500).json({ error: 'Failed to load dashboard metrics.' });
    }
  });

  // =========================================================================
  // MODULE 2: CUSTOMERS
  // =========================================================================

  router.get('/customers', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const search = String(req.query.q || '').trim().toLowerCase();
    const rows = await db.query<{
      id: number;
      customer_number: string;
      full_name: string;
      phone: string;
      email: string;
      address: string;
      notes: string;
      created_at: string;
      updated_at: string;
    }>(`SELECT * FROM customers WHERE business_id = $1 ORDER BY id DESC`, [bid]);

    const filtered = search
      ? rows.filter(
          (r) =>
            r.full_name.toLowerCase().includes(search) ||
            r.phone.toLowerCase().includes(search) ||
            r.customer_number.toLowerCase().includes(search) ||
            (r.email || '').toLowerCase().includes(search)
        )
      : rows;

    return res.json({ customers: filtered });
  });

  router.get('/customers/:id', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const id = Number(req.params.id);
    const customer = await db.queryOne(`SELECT * FROM customers WHERE id = $1 AND business_id = $2`, [id, bid]);
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });

    const [orders, payments, measurements] = await Promise.all([
      db.query(
        `SELECT o.*,
                COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.id AND p.business_id = o.business_id AND p.status = 'Completed'), 0) AS total_paid
         FROM tailoring_orders o
         WHERE o.customer_id = $1 AND o.business_id = $2 ORDER BY o.id DESC`,
        [id, bid]
      ),
      db.query(
        `SELECT p.*, o.order_number FROM payments p
         JOIN tailoring_orders o ON o.id = p.order_id AND o.business_id = p.business_id
         WHERE p.customer_id = $1 AND p.business_id = $2 ORDER BY p.id DESC`,
        [id, bid]
      ),
      db.query(
        `SELECT * FROM measurements WHERE customer_id = $1 AND business_id = $2 ORDER BY updated_at DESC`,
        [id, bid]
      ),
    ]);

    const activeOrders = orders as Array<{ status: string; agreed_price: number; total_paid: number }>;
    const totalBilled = activeOrders
      .filter((o) => o.status !== 'Cancelled')
      .reduce((s, o) => s + Number(o.agreed_price || 0), 0);
    const totalPaid = activeOrders
      .filter((o) => o.status !== 'Cancelled')
      .reduce((s, o) => s + Number(o.total_paid || 0), 0);

    return res.json({
      customer,
      orders,
      payments,
      measurements,
      financials: {
        totalBilled,
        totalPaid,
        outstandingBalance: Math.max(0, totalBilled - totalPaid),
      },
    });
  });

  router.post('/customers', async (req: AppRequest, res: AppResponse) => {
    try {
      const bid = req.auth!.businessId;
      const { fullName, phone, email, address, notes, clientUuid } = req.body || {};
      const cleanName = String(fullName || '').trim();
      const cleanPhone = String(phone || '').trim();
      if (!cleanName || !cleanPhone) {
        return res.status(400).json({ error: 'Customer full name and phone number are required.' });
      }
      const cleanEmail = String(email || '').trim().toLowerCase();
      const cleanClientUuid = clientUuid ? String(clientUuid).trim() : null;

      if (cleanClientUuid) {
        const existingByUuid = await db.queryOne(
          `SELECT * FROM customers WHERE business_id = $1 AND client_uuid = $2`,
          [bid, cleanClientUuid]
        );
        if (existingByUuid) {
          return res.status(200).json({ customer: existingByUuid });
        }
      }

      const dupPhone = await db.queryOne<{ id: number; full_name: string }>(
        `SELECT id, full_name FROM customers WHERE business_id = $1 AND phone = $2`,
        [bid, cleanPhone]
      );
      if (dupPhone) {
        return res.status(409).json({
          error: `Duplicate customer prevented: ${dupPhone.full_name} is already registered with phone ${cleanPhone}.`,
        });
      }
      if (cleanEmail) {
        const dupEmail = await db.queryOne<{ id: number; full_name: string }>(
          `SELECT id, full_name FROM customers WHERE business_id = $1 AND LOWER(email) = $2`,
          [bid, cleanEmail]
        );
        if (dupEmail) {
          return res.status(409).json({
            error: `Duplicate customer prevented: ${dupEmail.full_name} is already registered with email ${cleanEmail}.`,
          });
        }
      }

      const customerNumber = await nextSequenceCode(db, 'customers', 'customer_number', 'CUS', bid);
      const now = nowIso();
      const id = await db.insert(
        `INSERT INTO customers (business_id, client_uuid, customer_number, full_name, phone, email, address, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          bid,
          cleanClientUuid,
          customerNumber,
          cleanName,
          cleanPhone,
          cleanEmail,
          String(address || '').trim(),
          String(notes || '').trim(),
          now,
          now,
        ]
      );
      const customer = await db.queryOne(`SELECT * FROM customers WHERE id = $1 AND business_id = $2`, [id, bid]);
      return res.status(201).json({ customer });
    } catch (err) {
      console.error('Create customer error:', err);
      return res.status(500).json({ error: 'Failed to register customer.' });
    }
  });

  router.put('/customers/:id', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const id = Number(req.params.id);
    const existing = await db.queryOne(`SELECT * FROM customers WHERE id = $1 AND business_id = $2`, [id, bid]);
    if (!existing) return res.status(404).json({ error: 'Customer not found.' });

    const { fullName, phone, email, address, notes } = req.body || {};
    if (!fullName?.trim() || !phone?.trim()) {
      return res.status(400).json({ error: 'Customer full name and phone number are required.' });
    }
    const cleanPhone = String(phone).trim();
    const cleanEmail = String(email || '').trim().toLowerCase();

    const dupPhone = await db.queryOne<{ id: number }>(
      `SELECT id FROM customers WHERE business_id = $1 AND phone = $2 AND id != $3`,
      [bid, cleanPhone, id]
    );
    if (dupPhone) {
      return res.status(409).json({ error: 'Another customer already uses this phone number.' });
    }

    await db.execute(
      `UPDATE customers SET full_name = $1, phone = $2, email = $3, address = $4, notes = $5, updated_at = $6
       WHERE id = $7 AND business_id = $8`,
      [String(fullName).trim(), cleanPhone, cleanEmail, String(address || '').trim(), String(notes || '').trim(), nowIso(), id, bid]
    );
    const updated = await db.queryOne(`SELECT * FROM customers WHERE id = $1 AND business_id = $2`, [id, bid]);
    return res.json({ customer: updated });
  });

  // =========================================================================
  // MODULE 3: MEASUREMENTS (with Non-Destructive History)
  // =========================================================================

  router.get('/measurements', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const customerId = req.query.customerId ? Number(req.query.customerId) : null;
    const sql = customerId
      ? `SELECT m.*, c.full_name AS customer_name, c.customer_number
         FROM measurements m
         JOIN customers c ON c.id = m.customer_id AND c.business_id = m.business_id
         WHERE m.business_id = $1 AND m.customer_id = $2 ORDER BY m.updated_at DESC`
      : `SELECT m.*, c.full_name AS customer_name, c.customer_number
         FROM measurements m
         JOIN customers c ON c.id = m.customer_id AND c.business_id = m.business_id
         WHERE m.business_id = $1 ORDER BY m.updated_at DESC`;
    const measurements = await db.query(sql, customerId ? [bid, customerId] : [bid]);
    return res.json({ measurements });
  });

  router.get('/measurements/:id/history', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const id = Number(req.params.id);
    const measurement = await db.queryOne(`SELECT * FROM measurements WHERE id = $1 AND business_id = $2`, [id, bid]);
    if (!measurement) return res.status(404).json({ error: 'Measurement record not found.' });
    const history = await db.query(
      `SELECT * FROM measurement_history WHERE measurement_id = $1 AND business_id = $2 ORDER BY version DESC`,
      [id, bid]
    );
    return res.json({ measurement, history });
  });

  router.post('/measurements', async (req: AppRequest, res: AppResponse) => {
    try {
      const bid = req.auth!.businessId;
      const { customerId, garmentType, unit, values, notes, clientUuid } = req.body || {};
      const cust = await db.queryOne(`SELECT id FROM customers WHERE id = $1 AND business_id = $2`, [
        Number(customerId),
        bid,
      ]);
      if (!cust) return res.status(404).json({ error: 'Selected customer was not found in your business.' });
      if (!garmentType?.trim()) return res.status(400).json({ error: 'Garment type is required.' });

      const cleanValues = typeof values === 'string' ? values : JSON.stringify(values || {});
      const cleanUnit = unit === 'in' ? 'in' : 'cm';
      const now = nowIso();

      const id = await db.transaction(async (tx) => {
        const mId = await tx.insert(
          `INSERT INTO measurements (business_id, client_uuid, customer_id, garment_type, unit, values_json, notes, version, recorded_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)`,
          [bid, clientUuid || null, Number(customerId), String(garmentType).trim(), cleanUnit, cleanValues, String(notes || '').trim(), now, now]
        );
        await tx.insert(
          `INSERT INTO measurement_history (business_id, measurement_id, customer_id, garment_type, unit, values_json, notes, version, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)`,
          [bid, mId, Number(customerId), String(garmentType).trim(), cleanUnit, cleanValues, String(notes || '').trim(), now]
        );
        return mId;
      });

      const created = await db.queryOne(
        `SELECT m.*, c.full_name AS customer_name, c.customer_number
         FROM measurements m
         JOIN customers c ON c.id = m.customer_id
         WHERE m.id = $1 AND m.business_id = $2`,
        [id, bid]
      );
      return res.status(201).json({ measurement: created });
    } catch (err) {
      console.error('Create measurement error:', err);
      return res.status(500).json({ error: 'Failed to save measurement record.' });
    }
  });

  router.put('/measurements/:id', async (req: AppRequest, res: AppResponse) => {
    try {
      const bid = req.auth!.businessId;
      const id = Number(req.params.id);
      const existing = await db.queryOne<{
        id: number;
        customer_id: number;
        garment_type: string;
        unit: string;
        version: number;
      }>(`SELECT * FROM measurements WHERE id = $1 AND business_id = $2`, [id, bid]);
      if (!existing) return res.status(404).json({ error: 'Measurement record not found.' });

      const { garmentType, unit, values, notes } = req.body || {};
      const nextVersion = Number(existing.version || 1) + 1;
      const cleanValues = typeof values === 'string' ? values : JSON.stringify(values || {});
      const cleanGarment = String(garmentType || existing.garment_type).trim();
      const cleanUnit = unit === 'in' ? 'in' : existing.unit || 'cm';
      const now = nowIso();

      await db.transaction(async (tx) => {
        await tx.execute(
          `UPDATE measurements SET garment_type = $1, unit = $2, values_json = $3, notes = $4, version = $5, updated_at = $6
           WHERE id = $7 AND business_id = $8`,
          [cleanGarment, cleanUnit, cleanValues, String(notes || '').trim(), nextVersion, now, id, bid]
        );
        await tx.insert(
          `INSERT INTO measurement_history (business_id, measurement_id, customer_id, garment_type, unit, values_json, notes, version, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [bid, id, existing.customer_id, cleanGarment, cleanUnit, cleanValues, String(notes || '').trim(), nextVersion, now]
        );
      });

      const updated = await db.queryOne(
        `SELECT m.*, c.full_name AS customer_name, c.customer_number
         FROM measurements m
         JOIN customers c ON c.id = m.customer_id
         WHERE m.id = $1 AND m.business_id = $2`,
        [id, bid]
      );
      return res.json({ measurement: updated });
    } catch (err) {
      console.error('Update measurement error:', err);
      return res.status(500).json({ error: 'Failed to update measurement record.' });
    }
  });

  // =========================================================================
  // MODULE 4: TAILORING ORDERS
  // =========================================================================

  router.get('/orders', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const status = String(req.query.status || '').trim();
    const search = String(req.query.q || '').trim().toLowerCase();

    const rows = await db.query<{
      id: number;
      order_number: string;
      customer_id: number;
      customer_name: string;
      customer_number: string;
      customer_phone: string;
      garment_type: string;
      color: string;
      status: string;
      agreed_price: number;
      total_paid: number;
      order_date: string;
      expected_completion_date: string;
    }>(
      `SELECT o.*, c.full_name AS customer_name, c.customer_number, c.phone AS customer_phone,
              COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.id AND p.business_id = o.business_id AND p.status = 'Completed'), 0) AS total_paid
       FROM tailoring_orders o
       JOIN customers c ON c.id = o.customer_id AND c.business_id = o.business_id
       WHERE o.business_id = $1 ORDER BY o.id DESC`,
      [bid]
    );

    const filtered = rows.filter((o) => {
      if (status && status !== 'All' && o.status !== status) return false;
      if (search) {
        return (
          o.order_number.toLowerCase().includes(search) ||
          o.customer_name.toLowerCase().includes(search) ||
          o.garment_type.toLowerCase().includes(search) ||
          (o.color || '').toLowerCase().includes(search)
        );
      }
      return true;
    });

    return res.json({ orders: filtered });
  });

  router.get('/orders/:id', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const id = Number(req.params.id);
    const order = await db.queryOne<{
      id: number;
      customer_id: number;
      measurement_id: number | null;
      agreed_price: number;
      labour_cost: number;
      other_expenses: number;
    }>(
      `SELECT o.*, c.full_name AS customer_name, c.customer_number, c.phone AS customer_phone, c.email AS customer_email
       FROM tailoring_orders o
       JOIN customers c ON c.id = o.customer_id AND c.business_id = o.business_id
       WHERE o.id = $1 AND o.business_id = $2`,
      [id, bid]
    );
    if (!order) return res.status(404).json({ error: 'Tailoring order not found.' });

    const [measurement, estimations, usageRecords, payments] = await Promise.all([
      order.measurement_id
        ? db.queryOne(`SELECT * FROM measurements WHERE id = $1 AND business_id = $2`, [order.measurement_id, bid])
        : Promise.resolve(null),
      db.query(`SELECT * FROM fabric_estimations WHERE order_id = $1 AND business_id = $2 ORDER BY id DESC`, [id, bid]),
      db.query<{ actual_cost: number }>(
        `SELECT u.*, m.name AS material_name, m.unit AS material_unit
         FROM material_usage_records u
         JOIN materials m ON m.id = u.material_id AND m.business_id = u.business_id
         WHERE u.order_id = $1 AND u.business_id = $2 ORDER BY u.id DESC`,
        [id, bid]
      ),
      db.query<{ amount: number; status: string }>(
        `SELECT * FROM payments WHERE order_id = $1 AND business_id = $2 ORDER BY id DESC`,
        [id, bid]
      ),
    ]);

    const totalPaid = payments
      .filter((p) => p.status === 'Completed')
      .reduce((s, p) => s + Number(p.amount || 0), 0);
    const actualMaterialCost = usageRecords.reduce((s, u) => s + Number(u.actual_cost || 0), 0);

    return res.json({
      order,
      measurement,
      estimations,
      usageRecords,
      payments,
      financials: {
        agreedPrice: Number(order.agreed_price || 0),
        totalPaid,
        outstandingBalance: Math.max(0, Number(order.agreed_price || 0) - totalPaid),
        actualMaterialCost,
        labourCost: Number(order.labour_cost || 0),
        otherExpenses: Number(order.other_expenses || 0),
      },
    });
  });

  router.post('/orders', async (req: AppRequest, res: AppResponse) => {
    try {
      const bid = req.auth!.businessId;
      const {
        customerId,
        measurementId,
        garmentType,
        designSpecs,
        color,
        quantity,
        orderDate,
        expectedCompletionDate,
        agreedPrice,
        depositAmount,
        depositMethod,
        labourCost,
        otherExpenses,
        notes,
        clientUuid,
      } = req.body || {};

      const customer = await db.queryOne(`SELECT id FROM customers WHERE id = $1 AND business_id = $2`, [
        Number(customerId),
        bid,
      ]);
      if (!customer) return res.status(404).json({ error: 'Selected customer not found.' });

      if (measurementId) {
        const m = await db.queryOne(
          `SELECT id FROM measurements WHERE id = $1 AND customer_id = $2 AND business_id = $3`,
          [Number(measurementId), Number(customerId), bid]
        );
        if (!m) return res.status(400).json({ error: 'Selected measurement does not belong to this customer.' });
      }

      const qty = Math.max(1, Number(quantity || 1));
      const price = agreedPrice !== undefined && agreedPrice !== null && agreedPrice !== '' ? Number(agreedPrice) : 0;
      const deposit = depositAmount !== undefined && depositAmount !== null && depositAmount !== '' ? Number(depositAmount) : 0;
      if (!garmentType?.trim()) return res.status(400).json({ error: 'Garment type is required.' });
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: 'Agreed selling price cannot be negative.' });
      }
      if (!Number.isFinite(deposit) || deposit < 0 || deposit > price) {
        return res.status(400).json({ error: 'Deposit must be between 0 and the agreed selling price.' });
      }

      const orderNumber = await nextSequenceCode(db, 'tailoring_orders', 'order_number', 'ORD', bid);
      const receiptNumber = deposit > 0 ? await nextSequenceCode(db, 'payments', 'receipt_number', 'RCP', bid) : null;
      const now = nowIso();
      const oDate = orderDate || todayDate();
      const expDate = expectedCompletionDate || todayDate();

      const orderId = await db.transaction(async (tx) => {
        const newOrderId = await tx.insert(
          `INSERT INTO tailoring_orders
            (business_id, client_uuid, order_number, customer_id, measurement_id, garment_type, design_specs, color, quantity, order_date, expected_completion_date, agreed_price, labour_cost, other_expenses, status, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'Pending', $15, $16, $17)`,
          [
            bid,
            clientUuid || null,
            orderNumber,
            Number(customerId),
            measurementId ? Number(measurementId) : null,
            String(garmentType).trim(),
            String(designSpecs || '').trim(),
            String(color || '').trim(),
            qty,
            oDate,
            expDate,
            price,
            Math.max(0, Number(labourCost || 0)),
            Math.max(0, Number(otherExpenses || 0)),
            String(notes || '').trim(),
            now,
            now,
          ]
        );

        if (deposit > 0 && receiptNumber) {
          await tx.insert(
            `INSERT INTO payments
              (business_id, receipt_number, order_id, customer_id, amount, payment_method, payment_type, status, notes, paid_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'Completed', $8, $9, $10)`,
            [
              bid,
              receiptNumber,
              newOrderId,
              Number(customerId),
              deposit,
              depositMethod === 'M-Pesa' ? 'M-Pesa' : depositMethod === 'Bank' ? 'Bank' : 'Cash',
              deposit >= price ? 'Final' : 'Deposit',
              `Initial deposit for ${orderNumber}`,
              now,
              now,
            ]
          );
        }

        return newOrderId;
      });

      const created = await db.queryOne(
        `SELECT o.*, c.full_name AS customer_name, c.customer_number, c.phone AS customer_phone,
                COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.id AND p.business_id = o.business_id AND p.status = 'Completed'), 0) AS total_paid
         FROM tailoring_orders o
         JOIN customers c ON c.id = o.customer_id
         WHERE o.id = $1 AND o.business_id = $2`,
        [orderId, bid]
      );
      return res.status(201).json({ order: created });
    } catch (err) {
      console.error('Create order error:', err);
      return res.status(500).json({ error: 'Failed to create tailoring order.' });
    }
  });

  router.patch('/orders/:id', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const id = Number(req.params.id);
    const existing = await db.queryOne<{
      id: number;
      status: string;
      design_specs: string;
      color: string;
      expected_completion_date: string;
      agreed_price: number;
      labour_cost: number;
      other_expenses: number;
      notes: string;
    }>(`SELECT * FROM tailoring_orders WHERE id = $1 AND business_id = $2`, [id, bid]);
    if (!existing) return res.status(404).json({ error: 'Tailoring order not found.' });

    const { status, designSpecs, color, expectedCompletionDate, agreedPrice, labourCost, otherExpenses, notes } = req.body || {};
    if (status && !VALID_ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid order status.' });
    }
    const nextPrice = agreedPrice !== undefined ? Number(agreedPrice) : Number(existing.agreed_price);
    if (!Number.isFinite(nextPrice) || nextPrice < 0) {
      return res.status(400).json({ error: 'Agreed selling price cannot be negative.' });
    }

    if (agreedPrice !== undefined) {
      const paidRow = await db.queryOne<{ total: number }>(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE order_id = $1 AND business_id = $2 AND status = 'Completed'`,
        [id, bid]
      );
      const alreadyPaid = Number(paidRow?.total || 0);
      if (nextPrice < alreadyPaid - 0.01) {
        return res.status(400).json({
          error: `Agreed selling price (${nextPrice.toFixed(2)}) cannot be less than total payments already collected (${alreadyPaid.toFixed(2)}).`,
        });
      }
    }

    await db.execute(
      `UPDATE tailoring_orders
       SET status = $1, design_specs = $2, color = $3, expected_completion_date = $4,
           agreed_price = $5, labour_cost = $6, other_expenses = $7, notes = $8, updated_at = $9
       WHERE id = $10 AND business_id = $11`,
      [
        status || existing.status,
        designSpecs !== undefined ? String(designSpecs) : existing.design_specs,
        color !== undefined ? String(color) : existing.color,
        expectedCompletionDate || existing.expected_completion_date,
        nextPrice,
        labourCost !== undefined ? Math.max(0, Number(labourCost)) : existing.labour_cost,
        otherExpenses !== undefined ? Math.max(0, Number(otherExpenses)) : existing.other_expenses,
        notes !== undefined ? String(notes) : existing.notes,
        nowIso(),
        id,
        bid,
      ]
    );

    const updated = await db.queryOne(
      `SELECT o.*, c.full_name AS customer_name, c.customer_number, c.phone AS customer_phone,
              COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.id AND p.business_id = o.business_id AND p.status = 'Completed'), 0) AS total_paid
       FROM tailoring_orders o
       JOIN customers c ON c.id = o.customer_id
       WHERE o.id = $1 AND o.business_id = $2`,
      [id, bid]
    );
    return res.json({ order: updated });
  });

  router.delete('/orders/:id', async (req: AppRequest, res: AppResponse) => {
    try {
      const bid = req.auth!.businessId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid order ID.' });
      }

      const existing = await db.queryOne<{ id: number; order_number: string }>(
        `SELECT id, order_number FROM tailoring_orders WHERE id = $1 AND business_id = $2`,
        [id, bid]
      );
      if (!existing) {
        return res.status(404).json({ error: 'Tailoring order not found.' });
      }

      const now = nowIso();
      await db.transaction(async (tx) => {
        const usageRecords = await tx.query<{
          id: number;
          material_id: number;
          issued_qty: number;
          consumed_qty: number;
          returned_qty: number;
          wasted_qty: number;
        }>(
          `SELECT id, material_id, issued_qty, consumed_qty, returned_qty, wasted_qty
           FROM material_usage_records
           WHERE order_id = $1 AND business_id = $2`,
          [id, bid]
        );

        for (const rec of usageRecords) {
          const accounted = Number(rec.consumed_qty || 0) + Number(rec.returned_qty || 0) + Number(rec.wasted_qty || 0);
          const unsettled = Math.max(0, Number(rec.issued_qty || 0) - accounted);
          if (unsettled > 1e-6) {
            await tx.execute(
              `UPDATE materials
               SET current_qty = current_qty + $1,
                   reserved_qty = MAX(0, reserved_qty - $1),
                   updated_at = $2
               WHERE id = $3 AND business_id = $4`,
              [unsettled, now, rec.material_id, bid]
            );
          }
        }

        await tx.execute(
          `UPDATE inventory_transactions SET order_id = NULL WHERE order_id = $1 AND business_id = $2`,
          [id, bid]
        );
        await tx.execute(
          `UPDATE business_expenses SET order_id = NULL WHERE order_id = $1 AND business_id = $2`,
          [id, bid]
        );
        await tx.execute(`DELETE FROM payments WHERE order_id = $1 AND business_id = $2`, [id, bid]);
        await tx.execute(`DELETE FROM fabric_estimations WHERE order_id = $1 AND business_id = $2`, [id, bid]);
        await tx.execute(`DELETE FROM material_usage_records WHERE order_id = $1 AND business_id = $2`, [id, bid]);
        await tx.execute(`DELETE FROM tailoring_orders WHERE id = $1 AND business_id = $2`, [id, bid]);
      });

      return res.json({ deleted: true, id, orderNumber: existing.order_number });
    } catch (err) {
      console.error('Delete order error:', err);
      return res.status(500).json({ error: 'Failed to delete tailoring order.' });
    }
  });

  // =========================================================================
  // MODULE 5: FABRIC ESTIMATION (Rules + Calculations + Saved Estimates)
  // =========================================================================

  router.get('/estimation-rules', async (req: AppRequest, res: AppResponse) => {
    const rules = await db.query(
      `SELECT * FROM fabric_estimation_rules WHERE business_id = $1 ORDER BY garment_type ASC`,
      [req.auth!.businessId]
    );
    return res.json({ rules });
  });

  router.post('/estimation-rules', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const {
      garmentType,
      designStyle,
      baseFabricMeters,
      fabricWidthCm,
      allowancePercent,
      liningRatio,
      interfacingMeters,
      threadSpools,
      buttonsCount,
      zippersCount,
      notes,
    } = req.body || {};

    if (!garmentType?.trim() || Number(baseFabricMeters) <= 0) {
      return res.status(400).json({ error: 'Garment type and positive base fabric meters are required.' });
    }
    const id = await db.insert(
      `INSERT INTO fabric_estimation_rules
        (business_id, garment_type, design_style, base_fabric_meters, fabric_width_cm, allowance_percent, lining_ratio, interfacing_meters, thread_spools, buttons_count, zippers_count, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        bid,
        String(garmentType).trim(),
        String(designStyle || 'Standard').trim(),
        Number(baseFabricMeters),
        Number(fabricWidthCm || 150),
        Number(allowancePercent ?? 10),
        Number(liningRatio ?? 0.75),
        Number(interfacingMeters ?? 0.5),
        Number(threadSpools ?? 1),
        Number(buttonsCount ?? 0),
        Number(zippersCount ?? 0),
        String(notes || '').trim(),
        nowIso(),
      ]
    );
    const rule = await db.queryOne(`SELECT * FROM fabric_estimation_rules WHERE id = $1 AND business_id = $2`, [id, bid]);
    return res.status(201).json({ rule });
  });

  router.put('/estimation-rules/:id', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const id = Number(req.params.id);
    const existing = await db.queryOne(`SELECT id FROM fabric_estimation_rules WHERE id = $1 AND business_id = $2`, [
      id,
      bid,
    ]);
    if (!existing) return res.status(404).json({ error: 'Estimation rule not found.' });

    const {
      garmentType,
      designStyle,
      baseFabricMeters,
      fabricWidthCm,
      allowancePercent,
      liningRatio,
      interfacingMeters,
      threadSpools,
      buttonsCount,
      zippersCount,
      notes,
    } = req.body || {};

    await db.execute(
      `UPDATE fabric_estimation_rules
       SET garment_type = $1, design_style = $2, base_fabric_meters = $3, fabric_width_cm = $4,
           allowance_percent = $5, lining_ratio = $6, interfacing_meters = $7, thread_spools = $8,
           buttons_count = $9, zippers_count = $10, notes = $11, updated_at = $12
       WHERE id = $13 AND business_id = $14`,
      [
        String(garmentType).trim(),
        String(designStyle || 'Standard').trim(),
        Number(baseFabricMeters),
        Number(fabricWidthCm || 150),
        Number(allowancePercent ?? 10),
        Number(liningRatio ?? 0.75),
        Number(interfacingMeters ?? 0.5),
        Number(threadSpools ?? 1),
        Number(buttonsCount ?? 0),
        Number(zippersCount ?? 0),
        String(notes || '').trim(),
        nowIso(),
        id,
        bid,
      ]
    );
    const rule = await db.queryOne(`SELECT * FROM fabric_estimation_rules WHERE id = $1 AND business_id = $2`, [id, bid]);
    return res.json({ rule });
  });

  router.post('/estimations/calculate', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const { orderId, ruleId, fabricWidthCm, allowancePercent, mainFabricMaterialId, liningMaterialId, interfacingMaterialId } =
      req.body || {};

    const order = await db.queryOne<{
      id: number;
      garment_type: string;
      quantity: number;
      measurement_id: number | null;
      design_specs: string;
    }>(`SELECT * FROM tailoring_orders WHERE id = $1 AND business_id = $2`, [Number(orderId), bid]);
    if (!order) return res.status(404).json({ error: 'Tailoring order not found.' });

    const rule = ruleId
      ? await db.queryOne<Record<string, unknown>>(
          `SELECT * FROM fabric_estimation_rules WHERE id = $1 AND business_id = $2`,
          [Number(ruleId), bid]
        )
      : await db.queryOne<Record<string, unknown>>(
          `SELECT * FROM fabric_estimation_rules WHERE business_id = $1 AND LOWER(garment_type) = LOWER($2) LIMIT 1`,
          [bid, order.garment_type]
        );

    const measurement = order.measurement_id
      ? await db.queryOne<{ values_json: string; unit: string }>(
          `SELECT values_json, unit FROM measurements WHERE id = $1 AND business_id = $2`,
          [order.measurement_id, bid]
        )
      : null;

    let measurementFactor = 1.0;
    if (measurement?.values_json) {
      try {
        const vals = JSON.parse(measurement.values_json) as Record<string, number>;
        const toCm = (v: number) => (measurement.unit === 'in' ? v * 2.54 : v);
        const chest = vals.chest || vals.bust || 0;
        const waist = vals.waist || 0;
        const length = vals.jacket_length || vals.dress_length || vals.trouser_length || 0;
        if (chest > 0) {
          const chestCm = toCm(Number(chest));
          if (chestCm > 104) measurementFactor += Math.min(0.35, (chestCm - 104) * 0.008);
          else if (chestCm < 92) measurementFactor -= Math.min(0.12, (92 - chestCm) * 0.005);
        }
        if (waist > 0) {
          const waistCm = toCm(Number(waist));
          if (waistCm > 92) measurementFactor += Math.min(0.25, (waistCm - 92) * 0.006);
        }
        if (length > 0) {
          const lenCm = toCm(Number(length));
          if (lenCm > 110) measurementFactor += Math.min(0.3, (lenCm - 110) * 0.006);
        }
      } catch {
        // default factor
      }
    }

    const baseMeters = Number(rule?.base_fabric_meters || 2.0);
    const ruleWidth = Number(rule?.fabric_width_cm || 150);
    const widthCm = Math.max(80, Number(fabricWidthCm || ruleWidth));
    const widthFactor = ruleWidth / widthCm;
    const allowance = Math.max(0, Number(allowancePercent ?? rule?.allowance_percent ?? 10));
    const allowanceFactor = 1 + allowance / 100;
    const qty = Math.max(1, Number(order.quantity || 1));

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const estFabric = round2(baseMeters * measurementFactor * widthFactor * allowanceFactor * qty);
    const estLining = round2(estFabric * Number(rule?.lining_ratio ?? 0.75));
    const estInterfacing = round2(Number(rule?.interfacing_meters ?? 0.5) * qty * allowanceFactor);
    const estThread = Math.ceil(Number(rule?.thread_spools ?? 1) * qty);
    const estButtons = Math.ceil(Number(rule?.buttons_count ?? 0) * qty);
    const estZippers = Math.ceil(Number(rule?.zippers_count ?? 0) * qty);

    const materials = await db.query<{
      id: number;
      name: string;
      category: string;
      unit: string;
      purchase_price: number;
      current_qty: number;
    }>(`SELECT id, name, category, unit, purchase_price, current_qty FROM materials WHERE business_id = $1`, [bid]);

    const findMat = (explicitId: unknown, categoryMatches: string[]) => {
      if (explicitId) {
        const found = materials.find((m) => m.id === Number(explicitId));
        if (found) return found;
      }
      return materials.find((m) => categoryMatches.includes(m.category));
    };

    const fabricMat = findMat(mainFabricMaterialId, ['Suit Fabric', 'Dress Fabric']);
    const liningMat = findMat(liningMaterialId, ['Lining']);
    const interfMat = findMat(interfacingMaterialId, ['Interfacing']);
    const threadMat = findMat(null, ['Thread']);
    const buttonMat = findMat(null, ['Buttons']);
    const zipMat = findMat(null, ['Zippers']);

    const makeItem = (
      label: string,
      category: string,
      estQty: number,
      defaultUnit: string,
      mat?: (typeof materials)[number]
    ) => {
      const available = mat ? Number(mat.current_qty) : 0;
      const unitCost = mat ? Number(mat.purchase_price) : 0;
      const shortage = round2(Math.max(0, estQty - available));
      return {
        materialId: mat?.id || null,
        materialName: mat?.name || label,
        category,
        estimatedQty: estQty,
        unit: mat?.unit || defaultUnit,
        availableQty: available,
        shortageQty: shortage,
        estimatedUnitCost: unitCost,
        estimatedTotalCost: round2(estQty * unitCost),
      };
    };

    const items = [
      makeItem('Primary Fabric', 'Suit Fabric', estFabric, 'meters', fabricMat),
      ...(estLining > 0 ? [makeItem('Lining Fabric', 'Lining', estLining, 'meters', liningMat)] : []),
      ...(estInterfacing > 0 ? [makeItem('Interfacing', 'Interfacing', estInterfacing, 'meters', interfMat)] : []),
      ...(estThread > 0 ? [makeItem('Sewing Thread', 'Thread', estThread, 'spools', threadMat)] : []),
      ...(estButtons > 0 ? [makeItem('Buttons', 'Buttons', estButtons, 'pieces', buttonMat)] : []),
      ...(estZippers > 0 ? [makeItem('Zipper', 'Zippers', estZippers, 'pieces', zipMat)] : []),
    ];

    const totalEstimatedCost = round2(items.reduce((s, i) => s + i.estimatedTotalCost, 0));

    return res.json({
      calculation: {
        orderId: order.id,
        ruleId: rule?.id || null,
        fabricWidthCm: widthCm,
        allowancePercent: allowance,
        measurementFactor: round2(measurementFactor),
        items,
        totalEstimatedCost,
      },
    });
  });

  router.get('/estimations', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const rows = await db.query(
      `SELECT fe.*, o.order_number, o.garment_type, c.full_name AS customer_name
       FROM fabric_estimations fe
       JOIN tailoring_orders o ON o.id = fe.order_id AND o.business_id = fe.business_id
       JOIN customers c ON c.id = o.customer_id AND c.business_id = o.business_id
       WHERE fe.business_id = $1 ORDER BY fe.id DESC`,
      [bid]
    );
    return res.json({ estimations: rows });
  });

  router.post('/estimations', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const { orderId, ruleId, fabricWidthCm, allowancePercent, items, notes, clientUuid } = req.body || {};
    const order = await db.queryOne(`SELECT id FROM tailoring_orders WHERE id = $1 AND business_id = $2`, [
      Number(orderId),
      bid,
    ]);
    if (!order) return res.status(404).json({ error: 'Tailoring order not found.' });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one estimated material line item is required.' });
    }

    const totalCost = items.reduce(
      (s: number, item: { estimatedQty?: number; estimatedUnitCost?: number }) =>
        s + Number(item.estimatedQty || 0) * Number(item.estimatedUnitCost || 0),
      0
    );
    const now = nowIso();
    const id = await db.insert(
      `INSERT INTO fabric_estimations
        (business_id, client_uuid, order_id, rule_id, fabric_width_cm, allowance_percent, items_json, total_estimated_cost, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        bid,
        clientUuid || null,
        Number(orderId),
        ruleId ? Number(ruleId) : null,
        Number(fabricWidthCm || 150),
        Number(allowancePercent ?? 10),
        JSON.stringify(items),
        Math.round(totalCost * 100) / 100,
        String(notes || '').trim(),
        now,
        now,
      ]
    );
    const saved = await db.queryOne(`SELECT * FROM fabric_estimations WHERE id = $1 AND business_id = $2`, [id, bid]);
    return res.status(201).json({ estimation: saved });
  });

  // =========================================================================
  // MODULE 6: INVENTORY MANAGEMENT & ACTUAL MATERIAL CONSUMPTION
  // =========================================================================

  router.get('/materials', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const materials = await db.query(`SELECT * FROM materials WHERE business_id = $1 ORDER BY name ASC`, [bid]);
    return res.json({ materials });
  });

  router.post('/materials', async (req: AppRequest, res: AppResponse) => {
    try {
      const bid = req.auth!.businessId;
      const { name, category, description, unit, purchasePrice, currentQty, minStockLevel, clientUuid } = req.body || {};
      if (!name?.trim() || !category?.trim() || !unit?.trim()) {
        return res.status(400).json({ error: 'Material name, category, and unit are required.' });
      }
      const price = Math.max(0, Number(purchasePrice || 0));
      const qty = Math.max(0, Number(currentQty || 0));
      const minStock = Math.max(0, Number(minStockLevel ?? 5));
      const sku = await nextSequenceCode(db, 'materials', 'sku', 'MAT', bid);
      const now = nowIso();

      const matId = await db.transaction(async (tx) => {
        const id = await tx.insert(
          `INSERT INTO materials
            (business_id, client_uuid, sku, name, category, description, unit, purchase_price, current_qty, reserved_qty, min_stock_level, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12)`,
          [
            bid,
            clientUuid || null,
            sku,
            String(name).trim(),
            String(category).trim(),
            String(description || '').trim(),
            String(unit).trim(),
            price,
            qty,
            minStock,
            now,
            now,
          ]
        );
        if (qty > 0) {
          await tx.insert(
            `INSERT INTO inventory_transactions (business_id, material_id, tx_type, qty, unit_cost, total_cost, notes, created_at)
             VALUES ($1, $2, 'PURCHASE', $3, $4, $5, 'Opening stock on material registration', $6)`,
            [bid, id, qty, price, Math.round(qty * price * 100) / 100, now]
          );
        }
        return id;
      });

      const material = await db.queryOne(`SELECT * FROM materials WHERE id = $1 AND business_id = $2`, [matId, bid]);
      return res.status(201).json({ material });
    } catch (err) {
      console.error('Create material error:', err);
      return res.status(500).json({ error: 'Failed to register material.' });
    }
  });

  router.put('/materials/:id', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const id = Number(req.params.id);
    const existing = await db.queryOne(`SELECT * FROM materials WHERE id = $1 AND business_id = $2`, [id, bid]);
    if (!existing) return res.status(404).json({ error: 'Material not found.' });

    const { name, category, description, unit, purchasePrice, minStockLevel } = req.body || {};
    await db.execute(
      `UPDATE materials SET name = $1, category = $2, description = $3, unit = $4, purchase_price = $5, min_stock_level = $6, updated_at = $7
       WHERE id = $8 AND business_id = $9`,
      [
        String(name).trim(),
        String(category).trim(),
        String(description || '').trim(),
        String(unit).trim(),
        Math.max(0, Number(purchasePrice || 0)),
        Math.max(0, Number(minStockLevel ?? 5)),
        nowIso(),
        id,
        bid,
      ]
    );
    const material = await db.queryOne(`SELECT * FROM materials WHERE id = $1 AND business_id = $2`, [id, bid]);
    return res.json({ material });
  });

  router.post('/materials/:id/purchase', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const id = Number(req.params.id);
    const { qty, unitCost, notes } = req.body || {};
    const addQty = Number(qty || 0);
    const cost = Number(unitCost || 0);
    if (!Number.isFinite(addQty) || addQty <= 0) {
      return res.status(400).json({ error: 'Purchase quantity must be greater than zero.' });
    }
    if (!Number.isFinite(cost) || cost < 0) {
      return res.status(400).json({ error: 'Purchase unit cost cannot be negative.' });
    }

    const material = await db.queryOne<{ id: number; current_qty: number; purchase_price: number }>(
      `SELECT id, current_qty, purchase_price FROM materials WHERE id = $1 AND business_id = $2`,
      [id, bid]
    );
    if (!material) return res.status(404).json({ error: 'Material not found.' });

    const now = nowIso();
    const oldQty = Math.max(0, Number(material.current_qty));
    const oldVal = oldQty * Number(material.purchase_price);
    const newVal = addQty * cost;
    const nextPrice = oldQty + addQty > 0 ? Math.round(((oldVal + newVal) / (oldQty + addQty)) * 100) / 100 : cost;

    await db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE materials SET current_qty = current_qty + $1, purchase_price = $2, updated_at = $3
         WHERE id = $4 AND business_id = $5`,
        [addQty, nextPrice, now, id, bid]
      );
      await tx.insert(
        `INSERT INTO inventory_transactions (business_id, material_id, tx_type, qty, unit_cost, total_cost, notes, created_at)
         VALUES ($1, $2, 'PURCHASE', $3, $4, $5, $6, $7)`,
        [bid, id, addQty, cost, Math.round(addQty * cost * 100) / 100, String(notes || 'Stock purchase').trim(), now]
      );
    });

    const updated = await db.queryOne(`SELECT * FROM materials WHERE id = $1 AND business_id = $2`, [id, bid]);
    return res.json({ material: updated });
  });

  router.get('/material-usage', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const records = await db.query(
      `SELECT u.*, m.name AS material_name, m.unit AS material_unit, o.order_number
       FROM material_usage_records u
       JOIN materials m ON m.id = u.material_id AND m.business_id = u.business_id
       JOIN tailoring_orders o ON o.id = u.order_id AND o.business_id = u.business_id
       WHERE u.business_id = $1 ORDER BY u.id DESC`,
      [bid]
    );
    const transactions = await db.query(
      `SELECT t.*, m.name AS material_name, m.unit AS material_unit, o.order_number
       FROM inventory_transactions t
       JOIN materials m ON m.id = t.material_id AND m.business_id = t.business_id
       LEFT JOIN tailoring_orders o ON o.id = t.order_id AND o.business_id = t.business_id
       WHERE t.business_id = $1 ORDER BY t.id DESC LIMIT 200`,
      [bid]
    );
    return res.json({ usageRecords: records, inventoryTransactions: transactions });
  });

  router.post('/material-usage', async (req: AppRequest, res: AppResponse) => {
    try {
      const bid = req.auth!.businessId;
      const { orderId, materialId, issuedQty, consumedQty, returnedQty, wastedQty, notes, clientUuid } = req.body || {};

      const [order, material] = await Promise.all([
        db.queryOne(`SELECT id, order_number FROM tailoring_orders WHERE id = $1 AND business_id = $2`, [
          Number(orderId),
          bid,
        ]),
        db.queryOne<{ id: number; name: string; current_qty: number; purchase_price: number }>(
          `SELECT id, name, current_qty, purchase_price FROM materials WHERE id = $1 AND business_id = $2`,
          [Number(materialId), bid]
        ),
      ]);
      if (!order) return res.status(404).json({ error: 'Tailoring order not found.' });
      if (!material) return res.status(404).json({ error: 'Material not found.' });

      const issued = Number(issuedQty || 0);
      const consumed = Number(consumedQty || 0);
      const returned = Number(returnedQty || 0);
      const wasted = Number(wastedQty || 0);

      if (!Number.isFinite(issued) || issued <= 0) {
        return res.status(400).json({ error: 'Issued quantity must be greater than zero.' });
      }
      if (consumed < 0 || returned < 0 || wasted < 0) {
        return res.status(400).json({ error: 'Consumed, returned, and wasted quantities cannot be negative.' });
      }
      if (consumed + returned + wasted > issued + 1e-6) {
        return res.status(400).json({
          error: 'Sum of consumed, returned, and wasted quantities cannot exceed the issued quantity.',
        });
      }
      if (Number(material.current_qty) < issued) {
        return res.status(400).json({
          error: `Insufficient stock for ${material.name}. Available: ${material.current_qty}, Requested: ${issued}.`,
        });
      }

      const unitCost = Number(material.purchase_price || 0);
      const isSettledNow = consumed > 0 || returned > 0 || wasted > 0;
      const netOutflow = isSettledNow ? issued - returned : issued;
      const reservedDelta = isSettledNow ? Math.max(0, issued - (consumed + returned + wasted)) : issued;
      const actualCost = Math.round((consumed + wasted) * unitCost * 100) / 100;
      const status = isSettledNow
        ? Math.abs(consumed + returned + wasted - issued) < 1e-6
          ? 'Settled'
          : 'Partial'
        : 'Issued';
      const now = nowIso();

      const usageId = await db.transaction(async (tx) => {
        await tx.execute(
          `UPDATE materials
           SET current_qty = current_qty - $1, reserved_qty = reserved_qty + $2, updated_at = $3
           WHERE id = $4 AND business_id = $5`,
          [netOutflow, reservedDelta, now, material.id, bid]
        );

        const recId = await tx.insert(
          `INSERT INTO material_usage_records
            (business_id, client_uuid, order_id, material_id, issued_qty, consumed_qty, returned_qty, wasted_qty, unit_cost_at_time, actual_cost, status, notes, recorded_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            bid,
            clientUuid || null,
            Number(orderId),
            material.id,
            issued,
            consumed,
            returned,
            wasted,
            unitCost,
            actualCost,
            status,
            String(notes || '').trim(),
            now,
            now,
          ]
        );

        await tx.insert(
          `INSERT INTO inventory_transactions (business_id, material_id, order_id, tx_type, qty, unit_cost, total_cost, notes, created_at)
           VALUES ($1, $2, $3, 'ISSUE', $4, $5, $6, $7, $8)`,
          [bid, material.id, Number(orderId), issued, unitCost, Math.round(issued * unitCost * 100) / 100, `Issued to order`, now]
        );
        if (consumed > 0) {
          await tx.insert(
            `INSERT INTO inventory_transactions (business_id, material_id, order_id, tx_type, qty, unit_cost, total_cost, notes, created_at)
             VALUES ($1, $2, $3, 'CONSUME', $4, $5, $6, $7, $8)`,
            [bid, material.id, Number(orderId), consumed, unitCost, Math.round(consumed * unitCost * 100) / 100, `Actual consumption`, now]
          );
        }
        if (returned > 0) {
          await tx.insert(
            `INSERT INTO inventory_transactions (business_id, material_id, order_id, tx_type, qty, unit_cost, total_cost, notes, created_at)
             VALUES ($1, $2, $3, 'RETURN', $4, $5, $6, $7, $8)`,
            [bid, material.id, Number(orderId), returned, unitCost, Math.round(returned * unitCost * 100) / 100, `Unused material returned to stock`, now]
          );
        }
        if (wasted > 0) {
          await tx.insert(
            `INSERT INTO inventory_transactions (business_id, material_id, order_id, tx_type, qty, unit_cost, total_cost, notes, created_at)
             VALUES ($1, $2, $3, 'WASTE', $4, $5, $6, $7, $8)`,
            [bid, material.id, Number(orderId), wasted, unitCost, Math.round(wasted * unitCost * 100) / 100, `Production wastage / damage`, now]
          );
        }
        return recId;
      });

      const created = await db.queryOne(
        `SELECT u.*, m.name AS material_name, m.unit AS material_unit, o.order_number
         FROM material_usage_records u
         JOIN materials m ON m.id = u.material_id
         JOIN tailoring_orders o ON o.id = u.order_id
         WHERE u.id = $1 AND u.business_id = $2`,
        [usageId, bid]
      );
      return res.status(201).json({ usageRecord: created });
    } catch (err) {
      console.error('Material usage error:', err);
      return res.status(500).json({ error: 'Failed to record material usage.' });
    }
  });

  router.post('/material-usage/:id/settle', async (req: AppRequest, res: AppResponse) => {
    try {
      const bid = req.auth!.businessId;
      const id = Number(req.params.id);
      const { consumedQty, returnedQty, wastedQty, notes } = req.body || {};

      const rec = await db.queryOne<{
        id: number;
        order_id: number;
        material_id: number;
        issued_qty: number;
        consumed_qty: number;
        returned_qty: number;
        wasted_qty: number;
        unit_cost_at_time: number;
        status: string;
      }>(`SELECT * FROM material_usage_records WHERE id = $1 AND business_id = $2`, [id, bid]);
      if (!rec) return res.status(404).json({ error: 'Material usage record not found.' });
      if (rec.status === 'Settled') {
        return res.status(400).json({ error: 'This material issuance has already been fully settled.' });
      }

      const addConsumed = Number(consumedQty || 0);
      const addReturned = Number(returnedQty || 0);
      const addWasted = Number(wastedQty || 0);
      if (addConsumed < 0 || addReturned < 0 || addWasted < 0 || addConsumed + addReturned + addWasted <= 0) {
        return res.status(400).json({ error: 'Enter non-negative quantities with at least one positive value.' });
      }

      const alreadyAccounted = Number(rec.consumed_qty) + Number(rec.returned_qty) + Number(rec.wasted_qty);
      const remainingIssued = Number(rec.issued_qty) - alreadyAccounted;
      const settlingTotal = addConsumed + addReturned + addWasted;
      if (settlingTotal > remainingIssued + 1e-6) {
        return res.status(400).json({
          error: `Settling quantity (${settlingTotal}) exceeds remaining issued quantity (${remainingIssued}).`,
        });
      }

      const nextConsumed = Number(rec.consumed_qty) + addConsumed;
      const nextReturned = Number(rec.returned_qty) + addReturned;
      const nextWasted = Number(rec.wasted_qty) + addWasted;
      const unitCost = Number(rec.unit_cost_at_time);
      const nextActualCost = Math.round((nextConsumed + nextWasted) * unitCost * 100) / 100;
      const nextStatus = Math.abs(remainingIssued - settlingTotal) < 1e-6 ? 'Settled' : 'Partial';
      const now = nowIso();

      await db.transaction(async (tx) => {
        await tx.execute(
          `UPDATE materials
           SET current_qty = current_qty + $1,
               reserved_qty = MAX(0, reserved_qty - $2),
               updated_at = $3
           WHERE id = $4 AND business_id = $5`,
          [addReturned, settlingTotal, now, rec.material_id, bid]
        );

        await tx.execute(
          `UPDATE material_usage_records
           SET consumed_qty = $1, returned_qty = $2, wasted_qty = $3, actual_cost = $4, status = $5, notes = $6, updated_at = $7
           WHERE id = $8 AND business_id = $9`,
          [nextConsumed, nextReturned, nextWasted, nextActualCost, nextStatus, String(notes || '').trim(), now, id, bid]
        );

        if (addConsumed > 0) {
          await tx.insert(
            `INSERT INTO inventory_transactions (business_id, material_id, order_id, tx_type, qty, unit_cost, total_cost, notes, created_at)
             VALUES ($1, $2, $3, 'CONSUME', $4, $5, $6, 'Settled actual consumption', $7)`,
            [bid, rec.material_id, rec.order_id, addConsumed, unitCost, Math.round(addConsumed * unitCost * 100) / 100, now]
          );
        }
        if (addReturned > 0) {
          await tx.insert(
            `INSERT INTO inventory_transactions (business_id, material_id, order_id, tx_type, qty, unit_cost, total_cost, notes, created_at)
             VALUES ($1, $2, $3, 'RETURN', $4, $5, $6, 'Unused material returned to stock', $7)`,
            [bid, rec.material_id, rec.order_id, addReturned, unitCost, Math.round(addReturned * unitCost * 100) / 100, now]
          );
        }
        if (addWasted > 0) {
          await tx.insert(
            `INSERT INTO inventory_transactions (business_id, material_id, order_id, tx_type, qty, unit_cost, total_cost, notes, created_at)
             VALUES ($1, $2, $3, 'WASTE', $4, $5, $6, 'Recorded material wastage / damage', $7)`,
            [bid, rec.material_id, rec.order_id, addWasted, unitCost, Math.round(addWasted * unitCost * 100) / 100, now]
          );
        }
      });

      const updated = await db.queryOne(
        `SELECT u.*, m.name AS material_name, m.unit AS material_unit, o.order_number
         FROM material_usage_records u
         JOIN materials m ON m.id = u.material_id
         JOIN tailoring_orders o ON o.id = u.order_id
         WHERE u.id = $1 AND u.business_id = $2`,
        [id, bid]
      );
      return res.json({ usageRecord: updated });
    } catch (err) {
      console.error('Settle material usage error:', err);
      return res.status(500).json({ error: 'Failed to settle material usage.' });
    }
  });

  // =========================================================================
  // MODULE 7: POS & PAYMENTS (Cash, Manual M-Pesa, Bank Transfer)
  // =========================================================================

  router.get('/payments', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const payments = await db.query(
      `SELECT p.*, c.full_name AS customer_name, c.customer_number, o.order_number, o.agreed_price
       FROM payments p
       JOIN customers c ON c.id = p.customer_id AND c.business_id = p.business_id
       JOIN tailoring_orders o ON o.id = p.order_id AND o.business_id = p.business_id
       WHERE p.business_id = $1 ORDER BY p.id DESC`,
      [bid]
    );
    return res.json({ payments });
  });

  router.post('/payments', async (req: AppRequest, res: AppResponse) => {
    try {
      const bid = req.auth!.businessId;
      const {
        orderId,
        amount,
        paymentMethod,
        paymentType,
        mpesaReference,
        paidAt,
        notes,
        clientUuid,
      } = req.body || {};

      const method = String(paymentMethod || 'Cash').trim();
      if (!['Cash', 'M-Pesa', 'Bank'].includes(method)) {
        return res.status(400).json({
          error: 'Invalid payment method. Supported methods are Cash, M-Pesa, or Bank.',
        });
      }

      const payAmount = Number(amount || 0);
      if (!Number.isFinite(payAmount) || payAmount <= 0) {
        return res.status(400).json({ error: 'Payment amount must be greater than zero.' });
      }

      let resolvedPaidAt = nowIso();
      if (paidAt) {
        const parsedDate = new Date(String(paidAt));
        if (Number.isNaN(parsedDate.getTime())) {
          return res.status(400).json({ error: 'Invalid payment date and time.' });
        }
        resolvedPaidAt = parsedDate.toISOString();
      }

      const cleanReference = String(mpesaReference || '').trim().toUpperCase();
      const cleanNotes = String(notes || '').trim();

      const paymentId = await db.transaction(async (tx) => {
        const order = await tx.queryOne<{
          id: number;
          customer_id: number;
          order_number: string;
          agreed_price: number;
          status: string;
        }>(`SELECT * FROM tailoring_orders WHERE id = $1 AND business_id = $2`, [
          Number(orderId),
          bid,
        ]);
        if (!order) {
          throw Object.assign(new Error('Tailoring order not found.'), { statusCode: 404 });
        }
        if (order.status === 'Cancelled') {
          throw Object.assign(new Error('Cannot record payment on a cancelled order.'), {
            statusCode: 400,
          });
        }
        if (Number(order.agreed_price || 0) <= 0) {
          throw Object.assign(
            new Error('Save an Agreed Selling Price for this order before recording payment.'),
            { statusCode: 400 }
          );
        }

        const paidRow = await tx.queryOne<{ total: number }>(
          `SELECT COALESCE(SUM(amount), 0) AS total
           FROM payments
           WHERE order_id = $1 AND business_id = $2 AND status = 'Completed'`,
          [order.id, bid]
        );
        const alreadyPaid = Number(paidRow?.total || 0);
        const remaining = Math.max(0, Number(order.agreed_price) - alreadyPaid);
        if (payAmount > remaining + 0.01) {
          throw Object.assign(
            new Error(
              `Payment amount (${payAmount}) exceeds outstanding balance (${remaining.toFixed(2)}).`
            ),
            { statusCode: 400 }
          );
        }

        const receiptNumber = await nextSequenceCode(tx, 'payments', 'receipt_number', 'RCP', bid);
        const now = nowIso();
        const computedType =
          paymentType ||
          (alreadyPaid === 0 && payAmount < remaining
            ? 'Deposit'
            : payAmount >= remaining - 0.01
            ? 'Final'
            : 'Partial');

        return tx.insert(
          `INSERT INTO payments
            (business_id, client_uuid, receipt_number, order_id, customer_id, amount, payment_method, payment_type, status, mpesa_receipt_number, notes, paid_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Completed', $9, $10, $11, $12)`,
          [
            bid,
            clientUuid || null,
            receiptNumber,
            order.id,
            order.customer_id,
            payAmount,
            method,
            computedType,
            cleanReference,
            cleanNotes,
            resolvedPaidAt,
            now,
          ]
        );
      });

      const payment = await db.queryOne(
        `SELECT p.*, c.full_name AS customer_name, c.customer_number, o.order_number, o.agreed_price
         FROM payments p
         JOIN customers c ON c.id = p.customer_id
         JOIN tailoring_orders o ON o.id = p.order_id
         WHERE p.id = $1 AND p.business_id = $2`,
        [paymentId, bid]
      );

      return res.status(201).json({ payment });
    } catch (err) {
      const statusCode =
        err && typeof err === 'object' && 'statusCode' in err
          ? Number((err as { statusCode?: number }).statusCode || 500)
          : 500;
      if (statusCode < 500) {
        return res.status(statusCode).json({ error: (err as Error).message });
      }
      console.error('Payment recording error:', err);
      return res.status(500).json({ error: 'Failed to record payment.' });
    }
  });

  // =========================================================================
  // BUSINESS EXPENSES (for Profitability Reports)
  // =========================================================================

  router.get('/expenses', async (req: AppRequest, res: AppResponse) => {
    const rows = await db.query(
      `SELECT e.*, o.order_number
       FROM business_expenses e
       LEFT JOIN tailoring_orders o ON o.id = e.order_id AND o.business_id = e.business_id
       WHERE e.business_id = $1 ORDER BY e.expense_date DESC, e.id DESC`,
      [req.auth!.businessId]
    );
    return res.json({ expenses: rows });
  });

  router.post('/expenses', async (req: AppRequest, res: AppResponse) => {
    const bid = req.auth!.businessId;
    const { orderId, category, description, amount, expenseDate } = req.body || {};
    const amt = Number(amount || 0);
    if (!category?.trim() || !description?.trim() || !Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Category, description, and positive amount are required.' });
    }
    if (orderId) {
      const ord = await db.queryOne(`SELECT id FROM tailoring_orders WHERE id = $1 AND business_id = $2`, [
        Number(orderId),
        bid,
      ]);
      if (!ord) return res.status(404).json({ error: 'Referenced order not found.' });
    }
    const id = await db.insert(
      `INSERT INTO business_expenses (business_id, order_id, category, description, amount, expense_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [bid, orderId ? Number(orderId) : null, String(category).trim(), String(description).trim(), amt, expenseDate || todayDate(), nowIso()]
    );
    const expense = await db.queryOne(`SELECT * FROM business_expenses WHERE id = $1 AND business_id = $2`, [id, bid]);
    return res.status(201).json({ expense });
  });

  // =========================================================================
  // MODULE 8: REPORTS (Strictly Separates Estimated vs Actual Costs)
  // =========================================================================

  router.get('/reports', async (req: AppRequest, res: AppResponse) => {
    try {
      const bid = req.auth!.businessId;
      const startDate = String(req.query.startDate || '').trim();
      const endDate = String(req.query.endDate || '').trim();
      const category = String(req.query.category || '').trim();

      const [orders, customers, payments, materials, usageRecords, estimations, expenses] = await Promise.all([
        db.query<{
          id: number;
          order_number: string;
          customer_id: number;
          customer_name: string;
          garment_type: string;
          status: string;
          agreed_price: number;
          labour_cost: number;
          other_expenses: number;
          order_date: string;
          expected_completion_date: string;
        }>(
          `SELECT o.*, c.full_name AS customer_name
           FROM tailoring_orders o
           JOIN customers c ON c.id = o.customer_id AND c.business_id = o.business_id
           WHERE o.business_id = $1 ORDER BY o.order_date DESC`,
          [bid]
        ),
        db.query<{ id: number; customer_number: string; full_name: string; phone: string; created_at: string }>(
          `SELECT * FROM customers WHERE business_id = $1 ORDER BY id DESC`,
          [bid]
        ),
        db.query<{
          id: number;
          order_id: number;
          customer_id: number;
          amount: number;
          payment_method: string;
          status: string;
          paid_at: string;
        }>(`SELECT * FROM payments WHERE business_id = $1 ORDER BY id DESC`, [bid]),
        db.query<{
          id: number;
          sku: string;
          name: string;
          category: string;
          unit: string;
          purchase_price: number;
          current_qty: number;
          reserved_qty: number;
          min_stock_level: number;
        }>(`SELECT * FROM materials WHERE business_id = $1 ORDER BY name ASC`, [bid]),
        db.query<{
          id: number;
          order_id: number;
          order_number: string;
          material_id: number;
          material_name: string;
          category: string;
          unit: string;
          issued_qty: number;
          consumed_qty: number;
          returned_qty: number;
          wasted_qty: number;
          unit_cost_at_time: number;
          actual_cost: number;
          recorded_at: string;
        }>(
          `SELECT u.*, m.name AS material_name, m.category, m.unit, o.order_number
           FROM material_usage_records u
           JOIN materials m ON m.id = u.material_id AND m.business_id = u.business_id
           JOIN tailoring_orders o ON o.id = u.order_id AND o.business_id = u.business_id
           WHERE u.business_id = $1 ORDER BY u.id DESC`,
          [bid]
        ),
        db.query<{ order_id: number; total_estimated_cost: number; created_at: string }>(
          `SELECT order_id, total_estimated_cost, created_at FROM fabric_estimations WHERE business_id = $1 ORDER BY id DESC`,
          [bid]
        ),
        db.query<{ id: number; category: string; description: string; amount: number; expense_date: string }>(
          `SELECT * FROM business_expenses WHERE business_id = $1 ORDER BY expense_date DESC`,
          [bid]
        ),
      ]);

      const inDateRange = (d: string) => {
        const day = (d || '').slice(0, 10);
        if (startDate && day < startDate) return false;
        if (endDate && day > endDate) return false;
        return true;
      };

      const filteredOrders = orders.filter((o) => {
        if (!inDateRange(o.order_date)) return false;
        if (category && category !== 'All' && o.garment_type !== category && o.status !== category) return false;
        return true;
      });
      const activeOrders = filteredOrders.filter((o) => o.status !== 'Cancelled');

      const paidByOrder: Record<number, number> = {};
      for (const p of payments) {
        if (p.status === 'Completed') {
          paidByOrder[p.order_id] = (paidByOrder[p.order_id] || 0) + Number(p.amount || 0);
        }
      }

      const actualCostByOrder: Record<number, number> = {};
      const filteredUsage = usageRecords.filter((u) => inDateRange(u.recorded_at));
      for (const u of usageRecords) {
        actualCostByOrder[u.order_id] = (actualCostByOrder[u.order_id] || 0) + Number(u.actual_cost || 0);
      }

      const latestEstByOrder: Record<number, number> = {};
      for (const e of estimations) {
        if (latestEstByOrder[e.order_id] === undefined) {
          latestEstByOrder[e.order_id] = Number(e.total_estimated_cost || 0);
        }
      }

      const outstandingOrders = activeOrders
        .map((o) => {
          const paid = paidByOrder[o.id] || 0;
          const balance = Math.max(0, Number(o.agreed_price) - paid);
          return { ...o, totalPaid: paid, outstandingBalance: balance };
        })
        .filter((o) => o.outstandingBalance > 0.01);

      const estVsActual = activeOrders.map((o) => {
        const estimated = latestEstByOrder[o.id] ?? null;
        const actual = actualCostByOrder[o.id] ?? 0;
        const hasActualRecorded = usageRecords.some((u) => u.order_id === o.id && (u.consumed_qty > 0 || u.wasted_qty > 0));
        return {
          orderId: o.id,
          orderNumber: o.order_number,
          customerName: o.customer_name,
          garmentType: o.garment_type,
          estimatedMaterialCost: estimated,
          actualMaterialCost: actual,
          hasActualRecorded,
          variance: estimated !== null && hasActualRecorded ? actual - estimated : null,
        };
      });

      const filteredPayments = payments.filter((p) => p.status === 'Completed' && inDateRange(p.paid_at));
      const filteredExpenses = expenses.filter((e) => inDateRange(e.expense_date));

      const totalSalesRevenue = activeOrders.reduce((s, o) => s + Number(o.agreed_price || 0), 0);
      const totalCollectedPayments = filteredPayments.reduce((s, p) => s + Number(p.amount || 0), 0);
      const totalActualMaterialCost = activeOrders.reduce((s, o) => s + (actualCostByOrder[o.id] || 0), 0);
      const totalLabourCost = activeOrders.reduce((s, o) => s + Number(o.labour_cost || 0), 0);
      const totalOrderOtherExpenses = activeOrders.reduce((s, o) => s + Number(o.other_expenses || 0), 0);
      const totalOperatingExpenses = filteredExpenses.reduce((s, e) => s + Number(e.amount || 0), 0);
      const ordersWithActualMaterials = activeOrders.filter((o) =>
        usageRecords.some((u) => u.order_id === o.id && (u.consumed_qty > 0 || u.wasted_qty > 0))
      ).length;

      const grossProfit =
        totalSalesRevenue - totalActualMaterialCost - totalLabourCost - totalOrderOtherExpenses - totalOperatingExpenses;

      const customerSummary = customers.map((c) => {
        const custOrders = orders.filter((o) => o.customer_id === c.id && o.status !== 'Cancelled');
        const billed = custOrders.reduce((s, o) => s + Number(o.agreed_price || 0), 0);
        const paid = custOrders.reduce((s, o) => s + (paidByOrder[o.id] || 0), 0);
        return {
          ...c,
          orderCount: custOrders.length,
          totalBilled: billed,
          totalPaid: paid,
          outstandingBalance: Math.max(0, billed - paid),
        };
      });

      return res.json({
        salesReport: {
          totalOrders: activeOrders.length,
          totalSalesValue: totalSalesRevenue,
          totalPaymentsReceived: totalCollectedPayments,
          totalOutstanding: outstandingOrders.reduce((s, o) => s + o.outstandingBalance, 0),
          orders: activeOrders.map((o) => ({
            ...o,
            totalPaid: paidByOrder[o.id] || 0,
            outstandingBalance: Math.max(0, Number(o.agreed_price) - (paidByOrder[o.id] || 0)),
          })),
        },
        customerReport: customerSummary,
        orderReport: filteredOrders,
        completionReport: {
          total: filteredOrders.length,
          completedOrCollected: filteredOrders.filter((o) =>
            ['Completed', 'Ready for Collection', 'Collected'].includes(o.status)
          ).length,
          inProgress: filteredOrders.filter((o) => o.status === 'In Progress').length,
          pending: filteredOrders.filter((o) => o.status === 'Pending').length,
          cancelled: filteredOrders.filter((o) => o.status === 'Cancelled').length,
        },
        outstandingPaymentReport: outstandingOrders,
        inventoryReport: materials.map((m) => ({
          ...m,
          stockValue: Math.round(Number(m.current_qty) * Number(m.purchase_price) * 100) / 100,
          isLowStock: Number(m.current_qty) <= Number(m.min_stock_level),
        })),
        consumptionReport: filteredUsage,
        wastageReport: filteredUsage
          .filter((u) => Number(u.wasted_qty) > 0)
          .map((u) => ({
            ...u,
            wastageCost: Math.round(Number(u.wasted_qty) * Number(u.unit_cost_at_time) * 100) / 100,
          })),
        estimatedVsActualReport: estVsActual,
        profitabilityReport: {
          totalSalesRevenue,
          totalActualMaterialCost,
          totalLabourCost,
          totalOrderOtherExpenses,
          totalOperatingExpenses,
          netRecordedProfit: grossProfit,
          ordersCount: activeOrders.length,
          ordersWithActualMaterialsCount: ordersWithActualMaterials,
          hasIncompleteCostData: ordersWithActualMaterials < activeOrders.length,
        },
      });
    } catch (err) {
      console.error('Reports error:', err);
      return res.status(500).json({ error: 'Failed to generate reports.' });
    }
  });
}
