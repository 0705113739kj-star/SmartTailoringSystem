import React, { useMemo, useRef, useState } from 'react';
import { AlertCircle, Download, FileDown, Plus, Printer } from 'lucide-react';
import { PrintDocumentModal, type PrintableDocumentPayload } from '../components/PrintDocumentModal';
import { apiRequest, formatDate, formatMoney } from '../lib/api';
import {
  escapeHtml,
  extractReportSpecFromDom,
  isEmbeddedIframe,
  printHtmlDocument,
  savePdfToDesktop,
} from '../lib/print';
import type { WorkspaceData } from '../types';

type ReportTab =
  | 'sales'
  | 'customers'
  | 'orders'
  | 'completion'
  | 'outstanding'
  | 'inventory'
  | 'consumption'
  | 'wastage'
  | 'est_vs_actual'
  | 'profitability';

interface ReportsViewProps {
  businessName: string;
  data: WorkspaceData;
  currency: string;
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const ReportsView: React.FC<ReportsViewProps> = ({
  businessName,
  data,
  currency,
  onRefresh,
  onNotify,
}) => {
  const [tab, setTab] = useState<ReportTab>('sales');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const reportContentRef = useRef<HTMLDivElement>(null);
  const [printPreviewDoc, setPrintPreviewDoc] = useState<PrintableDocumentPayload | null>(null);

  // Business expense form
  const [expCategory, setExpCategory] = useState('Workshop Rent');
  const [expDesc, setExpDesc] = useState('');
  const [expAmount, setExpAmount] = useState('');
  const [expDate, setExpDate] = useState(new Date().toISOString().slice(0, 10));

  const inRange = (d: string) => {
    const day = (d || '').slice(0, 10);
    if (startDate && day < startDate) return false;
    if (endDate && day > endDate) return false;
    return true;
  };

  const reportData = useMemo(() => {
    const orders = data.orders.filter((o) => {
      if (!inRange(o.order_date)) return false;
      if (categoryFilter !== 'All' && o.garment_type !== categoryFilter) return false;
      return true;
    });
    const activeOrders = orders.filter((o) => o.status !== 'Cancelled');

    const paidByOrder: Record<number, number> = {};
    for (const p of data.payments) {
      if (p.status === 'Completed') {
        paidByOrder[p.order_id] = (paidByOrder[p.order_id] || 0) + Number(p.amount || 0);
      }
    }

    const actualCostByOrder: Record<number, number> = {};
    for (const u of data.usageRecords) {
      actualCostByOrder[u.order_id] = (actualCostByOrder[u.order_id] || 0) + Number(u.actual_cost || 0);
    }

    const latestEstByOrder: Record<number, number> = {};
    for (const e of data.estimations) {
      if (latestEstByOrder[e.order_id] === undefined) {
        latestEstByOrder[e.order_id] = Number(e.total_estimated_cost || 0);
      }
    }

    const filteredPayments = data.payments.filter((p) => p.status === 'Completed' && inRange(p.paid_at));
    const filteredUsage = data.usageRecords.filter((u) => inRange(u.recorded_at));
    const filteredExpenses = data.expenses.filter((e) => inRange(e.expense_date));

    const totalSalesRevenue = activeOrders.reduce((s, o) => s + Number(o.agreed_price || 0), 0);
    const totalPaymentsReceived = filteredPayments.reduce((s, p) => s + Number(p.amount || 0), 0);
    const outstandingOrders = activeOrders
      .map((o) => ({
        ...o,
        paid: paidByOrder[o.id] || 0,
        balance: Math.max(0, Number(o.agreed_price) - (paidByOrder[o.id] || 0)),
      }))
      .filter((o) => o.balance > 0.01);

    const totalActualMaterials = activeOrders.reduce((s, o) => s + (actualCostByOrder[o.id] || 0), 0);
    const totalLabour = activeOrders.reduce((s, o) => s + Number(o.labour_cost || 0), 0);
    const totalOrderOther = activeOrders.reduce((s, o) => s + Number(o.other_expenses || 0), 0);
    const totalOperatingExpenses = filteredExpenses.reduce((s, e) => s + Number(e.amount || 0), 0);

    const ordersWithActualMaterials = activeOrders.filter((o) =>
      data.usageRecords.some((u) => u.order_id === o.id && (u.consumed_qty > 0 || u.wasted_qty > 0))
    ).length;

    return {
      orders,
      activeOrders,
      paidByOrder,
      actualCostByOrder,
      latestEstByOrder,
      filteredUsage,
      filteredExpenses,
      outstandingOrders,
      totalSalesRevenue,
      totalPaymentsReceived,
      totalOutstanding: outstandingOrders.reduce((s, o) => s + o.balance, 0),
      totalActualMaterials,
      totalLabour,
      totalOrderOther,
      totalOperatingExpenses,
      netProfit:
        totalSalesRevenue - totalActualMaterials - totalLabour - totalOrderOther - totalOperatingExpenses,
      ordersWithActualMaterials,
      hasIncompleteCosts: ordersWithActualMaterials < activeOrders.length,
    };
  }, [data, startDate, endDate, categoryFilter]);

  const exportCsv = () => {
    let headers: string[] = [];
    let rows: Array<Array<string | number>> = [];

    if (tab === 'sales' || tab === 'orders' || tab === 'outstanding') {
      const list = tab === 'outstanding' ? reportData.outstandingOrders : reportData.orders;
      headers = ['Order No', 'Customer', 'Garment', 'Order Date', 'Status', 'Agreed Price', 'Paid', 'Balance'];
      rows = list.map((o) => {
        const paid = reportData.paidByOrder[o.id] || 0;
        return [
          o.order_number,
          o.customer_name || '',
          o.garment_type,
          o.order_date,
          o.status,
          o.agreed_price,
          paid,
          Math.max(0, o.agreed_price - paid),
        ];
      });
    } else if (tab === 'inventory') {
      headers = ['SKU', 'Name', 'Category', 'Available Qty', 'Reserved Qty', 'Unit', 'Unit Cost', 'Stock Value'];
      rows = data.materials.map((m) => [
        m.sku,
        m.name,
        m.category,
        m.current_qty,
        m.reserved_qty,
        m.unit,
        m.purchase_price,
        Math.round(m.current_qty * m.purchase_price * 100) / 100,
      ]);
    } else if (tab === 'consumption' || tab === 'wastage') {
      const list =
        tab === 'wastage'
          ? reportData.filteredUsage.filter((u) => u.wasted_qty > 0)
          : reportData.filteredUsage;
      headers = ['Order', 'Material', 'Issued', 'Consumed', 'Returned', 'Wasted', 'Actual Cost', 'Date'];
      rows = list.map((u) => [
        u.order_number || '',
        u.material_name || '',
        u.issued_qty,
        u.consumed_qty,
        u.returned_qty,
        u.wasted_qty,
        u.actual_cost,
        u.recorded_at.slice(0, 10),
      ]);
    } else if (tab === 'est_vs_actual') {
      headers = ['Order', 'Customer', 'Garment', 'Estimated Material Cost', 'Actual Material Cost', 'Variance'];
      rows = reportData.activeOrders.map((o) => {
        const est = reportData.latestEstByOrder[o.id];
        const act = reportData.actualCostByOrder[o.id] ?? 0;
        return [o.order_number, o.customer_name || '', o.garment_type, est ?? '', act, est !== undefined ? act - Number(est) : ''];
      });
    } else {
      headers = ['Metric', 'Value'];
      rows = [
        ['Sales Revenue', reportData.totalSalesRevenue],
        ['Actual Material Consumption Cost', reportData.totalActualMaterials],
        ['Recorded Labour Cost', reportData.totalLabour],
        ['Order Other Expenses', reportData.totalOrderOther],
        ['Operating Expenses', reportData.totalOperatingExpenses],
        ['Net Recorded Profit', reportData.netProfit],
      ];
    }

    const csv = [headers, ...rows]
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smarttailoringsystem-${tab}-report.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest('/api/expenses', {
        method: 'POST',
        body: JSON.stringify({
          category: expCategory,
          description: expDesc,
          amount: Number(expAmount),
          expenseDate: expDate,
        }),
      });
      await onRefresh();
      setExpDesc('');
      setExpAmount('');
      onNotify('Business expense recorded.', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save expense.', 'error');
    }
  };

  const tabs: Array<{ id: ReportTab; label: string }> = [
    { id: 'sales', label: 'Sales' },
    { id: 'customers', label: 'Customers' },
    { id: 'orders', label: 'Tailoring Orders' },
    { id: 'completion', label: 'Order Completion' },
    { id: 'outstanding', label: 'Outstanding Balances' },
    { id: 'inventory', label: 'Inventory' },
    { id: 'consumption', label: 'Material Consumption' },
    { id: 'wastage', label: 'Material Wastage' },
    { id: 'est_vs_actual', label: 'Estimated vs Actual' },
    { id: 'profitability', label: 'Profitability' },
  ];

  const buildPrintableReportHtml = () => {
    const activeTabLabel = tabs.find((t) => t.id === tab)?.label || 'Report';
    const filterSummary = [
      startDate ? `From: ${startDate}` : null,
      endDate ? `To: ${endDate}` : null,
      categoryFilter !== 'All' ? `Category: ${categoryFilter}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'All dates · All categories';

    const clone = reportContentRef.current?.cloneNode(true) as HTMLElement | null;
    if (clone) {
      clone.querySelectorAll('.no-print').forEach((el) => el.remove());
      clone.querySelectorAll('table').forEach((tbl) => tbl.classList.add('tp-table'));
    }
    const inner = clone ? clone.innerHTML : '<p>No report data.</p>';

    return `
      <div class="tp-doc">
        <div class="tp-header">
          <h1 class="tp-title">${escapeHtml(businessName)} — ${escapeHtml(activeTabLabel)} Report</h1>
          <p class="tp-subtitle">${escapeHtml(filterSummary)}</p>
          <p class="tp-meta">Generated on ${escapeHtml(new Date().toLocaleString())}</p>
        </div>
        <style>
          #tailorpos-print-root .grid, .tp-doc .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
          #tailorpos-print-root .rounded-lg, .tp-doc .rounded-lg { border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px; }
          #tailorpos-print-root .text-xs, .tp-doc .text-xs { font-size: 11px; }
          #tailorpos-print-root .text-lg, .tp-doc .text-lg { font-size: 15px; font-weight: 700; }
          #tailorpos-print-root .text-2xl, .tp-doc .text-2xl { font-size: 18px; font-weight: 700; }
          #tailorpos-print-root .text-right, .tp-doc .text-right { text-align: right; }
          #tailorpos-print-root .font-mono, .tp-doc .font-mono { font-family: ui-monospace, SFMono-Regular, monospace; }
        </style>
        ${inner}
      </div>
    `;
  };

  const buildReportPdfSpec = () => {
    const activeTabLabel = tabs.find((t) => t.id === tab)?.label || 'Report';
    const filterSummary =
      [
        startDate ? `From: ${startDate}` : null,
        endDate ? `To: ${endDate}` : null,
        categoryFilter !== 'All' ? `Category: ${categoryFilter}` : null,
      ]
        .filter(Boolean)
        .join(' · ') || 'All dates · All categories';

    return extractReportSpecFromDom(reportContentRef.current, {
      title: `${businessName} — ${activeTabLabel} Report`,
      subtitle: filterSummary,
      meta: `Generated on ${new Date().toLocaleString()}`,
    });
  };

  const handlePrintReport = () => {
    const activeTabLabel = tabs.find((t) => t.id === tab)?.label || 'Report';
    const title = `${businessName} - ${activeTabLabel} Report`;
    const htmlBody = buildPrintableReportHtml();
    if (isEmbeddedIframe()) {
      setPrintPreviewDoc({
        title,
        filenameBase: `smarttailoringsystem-${tab}-report`,
        htmlBody,
        pdfSpec: buildReportPdfSpec(),
      });
      return;
    }
    printHtmlDocument({ title, htmlBody });
  };

  const handleSavePdfReport = async () => {
    const activeTabLabel = tabs.find((t) => t.id === tab)?.label || 'Report';
    try {
      const res = await savePdfToDesktop(
        buildReportPdfSpec(),
        `smarttailoringsystem-${tab}-report.pdf`
      );
      if (res.cancelled) return;
      onNotify(
        res.method === 'picker'
          ? `Saved ${activeTabLabel} report PDF to your selected location.`
          : res.reason === 'iframe_blocked'
          ? `Downloaded smarttailoringsystem-${tab}-report.pdf (preview frame blocks Desktop File Explorer — click "Open Full Tab" in top bar to choose a folder).`
          : `Downloaded smarttailoringsystem-${tab}-report.pdf to your computer.`,
        'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to export report PDF.', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 no-print">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900">Business Reports</h1>
          <p className="text-sm text-slate-500">
            Financial, production, inventory consumption, and profitability analytics.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => void handleSavePdfReport()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <FileDown className="h-3.5 w-3.5" />
            Save PDF to Desktop
          </button>
          <button
            type="button"
            onClick={handlePrintReport}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800"
          >
            <Printer className="h-3.5 w-3.5" />
            Print Report
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-wrap items-end gap-3 no-print">
        <div>
          <label className="block text-[11px] font-medium text-slate-500 mb-1">From Date</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono" />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-slate-500 mb-1">To Date</label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono" />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-slate-500 mb-1">Garment Category</label>
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs">
            <option value="All">All Garments</option>
            {['Suit', 'Jacket', 'Trouser', 'Shirt', 'Dress', 'Skirt', 'Coat', 'Other'].map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </div>
        {(startDate || endDate || categoryFilter !== 'All') && (
          <button
            type="button"
            onClick={() => {
              setStartDate('');
              setEndDate('');
              setCategoryFilter('All');
            }}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            Reset Filters
          </button>
        )}
      </div>

      {/* Report Tabs */}
      <div className="flex flex-wrap gap-1.5 no-print">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              tab === t.id
                ? 'bg-slate-900 text-white'
                : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Report Content */}
      <div ref={reportContentRef} className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        {tab === 'sales' && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs text-slate-500">Total Sales Value (Agreed Orders)</p>
                <p className="font-mono text-lg font-bold text-slate-900 tabular-nums mt-1">{formatMoney(reportData.totalSalesRevenue, currency)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs text-slate-500">Payments Collected</p>
                <p className="font-mono text-lg font-bold text-teal-700 tabular-nums mt-1">{formatMoney(reportData.totalPaymentsReceived, currency)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs text-slate-500">Outstanding Receivables</p>
                <p className="font-mono text-lg font-bold text-amber-700 tabular-nums mt-1">{formatMoney(reportData.totalOutstanding, currency)}</p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                    <th className="py-2.5 px-3">Order</th>
                    <th className="py-2.5 px-3">Customer</th>
                    <th className="py-2.5 px-3">Date</th>
                    <th className="py-2.5 px-3 text-right">Sale Value</th>
                    <th className="py-2.5 px-3 text-right">Paid</th>
                    <th className="py-2.5 px-3 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {reportData.activeOrders.map((o) => {
                    const paid = reportData.paidByOrder[o.id] || 0;
                    return (
                      <tr key={o.id}>
                        <td className="py-2.5 px-3 font-mono font-semibold">{o.order_number}</td>
                        <td className="py-2.5 px-3">{o.customer_name}</td>
                        <td className="py-2.5 px-3 font-mono">{formatDate(o.order_date)}</td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums">{formatMoney(o.agreed_price, currency)}</td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-teal-700">{formatMoney(paid, currency)}</td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-amber-700">{formatMoney(Math.max(0, o.agreed_price - paid), currency)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'customers' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                  <th className="py-2.5 px-3">Customer No.</th>
                  <th className="py-2.5 px-3">Name</th>
                  <th className="py-2.5 px-3">Phone</th>
                  <th className="py-2.5 px-3 text-right">Orders</th>
                  <th className="py-2.5 px-3 text-right">Total Billed</th>
                  <th className="py-2.5 px-3 text-right">Balance Due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.customers.map((c) => {
                  const cOrders = data.orders.filter((o) => o.customer_id === c.id && o.status !== 'Cancelled');
                  const billed = cOrders.reduce((s, o) => s + Number(o.agreed_price || 0), 0);
                  const paid = cOrders.reduce((s, o) => s + (reportData.paidByOrder[o.id] || 0), 0);
                  return (
                    <tr key={c.id}>
                      <td className="py-2.5 px-3 font-mono">{c.customer_number}</td>
                      <td className="py-2.5 px-3 font-medium">{c.full_name}</td>
                      <td className="py-2.5 px-3 font-mono">{c.phone}</td>
                      <td className="py-2.5 px-3 text-right font-mono">{cOrders.length}</td>
                      <td className="py-2.5 px-3 text-right font-mono">{formatMoney(billed, currency)}</td>
                      <td className="py-2.5 px-3 text-right font-mono text-amber-700">{formatMoney(Math.max(0, billed - paid), currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'orders' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                  <th className="py-2.5 px-3">Order No.</th>
                  <th className="py-2.5 px-3">Customer</th>
                  <th className="py-2.5 px-3">Garment</th>
                  <th className="py-2.5 px-3">Order Date</th>
                  <th className="py-2.5 px-3">Due Date</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right">Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {reportData.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="py-2.5 px-3 font-mono font-semibold">{o.order_number}</td>
                    <td className="py-2.5 px-3">{o.customer_name}</td>
                    <td className="py-2.5 px-3">{o.garment_type} ×{o.quantity}</td>
                    <td className="py-2.5 px-3 font-mono">{formatDate(o.order_date)}</td>
                    <td className="py-2.5 px-3 font-mono">{formatDate(o.expected_completion_date)}</td>
                    <td className="py-2.5 px-3 font-semibold">{o.status}</td>
                    <td className="py-2.5 px-3 text-right font-mono">{formatMoney(o.agreed_price, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'completion' && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: 'Pending', count: reportData.orders.filter((o) => o.status === 'Pending').length },
              { label: 'In Progress', count: reportData.orders.filter((o) => o.status === 'In Progress').length },
              { label: 'Completed / Ready / Collected', count: reportData.orders.filter((o) => ['Completed', 'Ready for Collection', 'Collected'].includes(o.status)).length },
              { label: 'Cancelled', count: reportData.orders.filter((o) => o.status === 'Cancelled').length },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-slate-200 p-4">
                <p className="text-xs text-slate-500">{s.label}</p>
                <p className="font-mono text-2xl font-bold text-slate-900 mt-1">{s.count}</p>
              </div>
            ))}
          </div>
        )}

        {tab === 'outstanding' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                  <th className="py-2.5 px-3">Order</th>
                  <th className="py-2.5 px-3">Customer</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right">Agreed Price</th>
                  <th className="py-2.5 px-3 text-right">Paid</th>
                  <th className="py-2.5 px-3 text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {reportData.outstandingOrders.map((o) => (
                  <tr key={o.id}>
                    <td className="py-2.5 px-3 font-mono font-semibold">{o.order_number}</td>
                    <td className="py-2.5 px-3">{o.customer_name}</td>
                    <td className="py-2.5 px-3">{o.status}</td>
                    <td className="py-2.5 px-3 text-right font-mono">{formatMoney(o.agreed_price, currency)}</td>
                    <td className="py-2.5 px-3 text-right font-mono text-teal-700">{formatMoney(o.paid, currency)}</td>
                    <td className="py-2.5 px-3 text-right font-mono font-bold text-amber-700">{formatMoney(o.balance, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'inventory' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                  <th className="py-2.5 px-3">SKU</th>
                  <th className="py-2.5 px-3">Material</th>
                  <th className="py-2.5 px-3">Category</th>
                  <th className="py-2.5 px-3 text-right">Available</th>
                  <th className="py-2.5 px-3 text-right">Unit Cost</th>
                  <th className="py-2.5 px-3 text-right">Stock Valuation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.materials.map((m) => (
                  <tr key={m.id}>
                    <td className="py-2.5 px-3 font-mono">{m.sku}</td>
                    <td className="py-2.5 px-3 font-medium">{m.name}</td>
                    <td className="py-2.5 px-3">{m.category}</td>
                    <td className="py-2.5 px-3 text-right font-mono">{m.current_qty} {m.unit}</td>
                    <td className="py-2.5 px-3 text-right font-mono">{formatMoney(m.purchase_price, currency)}</td>
                    <td className="py-2.5 px-3 text-right font-mono font-semibold">{formatMoney(m.current_qty * m.purchase_price, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(tab === 'consumption' || tab === 'wastage') && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                  <th className="py-2.5 px-3">Order</th>
                  <th className="py-2.5 px-3">Material</th>
                  <th className="py-2.5 px-3 text-right">Issued</th>
                  <th className="py-2.5 px-3 text-right">Consumed</th>
                  <th className="py-2.5 px-3 text-right">Returned</th>
                  <th className="py-2.5 px-3 text-right">Wasted</th>
                  <th className="py-2.5 px-3 text-right">{tab === 'wastage' ? 'Wastage Cost' : 'Actual Cost'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(tab === 'wastage'
                  ? reportData.filteredUsage.filter((u) => u.wasted_qty > 0)
                  : reportData.filteredUsage
                ).map((u) => (
                  <tr key={u.id}>
                    <td className="py-2.5 px-3 font-mono font-semibold">{u.order_number}</td>
                    <td className="py-2.5 px-3">{u.material_name}</td>
                    <td className="py-2.5 px-3 text-right font-mono">{u.issued_qty}</td>
                    <td className="py-2.5 px-3 text-right font-mono">{u.consumed_qty}</td>
                    <td className="py-2.5 px-3 text-right font-mono">{u.returned_qty}</td>
                    <td className="py-2.5 px-3 text-right font-mono text-red-600">{u.wasted_qty}</td>
                    <td className="py-2.5 px-3 text-right font-mono font-semibold">
                      {formatMoney(
                        tab === 'wastage' ? u.wasted_qty * u.unit_cost_at_time : u.actual_cost,
                        currency
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'est_vs_actual' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                  <th className="py-2.5 px-3">Order</th>
                  <th className="py-2.5 px-3">Customer</th>
                  <th className="py-2.5 px-3">Garment</th>
                  <th className="py-2.5 px-3 text-right">Estimated Material Cost</th>
                  <th className="py-2.5 px-3 text-right">Actual Material Cost</th>
                  <th className="py-2.5 px-3 text-right">Variance (Actual − Est.)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {reportData.activeOrders.map((o) => {
                  const est = reportData.latestEstByOrder[o.id];
                  const act = reportData.actualCostByOrder[o.id] || 0;
                  const hasActual = data.usageRecords.some(
                    (u) => u.order_id === o.id && (u.consumed_qty > 0 || u.wasted_qty > 0)
                  );
                  const variance = est !== undefined && hasActual ? act - est : null;
                  return (
                    <tr key={o.id}>
                      <td className="py-2.5 px-3 font-mono font-semibold">{o.order_number}</td>
                      <td className="py-2.5 px-3">{o.customer_name}</td>
                      <td className="py-2.5 px-3">{o.garment_type}</td>
                      <td className="py-2.5 px-3 text-right font-mono">
                        {est !== undefined ? formatMoney(est, currency) : 'Not estimated'}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-semibold">
                        {hasActual ? formatMoney(act, currency) : 'Not recorded'}
                      </td>
                      <td className={`py-2.5 px-3 text-right font-mono font-semibold ${variance !== null && variance > 0 ? 'text-red-600' : 'text-teal-700'}`}>
                        {variance !== null ? formatMoney(variance, currency) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'profitability' && (
          <div className="space-y-5">
            {reportData.hasIncompleteCosts && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  <strong>Incomplete Cost Notice:</strong> Only {reportData.ordersWithActualMaterials} of {reportData.activeOrders.length} active orders have actual material consumption recorded. Profit figures below reflect recorded actual costs only (estimated costs are intentionally excluded) and should not be treated as final guaranteed profit until all production usage is logged.
                </span>
              </div>
            )}

            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
              <div className="rounded-lg border border-slate-200 p-4">
                <span className="text-slate-500">Sales Revenue (Agreed Orders)</span>
                <p className="font-mono text-lg font-bold text-slate-900 mt-1">{formatMoney(reportData.totalSalesRevenue, currency)}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-4">
                <span className="text-slate-500">Actual Consumed & Wasted Material Cost</span>
                <p className="font-mono text-lg font-bold text-red-700 mt-1">− {formatMoney(reportData.totalActualMaterials, currency)}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-4">
                <span className="text-slate-500">Recorded Labour & Order Expenses</span>
                <p className="font-mono text-lg font-bold text-red-700 mt-1">− {formatMoney(reportData.totalLabour + reportData.totalOrderOther, currency)}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-4">
                <span className="text-slate-500">Operating Business Expenses</span>
                <p className="font-mono text-lg font-bold text-red-700 mt-1">− {formatMoney(reportData.totalOperatingExpenses, currency)}</p>
              </div>
              <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-4 col-span-2">
                <span className="text-teal-800 font-semibold">Net Recorded Profit (Actual Costs Basis)</span>
                <p className={`font-mono text-2xl font-bold mt-1 ${reportData.netProfit >= 0 ? 'text-teal-700' : 'text-red-700'}`}>
                  {formatMoney(reportData.netProfit, currency)}
                </p>
              </div>
            </div>

            {/* Record Business Expense */}
            <div className="border-t border-slate-200 pt-4 no-print">
              <h3 className="font-display text-sm font-semibold text-slate-900 mb-3">Record Business Expense</h3>
              <form onSubmit={handleAddExpense} className="grid grid-cols-1 sm:grid-cols-5 gap-2 text-xs">
                <input
                  required
                  value={expCategory}
                  onChange={(e) => setExpCategory(e.target.value)}
                  placeholder="Category (e.g., Rent, Power)"
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <input
                  required
                  value={expDesc}
                  onChange={(e) => setExpDesc(e.target.value)}
                  placeholder="Description"
                  className="sm:col-span-2 rounded-lg border border-slate-300 px-3 py-2"
                />
                <input
                  type="number"
                  step="0.01"
                  min="1"
                  required
                  value={expAmount}
                  onChange={(e) => setExpAmount(e.target.value)}
                  placeholder={`Amount (${currency})`}
                  className="rounded-lg border border-slate-300 px-3 py-2 font-mono"
                />
                <div className="flex gap-2">
                  <input
                    type="date"
                    value={expDate}
                    onChange={(e) => setExpDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-2 py-2 font-mono"
                  />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-2 font-semibold text-white hover:bg-slate-800 shrink-0"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>

      {printPreviewDoc && (
        <PrintDocumentModal
          doc={printPreviewDoc}
          onClose={() => setPrintPreviewDoc(null)}
          onNotify={onNotify}
        />
      )}
    </div>
  );
};
