import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  HardDrive,
  Info,
  Lock,
  Save,
  ShieldCheck,
  Upload,
  User,
  X,
} from 'lucide-react';
import { apiDownloadBlob, apiRequest, apiUploadBinary, formatDate, isMobileNative } from '../lib/api';
import type {
  AuthUser,
  BackupStatus,
  BackupSummary,
  BackupValidationResult,
} from '../types';

interface SettingsViewProps {
  user: AuthUser;
  onUserUpdated: (updated: AuthUser) => Promise<void>;
  onDatabaseRestored: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

interface PendingRestore {
  fileName: string;
  filePath?: string;
  fileBytes?: Uint8Array;
  summary: BackupSummary;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  user,
  onUserUpdated,
  onDatabaseRestored,
  onNotify,
}) => {
  const isElectron =
    typeof window !== 'undefined' && Boolean(window.smartTailoringDesktop?.isElectron);
  const isMobile = isMobileNative();

  // Profile & Workshop form
  const [fullName, setFullName] = useState(user.fullName);
  const [username, setUsername] = useState(user.username || '');
  const [email, setEmail] = useState(user.email);
  const [phone, setPhone] = useState(user.phone);
  const [businessName, setBusinessName] = useState(user.businessName);
  const [currency, setCurrency] = useState(user.currency || 'KES');
  const [businessAddress, setBusinessAddress] = useState(user.businessAddress || '');
  const [receiptFooter, setReceiptFooter] = useState(user.receiptFooter || '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');

  // Password form
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPwd, setShowCurrentPwd] = useState(false);
  const [showNewPwd, setShowNewPwd] = useState(false);
  const [showConfirmPwd, setShowConfirmPwd] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');

  // Backup & Restore state
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [loadingBackupStatus, setLoadingBackupStatus] = useState(true);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [validatingRestore, setValidatingRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null);
  const [backupError, setBackupError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadBackupStatus = useCallback(async () => {
    setLoadingBackupStatus(true);
    try {
      const status = await apiRequest<BackupStatus>('/api/backup/status');
      setBackupStatus(status);
      if (window.smartTailoringDesktop?.getAppInfo) {
        const info = await window.smartTailoringDesktop.getAppInfo();
        if (info?.version) setAppVersion(info.version);
      }
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : 'Unable to read database status.');
    } finally {
      setLoadingBackupStatus(false);
    }
  }, []);

  useEffect(() => {
    void loadBackupStatus();
  }, [loadBackupStatus]);

  useEffect(() => {
    setFullName(user.fullName);
    setUsername(user.username || '');
    setEmail(user.email);
    setPhone(user.phone);
    setBusinessName(user.businessName);
    setCurrency(user.currency || 'KES');
    setBusinessAddress(user.businessAddress || '');
    setReceiptFooter(user.receiptFooter || '');
  }, [user]);

  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileError('');
    setProfileSuccess('');
    setSavingProfile(true);
    try {
      const res = await apiRequest<{ user: AuthUser; message: string }>('/api/settings/profile', {
        method: 'PUT',
        body: JSON.stringify({
          fullName: fullName.trim(),
          username: username.trim(),
          email: email.trim(),
          phone: phone.trim(),
          businessName: businessName.trim(),
          currency,
          businessAddress: businessAddress.trim(),
          receiptFooter: receiptFooter.trim(),
        }),
      });
      const merged: AuthUser = {
        ...res.user,
        sessionToken: user.sessionToken,
      };
      await onUserUpdated(merged);
      setProfileSuccess(res.message || 'Profile settings saved.');
      onNotify('Account & workshop settings updated.', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update settings.';
      setProfileError(msg);
      onNotify(msg, 'error');
    } finally {
      setSavingProfile(false);
    }
  };

  const handlePasswordSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');
    if (newPassword.length < 6) {
      setPasswordError('New password must be at least 6 characters long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New password and confirmation do not match.');
      return;
    }
    setSavingPassword(true);
    try {
      const res = await apiRequest<{ message: string }>('/api/settings/password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSuccess(res.message || 'Password updated.');
      onNotify('Password updated successfully.', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update password.';
      setPasswordError(msg);
      onNotify(msg, 'error');
    } finally {
      setSavingPassword(false);
    }
  };

  const handleReminderChange = async (days: number) => {
    try {
      await apiRequest('/api/backup/preferences', {
        method: 'PUT',
        body: JSON.stringify({ reminderDays: days }),
      });
      setBackupStatus((prev) => (prev ? { ...prev, reminderDays: days } : prev));
      onNotify(
        days === 0
          ? 'Periodic backup reminders disabled.'
          : `Backup reminder set to every ${days} days.`,
        'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save reminder preference.', 'error');
    }
  };

  const handleCreateBackup = async () => {
    setBackupError('');
    setCreatingBackup(true);
    try {
      if (isElectron && window.smartTailoringDesktop) {
        const res = await window.smartTailoringDesktop.createBackup(user.businessId);
        if (res.cancelled) return;
        if (res.error) throw new Error(res.error);
        await loadBackupStatus();
        onNotify(`Database backup saved to ${res.path || 'your selected folder'}.`, 'success');
        return;
      }

      const { blob, filename } = await apiDownloadBlob('/api/backup/export');
      if (isMobile) {
        try {
          const [{ Directory, Filesystem }, { Share }, { uint8ToBase64 }] = await Promise.all([
            import('@capacitor/filesystem'),
            import('@capacitor/share'),
            import('../mobile/sqlJsDb'),
          ]);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          await Filesystem.writeFile({
            path: filename,
            data: uint8ToBase64(bytes),
            directory: Directory.Cache,
            recursive: true,
          });
          const uriRes = await Filesystem.getUri({
            path: filename,
            directory: Directory.Cache,
          });
          await Share.share({
            title: filename,
            url: uriRes.uri,
            dialogTitle: 'Save SmartTailoringSystem Database Backup',
          });
          await loadBackupStatus();
          onNotify(`Database backup ${filename} ready to save or share.`, 'success');
          return;
        } catch {
          // Fall through to browser download
        }
      }

      const pickerWin = window as unknown as {
        showSaveFilePicker?: (opts: unknown) => Promise<{
          createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }>;
        }>;
      };
      if (typeof pickerWin.showSaveFilePicker === 'function') {
        try {
          const handle = await pickerWin.showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: 'SQLite Database Backup', accept: { 'application/x-sqlite3': ['.db'] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          await loadBackupStatus();
          onNotify(`Database backup saved as ${filename}.`, 'success');
          return;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
        }
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      await loadBackupStatus();
      onNotify(`Downloaded database backup ${filename}.`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create database backup.';
      setBackupError(msg);
      onNotify(msg, 'error');
    } finally {
      setCreatingBackup(false);
    }
  };

  const handlePickRestoreFile = async () => {
    setBackupError('');
    if (isElectron && window.smartTailoringDesktop) {
      setValidatingRestore(true);
      try {
        const res = await window.smartTailoringDesktop.pickAndValidateBackup();
        if (res.cancelled) return;
        if (!res.valid || !res.summary || !res.filePath) {
          throw new Error(res.error || 'Selected file is not a valid SmartTailoringSystem backup.');
        }
        setPendingRestore({
          fileName: res.fileName || res.filePath,
          filePath: res.filePath,
          summary: res.summary,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Backup validation failed.';
        setBackupError(msg);
        onNotify(msg, 'error');
      } finally {
        setValidatingRestore(false);
      }
      return;
    }

    fileInputRef.current?.click();
  };

  const handleBrowserFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setBackupError('');
    setValidatingRestore(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const validation = await apiUploadBinary<BackupValidationResult>('/api/backup/validate', bytes);
      if (!validation.valid || !validation.summary) {
        throw new Error(validation.error || 'Selected file is not a valid SmartTailoringSystem backup.');
      }
      setPendingRestore({
        fileName: file.name,
        fileBytes: bytes,
        summary: validation.summary,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Backup validation failed.';
      setBackupError(msg);
      onNotify(msg, 'error');
    } finally {
      setValidatingRestore(false);
    }
  };

  const handleConfirmRestore = async () => {
    if (!pendingRestore) return;
    setRestoring(true);
    setBackupError('');
    try {
      let safetyBackupPath = '';
      if (isElectron && window.smartTailoringDesktop && pendingRestore.filePath) {
        const res = await window.smartTailoringDesktop.restoreBackup(pendingRestore.filePath);
        if (!res.restored) {
          throw new Error(res.error || 'Database restore failed.');
        }
        safetyBackupPath = res.safetyBackupPath || '';
      } else if (pendingRestore.fileBytes) {
        const res = await apiUploadBinary<{
          restored: boolean;
          safetyBackupPath?: string;
        }>('/api/backup/restore', pendingRestore.fileBytes);
        if (!res.restored) {
          throw new Error('Database restore failed.');
        }
        safetyBackupPath = res.safetyBackupPath || '';
      } else {
        throw new Error('Missing backup file reference.');
      }

      setPendingRestore(null);
      await onDatabaseRestored();
      await loadBackupStatus();
      onNotify(
        safetyBackupPath
          ? `Database restored successfully. Safety snapshot saved at ${safetyBackupPath}.`
          : 'Database restored successfully.',
        'success'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to restore database.';
      setBackupError(msg);
      onNotify(msg, 'error');
    } finally {
      setRestoring(false);
    }
  };

  const handleOpenExternalLink = async (url: string) => {
    if (isElectron && window.smartTailoringDesktop) {
      const res = await window.smartTailoringDesktop.openExternal(url);
      if (!res.opened) {
        onNotify(res.error || 'Could not open external link.', 'error');
      }
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-bold text-slate-900">Account &amp; Workshop Settings</h1>
        <p className="text-sm text-slate-500">
          Manage your workshop profile, local credentials, receipt branding, and local SQLite database backups.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Owner Profile & Business Details */}
        <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex items-center gap-2 border-b border-slate-100 pb-3 mb-4">
            <User className="h-4 w-4 text-teal-700" />
            <h2 className="font-display text-sm font-semibold text-slate-900">
              Owner Profile &amp; Business Details
            </h2>
          </div>

          {profileError && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700" role="alert">
              {profileError}
            </div>
          )}
          {profileSuccess && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3.5 py-2.5 text-xs text-teal-800">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{profileSuccess}</span>
            </div>
          )}

          <form onSubmit={handleProfileSave} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Owner Full Name *</label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Username (Login Handle)</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. grace.tailor"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-teal-600 focus:outline-none"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Optional. Allows signing in with either your username or email.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Email Address *</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Phone Number *</label>
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-teal-600 focus:outline-none"
                />
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100">
              <div className="flex items-center gap-2 mb-3">
                <Building2 className="h-4 w-4 text-slate-600" />
                <span className="text-xs font-semibold text-slate-800">Workshop &amp; Receipt Branding</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Business Name *</label>
                  <input
                    type="text"
                    required
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Operating Currency</label>
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                  >
                    <option value="KES">KES — Kenyan Shilling</option>
                    <option value="USD">USD — US Dollar</option>
                    <option value="GBP">GBP — British Pound</option>
                    <option value="EUR">EUR — Euro</option>
                    <option value="UGX">UGX — Ugandan Shilling</option>
                    <option value="TZS">TZS — Tanzanian Shilling</option>
                  </select>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Workshop Address (Shown on Receipts)</label>
              <input
                type="text"
                value={businessAddress}
                onChange={(e) => setBusinessAddress(e.target.value)}
                placeholder="Street, building, or city"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Receipt Footer Message</label>
              <input
                type="text"
                value={receiptFooter}
                onChange={(e) => setReceiptFooter(e.target.value)}
                placeholder="Thank you for choosing our tailoring workshop."
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
              />
            </div>

            <div className="pt-2 flex justify-end">
              <button
                type="submit"
                disabled={savingProfile}
                className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
              >
                <Save className="h-3.5 w-3.5" />
                {savingProfile ? 'Saving Changes...' : 'Save Profile & Workshop'}
              </button>
            </div>
          </form>
        </div>

        {/* Security & Password Change */}
        <div className="lg:col-span-5 space-y-6">
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3 mb-4">
              <Lock className="h-4 w-4 text-teal-700" />
              <h2 className="font-display text-sm font-semibold text-slate-900">Change Password</h2>
            </div>

            {passwordError && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700" role="alert">
                {passwordError}
              </div>
            )}
            {passwordSuccess && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3.5 py-2.5 text-xs text-teal-800">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{passwordSuccess}</span>
              </div>
            )}

            <form onSubmit={handlePasswordSave} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Current Password *</label>
                <div className="relative">
                  <input
                    type={showCurrentPwd ? 'text' : 'password'}
                    required
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 pr-10 py-2 text-sm focus:border-teal-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrentPwd((v) => !v)}
                    aria-label={showCurrentPwd ? 'Hide password' : 'Show password'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-800"
                  >
                    {showCurrentPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">New Password *</label>
                <div className="relative">
                  <input
                    type={showNewPwd ? 'text' : 'password'}
                    required
                    minLength={6}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Minimum 6 characters"
                    className="w-full rounded-lg border border-slate-300 px-3 pr-10 py-2 text-sm focus:border-teal-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPwd((v) => !v)}
                    aria-label={showNewPwd ? 'Hide password' : 'Show password'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-800"
                  >
                    {showNewPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Confirm New Password *</label>
                <div className="relative">
                  <input
                    type={showConfirmPwd ? 'text' : 'password'}
                    required
                    minLength={6}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 pr-10 py-2 text-sm focus:border-teal-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPwd((v) => !v)}
                    aria-label={showConfirmPwd ? 'Hide password' : 'Show password'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-800"
                  >
                    {showConfirmPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={savingPassword}
                className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              >
                {savingPassword ? 'Updating Password...' : 'Update Password'}
              </button>
            </form>
          </div>

          {/* About SmartTailoringSystem */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-3">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
              <Info className="h-4 w-4 text-teal-700" />
              <h2 className="font-display text-sm font-semibold text-slate-900">About SmartTailoringSystem</h2>
            </div>
            <div className="space-y-1.5 text-xs text-slate-600">
              <div className="flex justify-between">
                <span>Application Name</span>
                <strong className="text-slate-900">SmartTailoringSystem</strong>
              </div>
              <div className="flex justify-between">
                <span>{isMobile ? 'Android Edition Version' : 'Desktop Edition Version'}</span>
                <strong className="font-mono text-slate-900">v{appVersion}</strong>
              </div>
              <div className="flex justify-between">
                <span>Storage Engine</span>
                <strong className="text-teal-700">Local SQLite (100% Offline)</strong>
              </div>
            </div>
            <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs">
              <span className="text-slate-500">Optional online documentation &amp; support:</span>
              <button
                type="button"
                onClick={() => void handleOpenExternalLink('https://github.com/0705113739kj-star/SmartTailoringSystem')}
                className="inline-flex items-center gap-1 font-semibold text-teal-700 hover:text-teal-800"
              >
                Open Support Page
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Local Database Backup & Restore */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="flex items-start gap-2.5">
            <HardDrive className="h-5 w-5 text-teal-700 mt-0.5 shrink-0" />
            <div>
              <h2 className="font-display text-base font-bold text-slate-900">
                Database Backup &amp; Restore
              </h2>
              <p className="text-xs text-slate-500">
                All customers, measurements, orders, inventory, and payment records are saved locally on this{' '}
                {isMobile ? 'device' : 'PC'}. Export backups to a USB drive, external folder, or cloud folder for safekeeping.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={creatingBackup}
              onClick={() => void handleCreateBackup()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
            >
              <Download className="h-3.5 w-3.5" />
              {creatingBackup ? 'Creating Backup...' : 'Create Backup (.db)'}
            </button>
            <button
              type="button"
              disabled={validatingRestore || restoring}
              onClick={() => void handlePickRestoreFile()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60"
            >
              <Upload className="h-3.5 w-3.5" />
              {validatingRestore ? 'Validating File...' : 'Restore from Backup'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={isMobile ? '*/*' : '.db,.sqlite,.sqlite3'}
              className="hidden"
              onChange={(e) => void handleBrowserFileSelected(e)}
            />
          </div>
        </div>

        {backupError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700" role="alert">
            {backupError}
          </div>
        )}

        {loadingBackupStatus && !backupStatus ? (
          <p className="text-xs text-slate-500">Inspecting local SQLite database...</p>
        ) : backupStatus ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-1.5 md:col-span-2">
              <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                <Database className="h-3.5 w-3.5 text-teal-700" />
                <span>Persistent Local Database File</span>
              </div>
              <p className="font-mono text-[11px] text-slate-700 break-all">{backupStatus.dbPath}</p>
              <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-slate-600">
                <span>
                  Schema: <strong className="font-mono text-slate-900">v{backupStatus.schemaVersion}</strong>
                </span>
                <span>
                  Size: <strong className="font-mono text-slate-900">{formatBytes(backupStatus.fileSizeBytes)}</strong>
                </span>
                <span>
                  Customers: <strong className="font-mono text-slate-900">{backupStatus.counts.customers}</strong>
                </span>
                <span>
                  Orders: <strong className="font-mono text-slate-900">{backupStatus.counts.orders}</strong>
                </span>
                <span>
                  Payments: <strong className="font-mono text-slate-900">{backupStatus.counts.payments}</strong>
                </span>
                <span>
                  Materials: <strong className="font-mono text-slate-900">{backupStatus.counts.materials}</strong>
                </span>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2">
              <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                <ShieldCheck className="h-3.5 w-3.5 text-teal-700" />
                <span>Backup Schedule &amp; History</span>
              </div>
              <p className="text-slate-600">
                Last backup:{' '}
                <strong className="text-slate-900">
                  {backupStatus.lastBackupAt ? formatDate(backupStatus.lastBackupAt) : 'Not backed up yet'}
                </strong>
              </p>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Periodic Reminder Frequency
                </label>
                <select
                  value={backupStatus.reminderDays}
                  onChange={(e) => void handleReminderChange(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
                >
                  <option value={0}>Off (No reminders)</option>
                  <option value={7}>Every 7 days (Recommended)</option>
                  <option value={14}>Every 14 days</option>
                  <option value={30}>Every 30 days</option>
                </select>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Explicit Confirmation Modal before Database Restore */}
      {pendingRestore && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-lg bg-amber-50 text-amber-700 flex items-center justify-center shrink-0">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-display text-base font-bold text-slate-900">
                    Confirm Database Restore
                  </h3>
                  <p className="text-xs text-slate-600 mt-0.5">
                    This action will overwrite your active SmartTailoringSystem database with the selected backup file.
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={restoring}
                onClick={() => setPendingRestore(null)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs space-y-2">
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Selected Backup File</span>
                <strong className="font-mono text-slate-900 truncate max-w-xs">{pendingRestore.fileName}</strong>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Validation Status</span>
                <strong className="text-teal-700">Verified SQLite Integrity &amp; Schema v{pendingRestore.summary.schemaVersion}</strong>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-slate-200">
                <div>
                  <span className="text-slate-500 block">Customers</span>
                  <strong className="font-mono text-slate-900">{pendingRestore.summary.customers}</strong>
                </div>
                <div>
                  <span className="text-slate-500 block">Orders</span>
                  <strong className="font-mono text-slate-900">{pendingRestore.summary.orders}</strong>
                </div>
                <div>
                  <span className="text-slate-500 block">Payments</span>
                  <strong className="font-mono text-slate-900">{pendingRestore.summary.payments}</strong>
                </div>
                <div>
                  <span className="text-slate-500 block">Materials</span>
                  <strong className="font-mono text-slate-900">{pendingRestore.summary.materials}</strong>
                </div>
              </div>
            </div>

            <p className="text-xs text-slate-600">
              For safety, SmartTailoringSystem will automatically save a pre-restore snapshot of your current database
              before replacing it.
            </p>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={restoring}
                onClick={() => setPendingRestore(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={restoring}
                onClick={() => void handleConfirmRestore()}
                className="rounded-lg bg-amber-700 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-800 disabled:opacity-60"
              >
                {restoring ? 'Restoring Database...' : 'Replace Active Database & Restore'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
