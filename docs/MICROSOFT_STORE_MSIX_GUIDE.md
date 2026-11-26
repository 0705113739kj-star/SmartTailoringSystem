# SmartTailoringSystem — MSIX Packaging & Microsoft Store Submission Guide

This guide covers building, validating, signing, and submitting **SmartTailoringSystem** as a Windows 10 / Windows 11 MSIX (AppX) package for your reserved Microsoft Store product name.

---

## 1. Prerequisites on Your Windows Build Machine

Perform final `.msix` / `.appx` packaging on a **Windows 10 (1809+) or Windows 11 (x64)** machine with:

1. **Node.js 22 LTS or newer** (required for built-in `node:sqlite`).
2. **Windows 10/11 SDK** installed (provides `makeappx.exe`, `signtool.exe`, and the **Windows App Certification Kit**).
3. Repository cloned and dependencies installed:
   ```powershell
   npm install
   npm run icons:generate
   ```

---

## 2. Configure Reserved Microsoft Partner Center Identity

In **Microsoft Partner Center → Apps and games → SmartTailoringSystem → Product management → Product identity**, copy your exact assigned values (do **not** guess or invent them):

- **Package/Identity/Name** (e.g., `12345YourPublisher.SmartTailoringSystem`)
- **Package/Identity/Publisher** (e.g., `CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`)
- **Package/Properties/PublisherDisplayName** (your exact registered publisher display name)

Update those three placeholders in:

1. `electron-builder.yml` under `appx:`
   ```yaml
   appx:
     applicationId: SmartTailoringSystem
     displayName: SmartTailoringSystem
     identityName: REPLACE-WITH-PARTNER-CENTER-IDENTITY-NAME
     publisher: CN=REPLACE-WITH-PARTNER-CENTER-PUBLISHER-GUID
     publisherDisplayName: REPLACE-WITH-YOUR-REGISTERED-PUBLISHER-NAME
   ```
2. `build/appx/AppxManifest.template.xml` (reference template if inspecting or customizing manifest fields).

> **Important:** `Package/Properties/DisplayName` and `uap:VisualElements/@DisplayName` remain `SmartTailoringSystem` to match your Microsoft Store reservation.

---

## 3. Generate Application Icons & Visual Assets

Run the included asset generator before packaging:

```powershell
npm run icons:generate
```

This creates:
- `build/icon.png` (512x512 desktop icon)
- `build/icon.ico` (multi-size Windows executable & shortcut icon: 16–256px)
- `build/appx/Square44x44Logo.png` (Start menu & taskbar app icon)
- `build/appx/Square150x150Logo.png` (Medium tile)
- `build/appx/StoreLogo.png` (50x50 Store badge)
- `build/appx/Wide310x150Logo.png` (Wide tile)

You may replace these generated PNG/ICO files with custom bespoke branding artwork at the exact same filenames and pixel dimensions before running `dist:msix`.

---

## 4. Build & Package the MSIX (AppX)

Run on Windows:

```powershell
npm run dist:msix
```

Or build the standalone NSIS desktop installer for direct sideload testing:

```powershell
npm run dist:win
```

Output artifacts are placed in `release/`.

### Local Sideloading & Testing on Windows 10/11

- For **Store submission**, Microsoft Partner Center re-signs the uploaded package automatically with the Store certificate.
- For **local testing of the `.appx`/`.msix` before submission**, sign the package with a trusted self-signed test certificate matching your `publisher` CN via `signtool.exe` (or use `npm run dist:win` to test the desktop app directly).
- Verify after installation:
  1. **SmartTailoringSystem** appears in the Windows Start menu with its icon.
  2. Launching opens directly into the application window without opening a browser or command prompt.
  3. Complete offline operation works with Wi-Fi / Ethernet disconnected.
  4. Customer data persists in `%LOCALAPPDATA%\SmartTailoringSystem\data\smarttailoring.db` across app restarts, Windows reboots, and upgrades.

---

## 5. Run Windows App Certification Kit (WACK)

1. Install your test-signed `.msix` / `.appx` or open **Windows App Cert Kit** from the Start menu.
2. Select **Validate a Windows Store app**, pick **SmartTailoringSystem**, and run the full test suite.
3. Confirm all checks pass (including `runFullTrust` Electron desktop bridge compliance).

---

## 6. Microsoft Partner Center Submission Checklist

1. **Package upload**: Upload the `.msix` / `.appx` generated in `release/`.
2. **Capabilities disclosure**:
   - `runFullTrust`: Required for the Electron desktop runtime and embedded local SQLite engine.
   - `internetClient`: Optional outbound access when the user explicitly clicks external support links in Settings (core POS works 100% offline).
3. **Privacy Policy & Data Storage**: Disclose that all customer, measurement, order, inventory, and payment records are stored locally on the user's Windows device (`%LOCALAPPDATA%\SmartTailoringSystem\data\smarttailoring.db`) and never transmitted to external servers.
4. **Age rating & Store listing**: Upload screenshots of the Dashboard, Tailoring Orders, POS & Payments, and Reports views.
