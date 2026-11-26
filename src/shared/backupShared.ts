import { type DbClient, nowIso } from './schema.ts';

export const SQLITE_HEADER = 'SQLite format 3\0';

export const REQUIRED_TABLES = [
  'businesses',
  'users',
  'customers',
  'measurements',
  'tailoring_orders',
  'materials',
  'payments',
];

export interface BackupSummary {
  schemaVersion: number;
  fileSizeBytes: number;
  businesses: number;
  customers: number;
  orders: number;
  payments: number;
  materials: number;
}

export interface BackupValidationResult {
  valid: boolean;
  error?: string;
  summary?: BackupSummary;
}

export function formatBackupFilename(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `SmartTailoringSystem_Backup_${yyyy}-${mm}-${dd}.db`;
}

export function formatSafetySnapshotFilename(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `SmartTailoringSystem_PreRestore_${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}.db`;
}

export async function getPreferences(
  db: DbClient,
  businessId: number
): Promise<Record<string, string>> {
  const rows = await db.query<{ pref_key: string; pref_value: string }>(
    `SELECT pref_key, pref_value FROM app_preferences WHERE business_id = $1`,
    [businessId]
  );
  const map: Record<string, string> = {};
  for (const r of rows) {
    map[r.pref_key] = r.pref_value;
  }
  return map;
}

export async function setPreference(
  db: DbClient,
  businessId: number,
  key: string,
  value: string
): Promise<void> {
  await db.execute(
    `INSERT INTO app_preferences (business_id, pref_key, pref_value, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(business_id, pref_key)
     DO UPDATE SET pref_value = excluded.pref_value, updated_at = excluded.updated_at`,
    [businessId, key, value, nowIso()]
  );
}
