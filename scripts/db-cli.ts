import { createDatabase, getDefaultDbPath, runMigrations } from '../src/server/db.ts';

async function main() {
  const cmd = process.argv[2] || 'init';
  const dbPath = getDefaultDbPath();
  const db = await createDatabase(dbPath);
  try {
    if (cmd === 'migrate') {
      const res = await runMigrations(db);
      console.log(
        `SmartTailoringSystem SQLite migrated (${db.dbPath}) -> schema v${res.currentVersion}`
      );
    } else {
      const version = await db.getSchemaVersion();
      console.log(
        `SmartTailoringSystem SQLite initialized (${db.dbPath}) at schema v${version}`
      );
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('Database CLI error:', err);
  process.exit(1);
});
