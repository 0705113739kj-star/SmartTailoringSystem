import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CreditCard,
  Plus,
  Ruler,
  Scissors,
  Users,
} from 'lucide-react';
import { MonthlyPerformanceChart, OrderStatusChart, SalesPerformanceChart } from '../components/Charts';
import { formatDate, formatMoney } from '../lib/api';
import type { ModuleKey, WorkspaceData } from '../types';

interface DashboardViewProps {
  data: WorkspaceData;
  currency: string;
  onNavigate: (mod: ModuleKey) => void;
  onSelectOrder?: (orderId: number) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  data,
  currency,
  onNavigate,
  onSelectOrder,
}) => {
  const today = new Date().toISOString().slice(0, 10);
  const activeOrders = data.orders.filter((o) => o.status !== 'Cancelled');
  const totalSales = activeOrders.reduce((s, o) => s + Number(o.agreed_price || 0), 0);
  const outstandingBalances = activeOrders.reduce(
    (s, o) => s + Math.max(0, Number(o.agreed_price || 0) - Number(o.total_paid || 0)),
    0
  );

  const statusCounts: Record<string, number> = {
    Pending: 0,
    'In Progress': 0,
    Completed: 0,
    'Ready for Collection': 0,
    Collected: 0,
    Cancelled: 0,
  };
  for (const o of data.orders) {
    statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
  }

  const lowStockMaterials = data.materials.filter(
    (m) => Number(m.current_qty) <= Number(m.min_stock_level)
  );
  const upcomingDeadlines = data.orders
    .filter((o) => ['Pending', 'In Progress'].includes(o.status) && o.expected_completion_date >= today)
    .sort((a, b) => a.expected_completion_date.localeCompare(b.expected_completion_date))
    .slice(0, 5);

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
  for (const p of data.payments) {
    if (p.status !== 'Completed') continue;
    const m = (p.paid_at || '').slice(0, 7);
    if (monthBuckets[m]) {
      monthBuckets[m].collections += Number(p.amount || 0);
    }
  }
  const monthlySeries = Object.values(monthBuckets);

  return (
    <div className="space-y-6">

      {/* Quick Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900">Workshop Overview</h1>
          <p className="text-sm text-slate-500">Live business metrics, production queues, and financial summary.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onNavigate('customers')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
          >
            <Users className="h-3.5 w-3.5 text-teal-700" />
            New Customer
          </button>
          <button
            type="button"
            onClick={() => onNavigate('measurements')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
          >
            <Ruler className="h-3.5 w-3.5 text-teal-700" />
            Record Measurements
          </button>
          <button
            type="button"
            onClick={() => onNavigate('orders')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-teal-800 whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5" />
            Create Tailoring Order
          </button>
          <button
            type="button"
            onClick={() => onNavigate('pos')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap"
          >
            <CreditCard className="h-3.5 w-3.5" />
            Receive Payment
          </button>
        </div>
      </div>

      {/* KPI Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Total Customers</p>
          <p className="mt-1 font-mono text-2xl font-bold text-slate-900 tabular-nums">{data.customers.length}</p>
          <p className="mt-1 text-xs text-slate-500">Registered profiles</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Total Tailoring Orders</p>
          <p className="mt-1 font-mono text-2xl font-bold text-slate-900 tabular-nums">{data.orders.length}</p>
          <p className="mt-1 text-xs text-slate-500">
            {statusCounts.Pending} pending · {statusCounts['In Progress']} in progress
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Total Sales Value</p>
          <p className="mt-1 font-mono text-2xl font-bold text-teal-700 tabular-nums">{formatMoney(totalSales, currency)}</p>
          <p className="mt-1 text-xs text-slate-500">Agreed order value (excl. cancelled)</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Outstanding Balances</p>
          <p className="mt-1 font-mono text-2xl font-bold text-amber-700 tabular-nums">
            {formatMoney(outstandingBalances, currency)}
          </p>
          <p className="mt-1 text-xs text-slate-500">Due across active orders</p>
        </div>
      </div>

      {/* Order Status Breakdown Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Pending Orders', value: statusCounts.Pending, tone: 'text-amber-700' },
          { label: 'In Progress', value: statusCounts['In Progress'], tone: 'text-sky-700' },
          { label: 'Completed', value: statusCounts.Completed, tone: 'text-teal-700' },
          { label: 'Ready for Collection', value: statusCounts['Ready for Collection'], tone: 'text-emerald-700' },
          { label: 'Low-Stock Materials', value: lowStockMaterials.length, tone: lowStockMaterials.length > 0 ? 'text-red-600' : 'text-slate-700' },
        ].map((item) => (
          <div key={item.label} className="rounded-xl border border-slate-200 bg-white px-4 py-3 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-600">{item.label}</span>
            <span className={`font-mono text-lg font-bold tabular-nums ${item.tone}`}>{item.value}</span>
          </div>
        ))}
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-display text-sm font-semibold text-slate-900">Sales & Collections Performance</h2>
          <p className="text-xs text-slate-500 mb-4">Monthly order sales value vs. payments collected</p>
          <div className="h-60">
            <SalesPerformanceChart data={monthlySeries} currency={currency} />
          </div>
        </div>
        <div className="lg:col-span-3 rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-display text-sm font-semibold text-slate-900">Order Statistics</h2>
          <p className="text-xs text-slate-500 mb-4">Distribution by workflow status</p>
          <div className="h-60">
            <OrderStatusChart statusCounts={statusCounts} />
          </div>
        </div>
        <div className="lg:col-span-4 rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-display text-sm font-semibold text-slate-900">Monthly Order Volume</h2>
          <p className="text-xs text-slate-500 mb-4">Orders created over the past 6 months</p>
          <div className="h-60">
            <MonthlyPerformanceChart data={monthlySeries} />
          </div>
        </div>
      </div>

      {/* Operational Lists */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Recent Orders */}
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-sm font-semibold text-slate-900">Recent Orders</h2>
            <button
              type="button"
              onClick={() => onNavigate('orders')}
              className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline"
            >
              View all <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          {data.orders.length === 0 ? (
            <div className="py-8 text-center">
              <Scissors className="h-6 w-6 text-slate-300 mx-auto mb-2" />
              <p className="text-xs text-slate-500">No tailoring orders created yet.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {data.orders.slice(0, 5).map((o) => (
                <div
                  key={o.id}
                  onClick={() => {
                    if (onSelectOrder) onSelectOrder(o.id);
                    else onNavigate('orders');
                  }}
                  className="py-2.5 flex items-center justify-between cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded-lg"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-900 truncate">
                      <span className="font-mono">{o.order_number}</span> · {o.customer_name}
                    </p>
                    <p className="text-xs text-slate-500 truncate">
                      {o.garment_type} · {o.status}
                    </p>
                  </div>
                  <span className="font-mono text-xs font-semibold text-slate-800 tabular-nums shrink-0 ml-2">
                    {formatMoney(o.agreed_price, currency)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Payments */}
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-sm font-semibold text-slate-900">Recent Payments</h2>
            <button
              type="button"
              onClick={() => onNavigate('pos')}
              className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline"
            >
              Open POS <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          {data.payments.length === 0 ? (
            <div className="py-8 text-center">
              <CreditCard className="h-6 w-6 text-slate-300 mx-auto mb-2" />
              <p className="text-xs text-slate-500">No payments recorded yet.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {data.payments.slice(0, 5).map((p) => (
                <div key={p.id} className="py-2.5 flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-900 truncate">
                      <span className="font-mono">{p.receipt_number}</span> · {p.customer_name}
                    </p>
                    <p className="text-xs text-slate-500 truncate">
                      {p.payment_method} · {p.payment_type} · {p.status}
                    </p>
                  </div>
                  <span className="font-mono text-xs font-semibold text-teal-700 tabular-nums shrink-0 ml-2">
                    {formatMoney(p.amount, currency)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Upcoming Deadlines & Low Stock */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-5">
          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-display text-sm font-semibold text-slate-900">Upcoming Deadlines</h2>
            </div>
            {upcomingDeadlines.length === 0 ? (
              <p className="text-xs text-slate-500 py-2">No upcoming pending deadlines.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {upcomingDeadlines.map((o) => (
                  <div key={o.id} className="py-2 flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-900 truncate">
                        <span className="font-mono">{o.order_number}</span> · {o.garment_type}
                      </p>
                      <p className="text-xs text-slate-500 truncate">{o.customer_name}</p>
                    </div>
                    <span className="font-mono text-xs text-amber-700 shrink-0 ml-2">
                      {formatDate(o.expected_completion_date)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-slate-100">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-display text-sm font-semibold text-slate-900 flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                Low-Stock Materials
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('inventory')}
                className="text-xs font-medium text-teal-700 hover:underline"
              >
                Restock
              </button>
            </div>
            {lowStockMaterials.length === 0 ? (
              <p className="text-xs text-slate-500">All inventory materials are above minimum levels.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {lowStockMaterials.slice(0, 4).map((m) => (
                  <div key={m.id} className="py-1.5 flex items-center justify-between">
                    <span className="text-xs text-slate-700 truncate">{m.name}</span>
                    <span className="font-mono text-xs font-semibold text-red-600 tabular-nums shrink-0 ml-2">
                      {m.current_qty} / {m.min_stock_level} {m.unit}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
