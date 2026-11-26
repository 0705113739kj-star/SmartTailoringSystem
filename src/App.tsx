import React, { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  Boxes,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Database,
  ExternalLink,
  HardDrive,
  LayoutDashboard,
  LogOut,
  Menu,
  Ruler,
  Scissors,
  Settings,
  Sparkles,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { AuthViews } from './components/AuthViews';
import { BrandLogo } from './components/BrandLogo';
import { useOnlineStatus } from './hooks/usePWA';
import { ApiError, apiRequest, clearAuthTokens, isMobileNative, setAuthTokens } from './lib/api';
import { isEmbeddedIframe } from './lib/print';
import { CustomersView } from './modules/CustomersView';
import { DashboardView } from './modules/DashboardView';
import { FabricEstimationView } from './modules/FabricEstimationView';
import { InventoryView } from './modules/InventoryView';
import { MeasurementsView } from './modules/MeasurementsView';
import { OrdersView } from './modules/OrdersView';
import { PosPaymentsView } from './modules/PosPaymentsView';
import { ReportsView } from './modules/ReportsView';
import { SettingsView } from './modules/SettingsView';
import type { AuthUser, BackupStatus, ModuleKey, WorkspaceData } from './types';

const NAV_ITEMS: Array<{
  key: ModuleKey;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'customers', label: 'Customers', icon: Users },
  { key: 'measurements', label: 'Measurements', icon: Ruler },
  { key: 'orders', label: 'Tailoring Orders', icon: Scissors },
  { key: 'estimation', label: 'Fabric Estimation', icon: Sparkles },
  { key: 'inventory', label: 'Inventory Management', icon: Boxes },
  { key: 'pos', label: 'POS and Payments', icon: CreditCard },
  { key: 'reports', label: 'Reports', icon: BarChart3 },
];

const EMPTY_WORKSPACE: WorkspaceData = {
  syncedAt: '',
  customers: [],
  measurements: [],
  measurementHistory: [],
  orders: [],
  estimationRules: [],
  estimations: [],
  materials: [],
  usageRecords: [],
  inventoryTransactions: [],
  payments: [],
  expenses: [],
};

