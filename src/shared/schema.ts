export type DbDialect = 'sqlite';

export const CURRENT_SCHEMA_VERSION = 2;

export interface DbClient {
  dialect: DbDialect;
  dbPath: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number; lastInsertId?: number }>;
  insert(sql: string, params?: unknown[]): Promise<number>;
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  checkpoint(): Promise<void>;
  backupTo(destPath: string): Promise<void>;
  exportBytes?: () => Promise<Uint8Array>;
  getSchemaVersion(): Promise<number>;
  close(): Promise<void>;
}

export interface DbHolder {
  current: DbClient;
}

export function translateSqlForSqlite(
  sql: string,
  params: unknown[]
): { sql: string; params: unknown[] } {
  const expandedParams: unknown[] = [];
  const translated = sql.replace(/\$(\d+)/g, (_match, numStr) => {
    const idx = Number(numStr) - 1;
    expandedParams.push(params[idx] === undefined ? null : params[idx]);
    return '?';
  });
  return { sql: translated, params: expandedParams };
}

export function normalizeSqliteParams(
  params: unknown[]
): (string | number | Uint8Array | null)[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'bigint') return Number(p);
    if (typeof p === 'string' || typeof p === 'number' || p instanceof Uint8Array) {
      return p;
    }
    return JSON.stringify(p);
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runMigrations(db: DbClient): Promise<{
  previousVersion: number;
  currentVersion: number;
  applied: number[];
}> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const previousVersion = await db.getSchemaVersion();
  const appliedRows = await db.query<{ version: number }>(
    `SELECT version FROM schema_migrations ORDER BY version ASC`
  );
  const appliedSet = new Set(appliedRows.map((r) => Number(r.version)));
  const appliedNow: number[] = [];

  // Migration 1: Baseline Tailoring POS schema
  const baselineStatements = [
    `CREATE TABLE IF NOT EXISTS businesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'KES',
      address TEXT DEFAULT '',
      receipt_footer TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL,
      username TEXT DEFAULT '',
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      client_uuid TEXT,
      customer_number TEXT NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT DEFAULT '',
      address TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(business_id, customer_number),
      UNIQUE(business_id, client_uuid)
    )`,

    `CREATE TABLE IF NOT EXISTS measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      client_uuid TEXT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      garment_type TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'cm',
      values_json TEXT NOT NULL,
      notes TEXT DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      recorded_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(business_id, client_uuid)
    )`,

    `CREATE TABLE IF NOT EXISTS measurement_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      measurement_id INTEGER NOT NULL REFERENCES measurements(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      garment_type TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'cm',
      values_json TEXT NOT NULL,
      notes TEXT DEFAULT '',
      version INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS tailoring_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      client_uuid TEXT,
      order_number TEXT NOT NULL,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      measurement_id INTEGER REFERENCES measurements(id) ON DELETE SET NULL,
      garment_type TEXT NOT NULL,
      design_specs TEXT DEFAULT '',
      color TEXT DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 1,
      order_date TEXT NOT NULL,
      expected_completion_date TEXT NOT NULL,
      agreed_price REAL NOT NULL DEFAULT 0,
      labour_cost REAL NOT NULL DEFAULT 0,
      other_expenses REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Pending',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(business_id, order_number),
      UNIQUE(business_id, client_uuid)
    )`,

    `CREATE TABLE IF NOT EXISTS fabric_estimation_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      garment_type TEXT NOT NULL,
      design_style TEXT NOT NULL DEFAULT 'Standard',
      base_fabric_meters REAL NOT NULL,
      fabric_width_cm REAL NOT NULL DEFAULT 150,
      allowance_percent REAL NOT NULL DEFAULT 10,
      lining_ratio REAL NOT NULL DEFAULT 0.75,
      interfacing_meters REAL NOT NULL DEFAULT 0.5,
      thread_spools REAL NOT NULL DEFAULT 1,
      buttons_count INTEGER NOT NULL DEFAULT 0,
      zippers_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      updated_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS fabric_estimations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      client_uuid TEXT,
      order_id INTEGER NOT NULL REFERENCES tailoring_orders(id) ON DELETE CASCADE,
      rule_id INTEGER REFERENCES fabric_estimation_rules(id) ON DELETE SET NULL,
      fabric_width_cm REAL NOT NULL DEFAULT 150,
      allowance_percent REAL NOT NULL DEFAULT 10,
      items_json TEXT NOT NULL,
      total_estimated_cost REAL NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(business_id, client_uuid)
    )`,

    `CREATE TABLE IF NOT EXISTS materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      client_uuid TEXT,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT DEFAULT '',
      unit TEXT NOT NULL,
      purchase_price REAL NOT NULL DEFAULT 0,
      current_qty REAL NOT NULL DEFAULT 0,
      reserved_qty REAL NOT NULL DEFAULT 0,
      min_stock_level REAL NOT NULL DEFAULT 5,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(business_id, sku),
      UNIQUE(business_id, client_uuid)
    )`,

    `CREATE TABLE IF NOT EXISTS inventory_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      client_uuid TEXT,
      material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      order_id INTEGER REFERENCES tailoring_orders(id) ON DELETE SET NULL,
      tx_type TEXT NOT NULL,
      qty REAL NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS material_usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      client_uuid TEXT,
      order_id INTEGER NOT NULL REFERENCES tailoring_orders(id) ON DELETE CASCADE,
      material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
      issued_qty REAL NOT NULL DEFAULT 0,
      consumed_qty REAL NOT NULL DEFAULT 0,
      returned_qty REAL NOT NULL DEFAULT 0,
      wasted_qty REAL NOT NULL DEFAULT 0,
      unit_cost_at_time REAL NOT NULL DEFAULT 0,
      actual_cost REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Issued',
      notes TEXT DEFAULT '',
      recorded_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(business_id, client_uuid)
    )`,

    `CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      client_uuid TEXT,
      receipt_number TEXT NOT NULL,
      order_id INTEGER NOT NULL REFERENCES tailoring_orders(id) ON DELETE RESTRICT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      payment_type TEXT NOT NULL DEFAULT 'Partial',
      status TEXT NOT NULL DEFAULT 'Completed',
      mpesa_checkout_request_id TEXT DEFAULT '',
      mpesa_receipt_number TEXT DEFAULT '',
      mpesa_phone TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      paid_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(business_id, receipt_number),
      UNIQUE(business_id, client_uuid)
    )`,

    `CREATE TABLE IF NOT EXISTS business_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      order_id INTEGER REFERENCES tailoring_orders(id) ON DELETE SET NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      expense_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,

    `CREATE INDEX IF NOT EXISTS idx_customers_business ON customers(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_measurements_business ON measurements(business_id, customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_business ON tailoring_orders(business_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_materials_business ON materials(business_id, category)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_business ON payments(business_id, order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_business ON material_usage_records(business_id, order_id)`,
  ];

  for (const stmt of baselineStatements) {
    await db.execute(stmt);
  }

  // Idempotent column checks for databases imported from older versions
  const bizCols = await db.query<{ name: string }>(`PRAGMA table_info(businesses)`);
  const bizColNames = new Set(bizCols.map((c) => c.name));
  if (!bizColNames.has('address')) {
    await db.execute(`ALTER TABLE businesses ADD COLUMN address TEXT DEFAULT ''`);
  }
  if (!bizColNames.has('receipt_footer')) {
    await db.execute(`ALTER TABLE businesses ADD COLUMN receipt_footer TEXT DEFAULT ''`);
  }

  const userCols = await db.query<{ name: string }>(`PRAGMA table_info(users)`);
  const userColNames = new Set(userCols.map((c) => c.name));
  if (!userColNames.has('username')) {
    await db.execute(`ALTER TABLE users ADD COLUMN username TEXT DEFAULT ''`);
  }

  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique ON users(LOWER(username)) WHERE username IS NOT NULL AND username != ''`
  );

  if (!appliedSet.has(1)) {
    await db.execute(
      `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)`,
      [1, '001_initial_local_sqlite_schema', nowIso()]
    );
    appliedNow.push(1);
  }

  // Migration 2: Preferences & backup tracking + payment method index
  await db.execute(`
    CREATE TABLE IF NOT EXISTS app_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      pref_key TEXT NOT NULL,
      pref_value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      UNIQUE(business_id, pref_key)
    )
  `);
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(business_id, payment_method)`
  );

  if (!appliedSet.has(2)) {
    await db.execute(
      `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)`,
      [2, '002_desktop_preferences_and_backup_tracking', nowIso()]
    );
    appliedNow.push(2);
  }

  await db.execute(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);

  return {
    previousVersion,
    currentVersion: CURRENT_SCHEMA_VERSION,
    applied: appliedNow,
  };
}
