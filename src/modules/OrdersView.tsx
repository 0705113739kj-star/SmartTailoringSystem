import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CreditCard,
  Eye,
  FileDown,
  Plus,
  Printer,
  Scissors,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { PrintDocumentModal, type PrintableDocumentPayload } from '../components/PrintDocumentModal';
import { apiRequest, formatDate, generateUuid } from '../lib/api';
import { escapeHtml, isEmbeddedIframe, printHtmlDocument, savePdfToDesktop, type PdfDocumentSpec } from '../lib/print';
import type { OrderStatus, TailoringOrder, WorkspaceData } from '../types';

const STATUS_OPTIONS: OrderStatus[] = [
  'Pending',
  'In Progress',
  'Completed',
  'Ready for Collection',
  'Collected',
  'Cancelled',
];

const STATUS_BADGE: Record<OrderStatus, string> = {
  Pending: 'bg-amber-50 text-amber-800 border-amber-200',
  'In Progress': 'bg-sky-50 text-sky-800 border-sky-200',
  Completed: 'bg-teal-50 text-teal-800 border-teal-200',
  'Ready for Collection': 'bg-emerald-50 text-emerald-800 border-emerald-200',
  Collected: 'bg-slate-100 text-slate-800 border-slate-200',
  Cancelled: 'bg-red-50 text-red-700 border-red-200',
};

