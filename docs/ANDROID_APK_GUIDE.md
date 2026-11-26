# SmartTailoringSystem — Android APK Build & Installation Guide

This guide explains how to compile **SmartTailoringSystem** into an installable Android `.apk` using **Capacitor** on Windows (or macOS/Linux).

> **100% Offline Android Runtime**
> On Android, SmartTailoringSystem runs an embedded `sql.js` WebAssembly SQLite database persisted natively in the app's private storage directory (`Directory.Data/smarttailoring.db`) via `@capacitor/filesystem`. No internet connection or remote server is required after installation, and `.db` backup files are compatible with the Windows Desktop edition.

---

## 1. Prerequisites (On Your Computer)

Install the following once on your Windows PC:

1. **Node.js 22+** (already installed if you built the Windows desktop version)
2. **Android Studio** (includes the Android SDK, platform tools, and bundled **JDK 17/21**):
   - Download from: `https://developer.android.com/studio`
   - During setup, ensure **Android SDK**, **Android SDK Platform-Tools**, and **Android SDK Build-Tools** are installed.
3. *(Optional for CLI-only builds)* Set `JAVA_HOME` (e.g., `C:\Program Files\Android\Android Studio\jbr`) and `ANDROID_HOME` (e.g., `C:\Users\<You>\AppData\Local\Android\Sdk`) in Windows Environment Variables.

---

## 2. Sync Web Assets & Icons to the Android Project

From the project folder in PowerShell:

```powershell
npm install
npm run icons:generate
npm run mobile:sync
```

What this does:
- Generates Android launcher icons (`mipmap-mdpi` through `mipmap-xxxhdpi` including adaptive foreground & teal `#0F766E` background) alongside Windows/MSIX icons.
- Copies `sql-wasm.wasm` to `public/wasm/sql-wasm.wasm` and runs `vite build`.
- Syncs `dist/` and Capacitor plugins into `android/app/src/main/assets/public/`.

---

## 3. Build a Debug APK (Fastest for Phone Testing & Workshop Sideloading)

### Option A: One Command in PowerShell (requires JDK & Android SDK configured)

```powershell
npm run mobile:apk
```

When Gradle finishes, your installable APK is output to:

```text
android\app\build\outputs\apk\debug\app-debug.apk
```

### Option B: Build in Android Studio (Zero Environment Variable Setup)

1. Run:
   ```powershell
   npm run mobile:android
   ```
   This builds, syncs, and opens the `android/` project in **Android Studio**.
2. Wait for the first Gradle sync to finish.
3. In Android Studio's menu, choose **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
4. Click **locate** in the notification toast to open:
   `android\app\build\outputs\apk\debug\app-debug.apk`

---

## 4. Install the APK on Your Android Phone or Tablet

1. Copy `app-debug.apk` to your Android device (USB cable, WhatsApp/Telegram to yourself, Google Drive, etc.) — or connect the phone with USB Debugging enabled and run:
   ```powershell
   adb install android\app\build\outputs\apk\debug\app-debug.apk
   ```
2. On the Android device, tap `app-debug.apk` in your Files app.
3. If prompted *"For your security, your phone isn't allowed to install unknown apps from this source"*, tap **Settings** → enable **Allow from this source**, then tap **Install**.

---

## 5. Build a Signed Release APK (For Workshop Rollout or Play Store)

1. Open the project in Android Studio:
   ```powershell
   npm run mobile:android
   ```
2. In Android Studio, select **Build → Generate Signed Bundle / APK...**
3. Choose **APK** (for direct sideloading) or **Android App Bundle (.aab)** (for Google Play Store).
4. Click **Create new...** to create a signing keystore (keep this `.jks` file and passwords backed up safely).
5. Select the **release** build variant and finish.
6. Your signed release APK will be saved under:
   `android\app\build\outputs\apk\release\app-release.apk`

---

## 6. Transferring Data Between Windows Desktop & Android

Because both the Windows Desktop (`node:sqlite`) and Android (`sql.js` WASM) versions use the exact same SQLite v2 schema and scrypt password hashing:

1. On Windows Desktop: go to **Settings → Database Backup & Restore → Create Backup (.db)** to save `SmartTailoringSystem_Backup_YYYY-MM-DD.db`.
2. Copy that `.db` file to your Android phone.
3. On Android: open **Settings → Database Backup & Restore → Restore from Backup**, select the `.db` file, review the verified record counts, and confirm restore. Your workshop profile, login credentials, customers, measurements, orders, inventory, and payments transfer seamlessly.
