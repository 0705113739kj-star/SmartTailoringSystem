# SmartTailoringSystem

**SmartTailoringSystem** is a standalone, 100% offline-capable Windows 10 and Windows 11 desktop Point of Sale (POS) and workshop operations system built for tailoring businesses, packaged with Electron and configured for MSIX / Microsoft Store distribution.

## Key Capabilities & Desktop Architecture

- **100% Offline-First Desktop Operation**: Launches directly into its desktop window with zero internet requirement, no external database, and no remote server dependencies.
- **Persistent Local SQLite Database**: Embedded `node:sqlite` (`DatabaseSync`) with WAL mode, foreign keys, automatic schema creation, tracked migrations (`schema_migrations` + `PRAGMA user_version = 2`), and transactional integrity.
  - Default Windows path: `%LOCALAPPDATA%\SmartTailoringSystem\data\smarttailoring.db` (preserved across restarts and app updates).
- **Secure Electron Shell**: Context isolation (`contextIsolation: true`), sandboxed renderer (`sandbox: true`), disabled Node integration (`nodeIntegration: false`), strict IPC preload bridge (`window.smartTailoringDesktop`), single-instance lock, and loopback-only (`127.0.0.1`) embedded API server.
- **Database Backup & Restore**: Built into **Settings** with `VACUUM INTO` snapshot export (`SmartTailoringSystem_Backup_YYYY-MM-DD.db`), SQLite header + `PRAGMA integrity_check` + table validation, explicit confirmation warnings, automatic pre-restore safety snapshots (`backups/`), and configurable backup reminders.

## Core Modules

1. **Dashboard** — Live KPIs, Chart.js sales/order/monthly performance charts, low-stock alerts, upcoming deadlines, and quick actions.
2. **Customers** — Auto-numbered customer registry (`CUS-0001`), duplicate prevention, profile view, order history, payment history, and outstanding balance tracking.
3. **Measurements** — Garment-specific body measurement forms (`cm` / `in`) with non-destructive versioned revision history.
4. **Tailoring Orders** — End-to-end order lifecycle (`Pending`, `In Progress`, `Completed`, `Ready for Collection`, `Collected`, `Cancelled`), linked measurements, and printable order sheets.
5. **Fabric Estimation** — Configurable estimation rules factoring garment type, measurements, fabric width, and allowances with stock shortage checks.
6. **Inventory Management** — Materials catalog, stock purchases with weighted average valuation, low-stock alerts, and **Material Usage & Consumption Recording** (Issued, Consumed, Returned, Wasted) with zero double-counting.
7. **POS & Payments** — Manual payment recording for **Cash** (with change-due calculator), **Manual M-Pesa** (receive via your own Till/Paybill/phone and record amount, optional transaction reference code, date/time, and notes), and **Bank** transfers, plus printable thermal/A4/PDF receipts.
8. **Reports** — Sales, Customer, Orders, Completion, Outstanding Balances, Inventory, Material Consumption, Material Wastage, Estimated vs. Actual Material Cost, and Profitability reports with date/category filters, Print/PDF, and CSV export.
9. **Settings & Local Data Backup** — Business profile, credentials, password change, SQLite backup export, validated database restore, backup reminder schedule, and optional support links opened safely in the system browser.

## Development & Packaging Scripts

```bash
# Install dependencies (Node.js 22+ recommended for built-in node:sqlite)
npm install

# Generate Windows .ico, desktop PNG, and MSIX tile assets in build/
npm run icons:generate

# Run full web + Electron dev build locally
npm run dev

# Launch the Electron desktop window against compiled renderer & preload
npm run build:web && npm run desktop:dev

# Run automated tests (multi-tenant isolation, inventory accounting, manual M-Pesa/Bank payments, backup & restore)
npm test

# Database CLI utilities (override path via SMARTTAILORING_DB_PATH if needed)
npm run db:init
npm run db:migrate

# Build Windows NSIS installer or Microsoft Store MSIX (.appx) on Windows 10/11
npm run dist:win
npm run dist:msix

# Sync offline web + WASM SQLite runtime into Android Capacitor & build Debug APK
npm run mobile:sync
npm run mobile:android   # Opens android/ project in Android Studio
npm run mobile:apk       # Builds android/app/build/outputs/apk/debug/app-debug.apk via Gradle
```

- **Windows & Microsoft Store**: See [`docs/MICROSOFT_STORE_MSIX_GUIDE.md`](docs/MICROSOFT_STORE_MSIX_GUIDE.md) for Partner Center setup, MSIX packaging, and Store submission.
- **Android APK**: See [`docs/ANDROID_APK_GUIDE.md`](docs/ANDROID_APK_GUIDE.md) for Android Studio / Gradle APK compilation, sideloading, signed release builds, and transferring `.db` backups between Windows and Android.