export default function App() {
  const isOnline = useOnlineStatus();
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceData>(EMPTY_WORKSPACE);
  const [backupReminderDue, setBackupReminderDue] = useState(false);
  const [backupReminderDismissed, setBackupReminderDismissed] = useState(false);
  const [activeModule, setActiveModule] = useState<ModuleKey>('dashboard');
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [selectedPosOrderId, setSelectedPosOrderId] = useState<number | null>(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  const notify = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const checkBackupReminder = useCallback(async () => {
    try {
      const status = await apiRequest<BackupStatus>('/api/backup/status');
      setBackupReminderDue(Boolean(status.reminderDue));
    } catch {
      // ignore non-critical backup status check failure
    }
  }, []);

  const refreshWorkspace = useCallback(
    async (currentUser?: AuthUser) => {
      const u = currentUser || user;
      if (!u) return;
      try {
        const data = await apiRequest<WorkspaceData>('/api/bootstrap');
        setWorkspace(data);
        void checkBackupReminder();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearAuthTokens();
          setUser(null);
          setWorkspace(EMPTY_WORKSPACE);
          notify('Your session expired. Please sign in again.', 'error');
        } else {
          notify(
            err instanceof Error ? err.message : 'Unable to reload local workshop records.',
            'error'
          );
        }
      }
    },
    [user, notify, checkBackupReminder]
  );

  // Initial session bootstrap directly against the local SQLite backend (works 100% offline)
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = await apiRequest<{ user: AuthUser }>('/api/auth/me');
        if (!active) return;
        setAuthTokens({
          csrfToken: me.user.csrfToken,
          sessionToken: me.user.sessionToken,
        });
        setUser(me.user);
        await refreshWorkspace(me.user);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearAuthTokens();
        }
      } finally {
        if (active) setBooting(false);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAuthenticated = async (authedUser: AuthUser) => {
    setAuthTokens({
      csrfToken: authedUser.csrfToken,
      sessionToken: authedUser.sessionToken,
    });
    setUser(authedUser);
    await refreshWorkspace(authedUser);
    setActiveModule('dashboard');
  };

  const handleLogout = async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {
      // continue clearing local session
    }
    clearAuthTokens();
    setUser(null);
    setWorkspace(EMPTY_WORKSPACE);
    setBackupReminderDue(false);
  };

  // Handle Android hardware Back button cleanly via @capacitor/app
  useEffect(() => {
    if (!isMobileNative()) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      try {
        const { App: CapApp } = await import('@capacitor/app');
        if (cancelled) return;
        const handle = await CapApp.addListener('backButton', () => {
          if (mobileNavOpen) {
            setMobileNavOpen(false);
            return;
          }
          if (user && activeModule !== 'dashboard') {
            setActiveModule('dashboard');
            setSelectedOrderId(null);
            setSelectedPosOrderId(null);
            return;
          }
          void CapApp.exitApp();
        });
        if (cancelled) {
          void handle.remove();
        } else {
          cleanup = () => {
            void handle.remove();
          };
        }
      } catch {
        // Ignore if plugin unavailable
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [mobileNavOpen, user, activeModule]);

  if (booting) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center space-y-3">
          <div className="h-9 w-9 border-2 border-teal-700 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs font-medium text-slate-500">Loading SmartTailoringSystem...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthViews onAuthenticated={handleAuthenticated} />;
  }

  const currentNav =
    activeModule === 'settings'
      ? { key: 'settings' as const, label: 'Account & Settings' }
      : NAV_ITEMS.find((n) => n.key === activeModule) || NAV_ITEMS[0];

  const isElectron =
    typeof window !== 'undefined' && Boolean(window.smartTailoringDesktop?.isElectron);

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      {/* Mobile Sidebar Overlay */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/50 lg:hidden no-print"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      {/* Collapsible Sidebar */}
      <aside
        className={`no-print fixed lg:sticky top-0 left-0 z-50 h-screen bg-slate-900 text-slate-100 flex flex-col transition-all duration-200 shrink-0 ${
          sidebarCollapsed ? 'lg:w-[72px]' : 'lg:w-64'
        } ${mobileNavOpen ? 'w-64 translate-x-0' : '-translate-x-full lg:translate-x-0'}`}
      >
        <div className="h-16 px-4 flex items-center justify-between border-b border-slate-800">
          <BrandLogo dark collapsed={sidebarCollapsed} />
          <button
            type="button"
            onClick={() => setSidebarCollapsed((c) => !c)}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="hidden lg:inline-flex p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            className="lg:hidden p-1.5 text-slate-400 hover:text-white"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-4 px-2.5 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeModule === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  setActiveModule(item.key);
                  if (item.key !== 'orders') setSelectedOrderId(null);
                  if (item.key !== 'pos') setSelectedPosOrderId(null);
                  setMobileNavOpen(false);
                }}
                title={sidebarCollapsed ? item.label : undefined}
                className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-teal-700 text-white'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-800 space-y-2">
          {!sidebarCollapsed && (
            <div className="px-2">
              <p className="text-xs font-semibold text-white truncate">{user.businessName}</p>
              <p className="text-[11px] text-slate-400 truncate">
                {user.fullName}
                {user.username ? ` · @${user.username}` : ''}
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              setActiveModule('settings');
              setMobileNavOpen(false);
            }}
            title={sidebarCollapsed ? 'Settings' : undefined}
            className={`w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
              activeModule === 'settings'
                ? 'bg-teal-700 text-white'
                : 'border border-slate-700 text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Settings className="h-3.5 w-3.5 shrink-0" />
            {!sidebarCollapsed && <span>Settings</span>}
          </button>
          <button
            type="button"
            onClick={handleLogout}
            title={sidebarCollapsed ? 'Sign Out' : undefined}
            className="w-full flex items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <LogOut className="h-3.5 w-3.5 shrink-0" />
            {!sidebarCollapsed && <span>Sign Out</span>}
          </button>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Navigation Bar */}
        <header className="no-print sticky top-0 z-30 h-16 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden p-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
              aria-label="Open navigation menu"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <p className="text-xs text-slate-500 truncate">{user.businessName}</p>
              <p className="font-display text-sm font-bold text-slate-900 truncate">{currentNav.label}</p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <div
              className="inline-flex items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50 px-2.5 py-1.5 text-xs font-medium text-teal-900 whitespace-nowrap"
              title="All POS operations run locally against your device SQLite database"
            >
              <Database className="h-3.5 w-3.5 text-teal-700" />
              <span className="hidden sm:inline">Local Database</span>
            </div>

            <div
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 whitespace-nowrap"
              title={
                isOnline
                  ? 'Internet access available for optional external links'
                  : 'Operating fully offline with local storage'
              }
            >
              {isOnline ? (
                <>
                  <Wifi className="h-3.5 w-3.5 text-teal-700" />
                  <span className="hidden md:inline">Internet Ready</span>
                </>
              ) : (
                <>
                  <WifiOff className="h-3.5 w-3.5 text-slate-500" />
                  <span className="hidden md:inline">Offline Mode</span>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => setActiveModule('settings')}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                activeModule === 'settings'
                  ? 'border-teal-700 bg-teal-50 text-teal-900'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
              title="Account, Workshop & Database Backup Settings"
            >
              <Settings className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Settings</span>
            </button>

            {!isElectron && isEmbeddedIframe() && (
              <a
                href={typeof window !== 'undefined' ? window.location.href : '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                title="Open in a full browser tab to enable native printing & Desktop File Explorer"
              >
                <ExternalLink className="h-3.5 w-3.5 text-teal-700" />
                <span className="hidden md:inline">Open Full Tab</span>
              </a>
            )}
          </div>
        </header>

        {/* Optional Local Backup Reminder Banner */}
        {backupReminderDue && !backupReminderDismissed && activeModule !== 'settings' && (
          <div className="no-print bg-amber-50 border-b border-amber-200 px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-900">
            <span className="inline-flex items-center gap-2">
              <HardDrive className="h-3.5 w-3.5 text-amber-700 shrink-0" />
              <span>
                Periodic backup reminder: Create a local backup of your SmartTailoringSystem database to protect customer and order records.
              </span>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveModule('settings')}
                className="rounded border border-amber-300 bg-white px-2.5 py-1 font-semibold text-amber-900 hover:bg-amber-100"
              >
                Backup Now
              </button>
              <button
                type="button"
                onClick={() => setBackupReminderDismissed(true)}
                className="text-amber-700 hover:text-amber-900 p-1"
                aria-label="Dismiss backup reminder"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Notification Banner */}
        {toast && (
          <div className="no-print fixed bottom-5 right-5 z-50 max-w-sm">
            <div
              className={`rounded-xl border px-4 py-3 shadow-lg text-xs font-medium flex items-start gap-2.5 ${
                toast.type === 'error'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : 'border-teal-200 bg-white text-slate-900'
              }`}
              role="status"
            >
              <CheckCircle2
                className={`h-4 w-4 mt-0.5 shrink-0 ${
                  toast.type === 'error' ? 'text-red-600' : 'text-teal-700'
                }`}
              />
              <span className="flex-1">{toast.msg}</span>
              <button type="button" onClick={() => setToast(null)} className="text-slate-400 hover:text-slate-700">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Active Module Viewport */}
        <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto">
          {activeModule === 'dashboard' && (
            <DashboardView
              data={workspace}
              currency={user.currency}
              onNavigate={(m) => setActiveModule(m)}
              onSelectOrder={(oid) => {
                setSelectedOrderId(oid);
                setActiveModule('orders');
              }}
            />
          )}
          {activeModule === 'customers' && (
            <CustomersView
              data={workspace}
              currency={user.currency}
              onRefresh={() => refreshWorkspace(user)}
              onNotify={notify}
            />
          )}
          {activeModule === 'measurements' && (
            <MeasurementsView
              data={workspace}
              onRefresh={() => refreshWorkspace(user)}
              onNotify={notify}
            />
          )}
          {activeModule === 'orders' && (
            <OrdersView
              businessName={user.businessName}
              data={workspace}
              initialOrderId={selectedOrderId}
              onRefresh={() => refreshWorkspace(user)}
              onOpenInPos={(oid) => {
                setSelectedPosOrderId(oid);
                setActiveModule('pos');
              }}
              onNotify={notify}
            />
          )}
          {activeModule === 'estimation' && (
            <FabricEstimationView
              data={workspace}
              currency={user.currency}
              onRefresh={() => refreshWorkspace(user)}
              onNotify={notify}
            />
          )}
          {activeModule === 'inventory' && (
            <InventoryView
              data={workspace}
              currency={user.currency}
              onRefresh={() => refreshWorkspace(user)}
              onNotify={notify}
            />
          )}
          {activeModule === 'pos' && (
            <PosPaymentsView
              businessName={user.businessName}
              businessPhone={user.phone}
              businessAddress={user.businessAddress}
              receiptFooter={user.receiptFooter}
              data={workspace}
              currency={user.currency}
              initialOrderId={selectedPosOrderId}
              onRefresh={() => refreshWorkspace(user)}
              onNotify={notify}
            />
          )}
          {activeModule === 'reports' && (
            <ReportsView
              businessName={user.businessName}
              data={workspace}
              currency={user.currency}
              onRefresh={() => refreshWorkspace(user)}
              onNotify={notify}
            />
          )}
          {activeModule === 'settings' && (
            <SettingsView
              user={user}
              onUserUpdated={async (updatedUser) => {
                setUser(updatedUser);
              }}
              onDatabaseRestored={async () => {
                try {
                  const me = await apiRequest<{ user: AuthUser }>('/api/auth/me');
                  setAuthTokens({
                    csrfToken: me.user.csrfToken,
                    sessionToken: me.user.sessionToken,
                  });
                  setUser(me.user);
                  await refreshWorkspace(me.user);
                } catch {
                  clearAuthTokens();
                  setUser(null);
                  setWorkspace(EMPTY_WORKSPACE);
                  notify('Database restored. Please sign in to the restored workshop account.', 'success');
                }
              }}
              onNotify={notify}
            />
          )}
        </main>
      </div>
    </div>
  );
}