interface OrdersViewProps {
  businessName: string;
  data: WorkspaceData;
  initialOrderId?: number | null;
  onRefresh: () => Promise<void>;
  onOpenInPos?: (orderId: number) => void;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const OrdersView: React.FC<OrdersViewProps> = ({
  businessName,
  data,
  initialOrderId,
  onRefresh,
  onOpenInPos,
  onNotify,
}) => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(initialOrderId || null);
  const [saving, setSaving] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    type: 'cancel' | 'delete';
    order: TailoringOrder;
  } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [printPreviewDoc, setPrintPreviewDoc] = useState<PrintableDocumentPayload | null>(null);

  // Create form state (production & scheduling fields only; billing & payments are handled in POS)
  const [customerId, setCustomerId] = useState('');
  const [measurementId, setMeasurementId] = useState('');
  const [garmentType, setGarmentType] = useState('Suit');
  const [designSpecs, setDesignSpecs] = useState('');
  const [color, setColor] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [orderDate, setOrderDate] = useState(new Date().toISOString().slice(0, 10));
  const [expectedDate, setExpectedDate] = useState(
    new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
  );
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (initialOrderId) {
      setSelectedOrderId(initialOrderId);
    }
  }, [initialOrderId]);

  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.orders.filter((o) => {
      if (statusFilter !== 'All' && o.status !== statusFilter) return false;
      if (q) {
        return (
          o.order_number.toLowerCase().includes(q) ||
          (o.customer_name || '').toLowerCase().includes(q) ||
          o.garment_type.toLowerCase().includes(q) ||
          (o.color || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [data.orders, search, statusFilter]);

  const customerMeasurements = useMemo(() => {
    if (!customerId) return [];
    return data.measurements.filter((m) => String(m.customer_id) === customerId);
  }, [data.measurements, customerId]);

  const resetCreateForm = () => {
    setCustomerId(data.customers[0] ? String(data.customers[0].id) : '');
    setMeasurementId('');
    setGarmentType('Suit');
    setDesignSpecs('');
    setColor('');
    setQuantity('1');
    setOrderDate(new Date().toISOString().slice(0, 10));
    setExpectedDate(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
    setNotes('');
  };

  const handleCreateOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const cust = data.customers.find((c) => String(c.id) === customerId);
      if (!cust) throw new Error('Select a customer first.');

      const qty = Math.max(1, Number(quantity || 1));
      const clientUuid = generateUuid();
      await apiRequest('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          customerId: Number(customerId),
          measurementId: measurementId ? Number(measurementId) : null,
          garmentType,
          designSpecs,
          color,
          quantity: qty,
          orderDate,
          expectedCompletionDate: expectedDate,
          agreedPrice: 0,
          depositAmount: 0,
          labourCost: 0,
          otherExpenses: 0,
          notes,
          clientUuid,
        }),
      });
      await onRefresh();
      onNotify('Tailoring order created. Open POS and Payments to calculate pricing and collect payment.', 'success');
      setShowCreate(false);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create order.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (order: TailoringOrder, nextStatus: OrderStatus) => {
    try {
      await apiRequest(`/api/orders/${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      await onRefresh();
      onNotify(`Order ${order.order_number} marked as ${nextStatus}.`, 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update status.', 'error');
    }
  };

  const handleConfirmModalAction = async () => {
    if (!confirmAction) return;
    const { type, order } = confirmAction;
    setActionBusy(true);
    try {
      if (type === 'cancel') {
        await handleStatusChange(order, 'Cancelled');
        setConfirmAction(null);
      } else {
        await apiRequest(`/api/orders/${order.id}`, { method: 'DELETE' });
        await onRefresh();
        if (selectedOrderId === order.id) setSelectedOrderId(null);
        setConfirmAction(null);
        onNotify(`Order ${order.order_number} permanently deleted.`, 'success');
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : `Failed to ${type} order.`, 'error');
    } finally {
      setActionBusy(false);
    }
  };

  // Detailed Order Page View (Production, Measurements & Workshop Materials only)
  const selectedOrder = selectedOrderId ? data.orders.find((o) => o.id === selectedOrderId) || null : null;

  if (selectedOrder) {
    const customer = data.customers.find((c) => c.id === selectedOrder.customer_id);
    const measurement = selectedOrder.measurement_id
      ? data.measurements.find((m) => m.id === selectedOrder.measurement_id)
      : null;
    const estimations = data.estimations.filter((e) => e.order_id === selectedOrder.id);
    const usageRecords = data.usageRecords.filter((u) => u.order_id === selectedOrder.id);

    let parsedMeasurements: Record<string, number> = {};
    if (measurement?.values_json) {
      try {
        parsedMeasurements = JSON.parse(measurement.values_json);
      } catch {
        parsedMeasurements = {};
      }
    }

    const buildOrderSheetHtml = () => {
      const measRows = Object.entries(parsedMeasurements)
        .map(
          ([k, v]) =>
            `<div class="tp-row"><span class="tp-row-label" style="text-transform:capitalize;">${escapeHtml(
              k.replace(/_/g, ' ')
            )}</span><span class="tp-row-val tp-mono">${escapeHtml(v)}${escapeHtml(measurement?.unit || 'cm')}</span></div>`
        )
        .join('');

      const usageRows = usageRecords
        .map(
          (u) =>
            `<div class="tp-row"><span class="tp-row-label">${escapeHtml(
              u.material_name || 'Material'
            )}</span><span class="tp-row-val tp-mono">Issued ${escapeHtml(u.issued_qty)} · Consumed ${escapeHtml(
              u.consumed_qty
            )} · Returned ${escapeHtml(u.returned_qty)} (${escapeHtml(u.material_unit || '')})</span></div>`
        )
        .join('');

      return `
        <div class="tp-doc">
          <div class="tp-header">
            <h1 class="tp-title">${escapeHtml(businessName)} — Tailoring Workshop Order Sheet</h1>
            <p class="tp-subtitle tp-mono">Order: ${escapeHtml(selectedOrder.order_number)} · Status: ${escapeHtml(selectedOrder.status)}</p>
            <p class="tp-meta">Order Date: ${escapeHtml(formatDate(selectedOrder.order_date))} · Expected Completion: ${escapeHtml(formatDate(selectedOrder.expected_completion_date))}</p>
          </div>
          <div class="tp-grid-2">
            <div>
              <h2 class="tp-section-title">Customer & Specifications</h2>
              <div class="tp-row"><span class="tp-row-label">Customer</span><span class="tp-row-val">${escapeHtml(customer?.full_name || selectedOrder.customer_name || '')}</span></div>
              <div class="tp-row"><span class="tp-row-label">Phone</span><span class="tp-row-val tp-mono">${escapeHtml(customer?.phone || selectedOrder.customer_phone || '')}</span></div>
              <div class="tp-row"><span class="tp-row-label">Garment</span><span class="tp-row-val">${escapeHtml(selectedOrder.garment_type)} ×${escapeHtml(selectedOrder.quantity)}</span></div>
              <div class="tp-row"><span class="tp-row-label">Color</span><span class="tp-row-val">${escapeHtml(selectedOrder.color || 'Not specified')}</span></div>
              ${selectedOrder.design_specs ? `<p style="font-size:12px;margin-top:8px;"><strong>Design Specs:</strong> ${escapeHtml(selectedOrder.design_specs)}</p>` : ''}
              ${selectedOrder.notes ? `<p style="font-size:12px;margin-top:4px;"><strong>Notes:</strong> ${escapeHtml(selectedOrder.notes)}</p>` : ''}
            </div>
            <div>
              <h2 class="tp-section-title">Body Measurements (${escapeHtml(measurement?.unit || 'cm')})</h2>
              ${measRows || '<p style="font-size:12px;color:#64748b;">No linked measurements recorded.</p>'}
            </div>
          </div>
          ${
            usageRows
              ? `<h2 class="tp-section-title">Workshop Material Allocation</h2>${usageRows}`
              : ''
          }
        </div>
      `;
    };

    const buildOrderSheetPdfSpec = (): PdfDocumentSpec => {
      const measRows = Object.entries(parsedMeasurements).map(([k, v]) => ({
        label: k.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()),
        value: `${v}${measurement?.unit || 'cm'}`,
      }));

      const paragraphs: Array<{ label: string; text: string }> = [];
      if (selectedOrder.design_specs) {
        paragraphs.push({ label: 'Design Specs', text: selectedOrder.design_specs });
      }
      if (selectedOrder.notes) {
        paragraphs.push({ label: 'Notes', text: selectedOrder.notes });
      }

      return {
        title: `${businessName} — Tailoring Workshop Order Sheet`,
        subtitle: `Order: ${selectedOrder.order_number} · Status: ${selectedOrder.status}`,
        meta: `Order Date: ${formatDate(selectedOrder.order_date)} · Expected Completion: ${formatDate(selectedOrder.expected_completion_date)}`,
        sections: [
          {
            title: 'Customer & Garment Specifications',
            rows: [
              { label: 'Customer', value: customer?.full_name || selectedOrder.customer_name || '' },
              { label: 'Phone', value: customer?.phone || selectedOrder.customer_phone || '' },
              { label: 'Garment', value: `${selectedOrder.garment_type} ×${selectedOrder.quantity}` },
              { label: 'Color', value: selectedOrder.color || 'Not specified' },
            ],
          },
          {
            title: `Body Measurements (${measurement?.unit || 'cm'})`,
            rows: measRows,
          },
        ],
        paragraphs,
        tables:
          usageRecords.length > 0
            ? [
                {
                  title: 'Workshop Material Allocation',
                  headers: ['Material', 'Status', 'Issued', 'Consumed', 'Returned', 'Unit'],
                  rows: usageRecords.map((u) => [
                    u.material_name || 'Material',
                    u.status,
                    u.issued_qty,
                    u.consumed_qty,
                    u.returned_qty,
                    u.material_unit || '',
                  ]),
                  numericColumns: [2, 3, 4],
                },
              ]
            : undefined,
      };
    };

    const handlePrintOrderSheet = () => {
      const title = `Order ${selectedOrder.order_number} - ${businessName}`;
      const htmlBody = buildOrderSheetHtml();
      if (isEmbeddedIframe()) {
        setPrintPreviewDoc({
          title,
          filenameBase: `order-${selectedOrder.order_number}`,
          htmlBody,
          pdfSpec: buildOrderSheetPdfSpec(),
        });
        return;
      }
      printHtmlDocument({ title, htmlBody });
    };

    const handleSaveOrderPdf = async () => {
      try {
        const res = await savePdfToDesktop(
          buildOrderSheetPdfSpec(),
          `order-${selectedOrder.order_number}.pdf`
        );
        if (res.cancelled) return;
        onNotify(
          res.method === 'picker'
            ? `Saved order-${selectedOrder.order_number}.pdf to your selected location.`
            : res.reason === 'iframe_blocked'
            ? `Downloaded order-${selectedOrder.order_number}.pdf (preview frame blocks Desktop File Explorer — click "Open Full Tab" in top bar to choose a folder).`
            : `Downloaded order-${selectedOrder.order_number}.pdf to your computer.`,
          'success'
        );
      } catch (err) {
        onNotify(err instanceof Error ? err.message : 'Failed to export order PDF.', 'error');
      }
    };

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setSelectedOrderId(null)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to Orders
            </button>
            <div>
              <h1 className="font-display text-xl font-bold text-slate-900">
                Order <span className="font-mono">{selectedOrder.order_number}</span>
              </h1>
              <p className="text-xs text-slate-500">
                {selectedOrder.garment_type} · Qty {selectedOrder.quantity} · Due{' '}
                {formatDate(selectedOrder.expected_completion_date)}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onOpenInPos && selectedOrder.status !== 'Cancelled' && (
              <button
                type="button"
                onClick={() => onOpenInPos(selectedOrder.id)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-800"
              >
                <CreditCard className="h-3.5 w-3.5" />
                Bill &amp; Collect in POS
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleSaveOrderPdf()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <FileDown className="h-3.5 w-3.5" />
              Save PDF to Desktop
            </button>
            <button
              type="button"
              onClick={handlePrintOrderSheet}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
            >
              <Printer className="h-3.5 w-3.5" />
              Print Order Sheet
            </button>
            {selectedOrder.status !== 'Cancelled' && selectedOrder.status !== 'Collected' && (
              <button
                type="button"
                onClick={() => setConfirmAction({ type: 'cancel', order: selectedOrder })}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100"
              >
                <Ban className="h-3.5 w-3.5" />
                Cancel Order
              </button>
            )}
            <button
              type="button"
              onClick={() => setConfirmAction({ type: 'delete', order: selectedOrder })}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete Order
            </button>
            <label className="text-xs font-medium text-slate-600 ml-1">Status:</label>
            <select
              value={selectedOrder.status}
              onChange={(e) => handleStatusChange(selectedOrder, e.target.value as OrderStatus)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-900"
            >
              {STATUS_OPTIONS.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Customer & Garment Specs */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
            <h2 className="font-display text-sm font-semibold text-slate-900 border-b border-slate-100 pb-2">
              Customer &amp; Specifications
            </h2>
            <div className="text-xs space-y-1.5">
              <p>
                <span className="text-slate-500">Customer:</span>{' '}
                <strong>{customer?.full_name || selectedOrder.customer_name}</strong>
              </p>
              <p>
                <span className="text-slate-500">Phone:</span>{' '}
                <span className="font-mono">{customer?.phone || selectedOrder.customer_phone}</span>
              </p>
              <p>
                <span className="text-slate-500">Garment:</span> {selectedOrder.garment_type} (Qty{' '}
                {selectedOrder.quantity})
              </p>
              <p>
                <span className="text-slate-500">Color:</span> {selectedOrder.color || 'Not specified'}
              </p>
              <p>
                <span className="text-slate-500">Order Date:</span> {formatDate(selectedOrder.order_date)}
              </p>
              <p>
                <span className="text-slate-500">Expected Date:</span>{' '}
                {formatDate(selectedOrder.expected_completion_date)}
              </p>
              {selectedOrder.design_specs && (
                <p className="pt-1 text-slate-700">
                  <span className="text-slate-500">Design Specs:</span> {selectedOrder.design_specs}
                </p>
              )}
              {selectedOrder.notes && (
                <p className="text-slate-700">
                  <span className="text-slate-500">Notes:</span> {selectedOrder.notes}
                </p>
              )}
            </div>

            <div className="pt-3 border-t border-slate-100">
              <h3 className="text-xs font-semibold text-slate-700 mb-2">Linked Measurements</h3>
              {!measurement ? (
                <p className="text-xs text-slate-500">No measurement record linked to this order.</p>
              ) : (
                <div className="grid grid-cols-2 gap-1.5 text-xs font-mono">
                  {Object.entries(parsedMeasurements).map(([k, v]) => (
                    <div key={k} className="bg-slate-50 rounded px-2 py-1">
                      <span className="text-slate-500 capitalize">{k.replace(/_/g, ' ')}:</span>{' '}
                      <strong className="text-slate-900">
                        {v}
                        {measurement.unit}
                      </strong>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Workshop Materials & Fabric Planning (Quantities Only) */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
            <h2 className="font-display text-sm font-semibold text-slate-900 border-b border-slate-100 pb-2">
              Workshop Materials &amp; Fabric Planning
            </h2>
            <div>
              <h3 className="text-xs font-semibold text-slate-700 mb-1.5">
                Saved Fabric Estimations (Quantities)
              </h3>
              {estimations.length === 0 ? (
                <p className="text-xs text-slate-500">No fabric estimation saved for this order.</p>
              ) : (
                <div className="space-y-2">
                  {estimations.slice(0, 1).map((est) => {
                    const items = JSON.parse(est.items_json || '[]') as Array<{
                      materialName: string;
                      estimatedQty: number;
                      unit: string;
                    }>;
                    return (
                      <div key={est.id} className="rounded-lg bg-slate-50 p-3 text-xs space-y-1">
                        {items.map((it, idx) => (
                          <div key={idx} className="flex justify-between">
                            <span className="text-slate-700">{it.materialName}</span>
                            <span className="font-mono font-semibold text-slate-900">
                              {it.estimatedQty} {it.unit}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-slate-100">
              <h3 className="text-xs font-semibold text-slate-700 mb-1.5">
                Actual Material Issuance &amp; Consumption (Quantities)
              </h3>
              {usageRecords.length === 0 ? (
                <p className="text-xs text-slate-500">No actual materials issued or consumed yet.</p>
              ) : (
                <div className="space-y-2 text-xs">
                  {usageRecords.map((u) => (
                    <div key={u.id} className="rounded-lg border border-slate-200 p-2.5 space-y-1">
                      <div className="flex justify-between font-semibold text-slate-900">
                        <span>{u.material_name}</span>
                        <span className="text-slate-500">{u.status}</span>
                      </div>
                      <p className="font-mono text-[11px] text-slate-600">
                        Issued: {u.issued_qty} · Consumed: {u.consumed_qty} · Returned: {u.returned_qty} · Wasted:{' '}
                        {u.wasted_qty} ({u.material_unit})
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-slate-100 rounded-lg bg-slate-50 p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-slate-600">
                All pricing, cost calculations, balances, and payments are managed in POS and Payments.
              </span>
              {onOpenInPos && selectedOrder.status !== 'Cancelled' && (
                <button
                  type="button"
                  onClick={() => onOpenInPos(selectedOrder.id)}
                  className="inline-flex items-center gap-1.5 font-semibold text-teal-700 hover:text-teal-800"
                >
                  <CreditCard className="h-3.5 w-3.5" />
                  Open in POS &amp; Payments
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Cancel / Delete Confirmation Modal */}
        {confirmAction && (
          <OrderConfirmModal
            action={confirmAction}
            busy={actionBusy}
            onClose={() => setConfirmAction(null)}
            onConfirm={handleConfirmModalAction}
          />
        )}

        {/* Print & Save Preview Modal */}
        {printPreviewDoc && (
          <PrintDocumentModal
            doc={printPreviewDoc}
            onClose={() => setPrintPreviewDoc(null)}
            onNotify={onNotify}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900">Tailoring Orders</h1>
          <p className="text-sm text-slate-500">
            Create garment orders, link customer measurements, track workshop progress, and manage cancellations.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            resetCreateForm();
            setShowCreate(true);
          }}
          disabled={data.customers.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap self-start sm:self-auto"
        >
          <Plus className="h-4 w-4" />
          New Tailoring Order
        </button>
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search order no., customer, garment, or color..."
            className="w-full rounded-lg border border-slate-300 bg-white pl-10 pr-3.5 py-2 text-sm focus:border-teal-600 focus:outline-none"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1 bg-slate-100 p-1 rounded-lg">
          {['All', ...STATUS_OPTIONS].map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                statusFilter === st ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      {/* Orders Table (Production Columns Only) */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        {filteredOrders.length === 0 ? (
          <div className="p-10 text-center">
            <Scissors className="h-8 w-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-slate-700">No tailoring orders match your filter</p>
            <p className="text-xs text-slate-500 mt-1">
              Create a new tailoring order to track workshop production and measurements.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-3 px-4">Order No.</th>
                  <th className="py-3 px-4">Customer</th>
                  <th className="py-3 px-4">Garment</th>
                  <th className="py-3 px-4">Order Date</th>
                  <th className="py-3 px-4">Due Date</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredOrders.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50">
                    <td className="py-3 px-4 font-mono text-xs font-semibold text-slate-900">
                      {o.order_number}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-900">{o.customer_name}</div>
                      <div className="text-xs text-slate-500 font-mono">{o.customer_phone}</div>
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-700">
                      <div className="font-medium">
                        {o.garment_type} × {o.quantity}
                      </div>
                      {o.color && <div className="text-slate-500">{o.color}</div>}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-600">
                      {formatDate(o.order_date)}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-600">
                      {formatDate(o.expected_completion_date)}
                    </td>
                    <td className="py-3 px-4">
                      <select
                        value={o.status}
                        onChange={(e) => handleStatusChange(o, e.target.value as OrderStatus)}
                        className={`rounded-md border px-2 py-1 text-xs font-semibold ${STATUS_BADGE[o.status]}`}
                      >
                        {STATUS_OPTIONS.map((st) => (
                          <option key={st} value={st}>
                            {st}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setSelectedOrderId(o.id)}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          Details
                        </button>
                        {o.status !== 'Cancelled' && o.status !== 'Collected' && (
                          <button
                            type="button"
                            onClick={() => setConfirmAction({ type: 'cancel', order: o })}
                            title="Cancel order"
                            className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
                          >
                            <Ban className="h-3.5 w-3.5" />
                            Cancel
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setConfirmAction({ type: 'delete', order: o })}
                          title="Delete order"
                          className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Order Modal (Production Fields Only) */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-6 shadow-xl my-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-bold text-slate-900">Create Tailoring Order</h2>
              <button type="button" onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-700">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleCreateOrder} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Customer *</label>
                  <select
                    required
                    value={customerId}
                    onChange={(e) => {
                      setCustomerId(e.target.value);
                      setMeasurementId('');
                    }}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">Select customer...</option>
                    {data.customers.map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {c.customer_number} — {c.full_name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Measurement Record</label>
                  <select
                    value={measurementId}
                    onChange={(e) => setMeasurementId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">None / Link later</option>
                    {customerMeasurements.map((m) => (
                      <option key={m.id} value={String(m.id)}>
                        {m.garment_type} (v{m.version} · {formatDate(m.updated_at)})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Garment Type *</label>
                  <select
                    value={garmentType}
                    onChange={(e) => setGarmentType(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    {['Suit', 'Jacket', 'Trouser', 'Shirt', 'Dress', 'Skirt', 'Coat', 'Other'].map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Color / Fabric Shade</label>
                  <input
                    type="text"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    placeholder="Charcoal Grey"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Quantity *</label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Order Date *</label>
                  <input
                    type="date"
                    required
                    value={orderDate}
                    onChange={(e) => setOrderDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Expected Completion Date *</label>
                  <input
                    type="date"
                    required
                    value={expectedDate}
                    onChange={(e) => setExpectedDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Garment Design &amp; Specifications</label>
                <textarea
                  rows={2}
                  value={designSpecs}
                  onChange={(e) => setDesignSpecs(e.target.value)}
                  placeholder="Peak lapel, double vent, flat-front trousers with side adjusters..."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Order Notes</label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <p className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600">
                Pricing calculations, discounts, production costs, and payments are entered in the{' '}
                <strong className="text-slate-900">POS and Payments</strong> module.
              </p>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
                >
                  {saving ? 'Creating...' : 'Create Order'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Cancel / Delete Confirmation Modal */}
      {confirmAction && (
        <OrderConfirmModal
          action={confirmAction}
          busy={actionBusy}
          onClose={() => setConfirmAction(null)}
          onConfirm={handleConfirmModalAction}
        />
      )}
    </div>
  );
};

interface OrderConfirmModalProps {
  action: { type: 'cancel' | 'delete'; order: TailoringOrder };
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

const OrderConfirmModal: React.FC<OrderConfirmModalProps> = ({ action, busy, onClose, onConfirm }) => {
  const isDelete = action.type === 'delete';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl space-y-4">
        <div className="flex items-start gap-3">
          <div
            className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${
              isDelete ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'
            }`}
          >
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <h3 className="font-display text-base font-bold text-slate-900">
              {isDelete ? 'Delete Tailoring Order' : 'Cancel Tailoring Order'}
            </h3>
            <p className="text-xs text-slate-600">
              {isDelete ? (
                <>
                  Are you sure you want to permanently delete order{' '}
                  <strong className="font-mono text-slate-900">{action.order.order_number}</strong> (
                  {action.order.customer_name})? This removes the order, its fabric estimations, usage records, and
                  linked payment records, and restores any unsettled issued materials back to inventory.
                </>
              ) : (
                <>
                  Are you sure you want to cancel order{' '}
                  <strong className="font-mono text-slate-900">{action.order.order_number}</strong> (
                  {action.order.customer_name})? Cancelled orders are excluded from active sales and cannot receive
                  further POS payments.
                </>
              )}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            Keep Order
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-60 ${
              isDelete ? 'bg-red-700 hover:bg-red-800' : 'bg-amber-700 hover:bg-amber-800'
            }`}
          >
            {busy ? 'Processing...' : isDelete ? 'Delete Permanently' : 'Confirm Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
};
