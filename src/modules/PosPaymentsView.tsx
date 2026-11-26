import React, { useEffect, useMemo, useState } from 'react';
import {
  Banknote,
  Building,
  Calculator,
  CheckCircle2,
  CreditCard,
  Download,
  ExternalLink,
  FileDown,
  Printer,
  Save,
  Smartphone,
  X,
} from 'lucide-react';
import { apiRequest, formatDate, formatMoney, generateUuid } from '../lib/api';
import {
  downloadPrintableHtml,
  escapeHtml,
  isEmbeddedIframe,
  printHtmlDocument,
  savePdfToDesktop,
  type PdfDocumentSpec,
} from '../lib/print';
import type { Payment, WorkspaceData } from '../types';

interface PosPaymentsViewProps {
  businessName: string;
  businessPhone?: string;
  businessAddress?: string;
  receiptFooter?: string;
  data: WorkspaceData;
  currency: string;
  initialOrderId?: number | null;
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

function toLocalDateTimeInput(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

export const PosPaymentsView: React.FC<PosPaymentsViewProps> = ({
  businessName,
  businessPhone,
  businessAddress,
  receiptFooter,
  data,
  currency,
  initialOrderId,
  onRefresh,
  onNotify,
}) => {
  const payableOrders = useMemo(
    () => data.orders.filter((o) => o.status !== 'Cancelled'),
    [data.orders]
  );

  const [selectedOrderId, setSelectedOrderId] = useState<string>(() => {
    if (initialOrderId && payableOrders.some((o) => o.id === initialOrderId)) {
      return String(initialOrderId);
    }
    return payableOrders[0] ? String(payableOrders[0].id) : '';
  });

  // Order Billing & Cost Calculator state
  const [unitPrice, setUnitPrice] = useState('0');
  const [discount, setDiscount] = useState('0');
  const [labourCost, setLabourCost] = useState('0');
  const [otherExpenses, setOtherExpenses] = useState('0');
  const [savingBilling, setSavingBilling] = useState(false);

  // Payment Checkout state (100% local & manual confirmation)
  const [method, setMethod] = useState<'Cash' | 'M-Pesa' | 'Bank'>('Cash');
  const [amount, setAmount] = useState('');
  const [cashTendered, setCashTendered] = useState('');
  const [paymentType, setPaymentType] = useState<'Deposit' | 'Partial' | 'Final'>('Partial');
  const [transactionRef, setTransactionRef] = useState('');
  const [paidAtInput, setPaidAtInput] = useState(() => toLocalDateTimeInput());
  const [notes, setNotes] = useState('');
  const [processing, setProcessing] = useState(false);
  const [receiptPayment, setReceiptPayment] = useState<Payment | null>(null);

  useEffect(() => {
    if (initialOrderId && payableOrders.some((o) => o.id === initialOrderId)) {
      setSelectedOrderId(String(initialOrderId));
    }
  }, [initialOrderId, payableOrders]);

  useEffect(() => {
    if (selectedOrderId && !payableOrders.some((o) => String(o.id) === selectedOrderId)) {
      setSelectedOrderId(payableOrders[0] ? String(payableOrders[0].id) : '');
    } else if (!selectedOrderId && payableOrders[0]) {
      setSelectedOrderId(String(payableOrders[0].id));
    }
  }, [payableOrders, selectedOrderId]);

  const selectedOrder = payableOrders.find((o) => String(o.id) === selectedOrderId) || null;

  // Populate billing calculator fields whenever selected order changes
  useEffect(() => {
    if (!selectedOrder) {
      setUnitPrice('0');
      setDiscount('0');
      setLabourCost('0');
      setOtherExpenses('0');
      return;
    }
    const qty = Math.max(1, Number(selectedOrder.quantity || 1));
    const perUnit = Math.round((Number(selectedOrder.agreed_price || 0) / qty) * 100) / 100;
    setUnitPrice(perUnit > 0 ? String(perUnit) : '0');
    setDiscount('0');
    setLabourCost(String(Number(selectedOrder.labour_cost || 0)));
    setOtherExpenses(String(Number(selectedOrder.other_expenses || 0)));
  }, [
    selectedOrder?.id,
    selectedOrder?.agreed_price,
    selectedOrder?.labour_cost,
    selectedOrder?.other_expenses,
    selectedOrder?.quantity,
  ]);

  const orderPaid = selectedOrder
    ? data.payments
        .filter((p) => p.order_id === selectedOrder.id && p.status === 'Completed')
        .reduce((s, p) => s + Number(p.amount || 0), 0)
    : 0;

  const savedAgreedPrice = selectedOrder ? Number(selectedOrder.agreed_price || 0) : 0;
  const outstandingBalance = Math.max(0, savedAgreedPrice - orderPaid);

  // Live billing calculations inside POS & Payments
  const orderQty = selectedOrder ? Math.max(1, Number(selectedOrder.quantity || 1)) : 1;
  const parsedUnitPrice = Math.max(0, Number(unitPrice || 0));
  const parsedDiscount = Math.max(0, Number(discount || 0));
  const parsedLabour = Math.max(0, Number(labourCost || 0));
  const parsedOther = Math.max(0, Number(otherExpenses || 0));
  const grossSubtotal = Math.round(parsedUnitPrice * orderQty * 100) / 100;
  const calculatedAgreedPrice = Math.max(0, Math.round((grossSubtotal - parsedDiscount) * 100) / 100);

  const actualMaterialCost = useMemo(() => {
    if (!selectedOrder) return 0;
    return data.usageRecords
      .filter((u) => u.order_id === selectedOrder.id)
      .reduce((s, u) => s + Number(u.actual_cost || 0), 0);
  }, [data.usageRecords, selectedOrder]);

  const latestEstimatedCost = useMemo(() => {
    if (!selectedOrder) return null;
    const est = data.estimations.find((e) => e.order_id === selectedOrder.id);
    return est ? Number(est.total_estimated_cost || 0) : null;
  }, [data.estimations, selectedOrder]);

  const totalProductionCost = Math.round((actualMaterialCost + parsedLabour + parsedOther) * 100) / 100;
  const projectedMargin = Math.round((calculatedAgreedPrice - totalProductionCost) * 100) / 100;
  const projectedBalance = Math.max(0, Math.round((calculatedAgreedPrice - orderPaid) * 100) / 100);

  const billingDirty =
    selectedOrder !== null &&
    (Math.abs(calculatedAgreedPrice - Number(selectedOrder.agreed_price || 0)) > 0.01 ||
      Math.abs(parsedLabour - Number(selectedOrder.labour_cost || 0)) > 0.01 ||
      Math.abs(parsedOther - Number(selectedOrder.other_expenses || 0)) > 0.01);

  // Cash change calculation
  const payAmountNum = Math.max(0, Number(amount || 0));
  const tenderedNum = Number(cashTendered || 0);
  const hasTenderedInput = cashTendered.trim() !== '' && Number.isFinite(tenderedNum);
  const changeDue = hasTenderedInput && payAmountNum > 0 ? Math.max(0, tenderedNum - payAmountNum) : 0;
  const cashShortfall = hasTenderedInput && payAmountNum > 0 ? Math.max(0, payAmountNum - tenderedNum) : 0;

  const handleSaveBilling = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) return;
    if (calculatedAgreedPrice < orderPaid - 0.01) {
      onNotify(
        `Agreed selling price (${formatMoney(calculatedAgreedPrice, currency)}) cannot be less than payments already collected (${formatMoney(orderPaid, currency)}).`,
        'error'
      );
      return;
    }

    setSavingBilling(true);
    try {
      await apiRequest(`/api/orders/${selectedOrder.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          agreedPrice: calculatedAgreedPrice,
          labourCost: parsedLabour,
          otherExpenses: parsedOther,
        }),
      });
      await onRefresh();
      onNotify(`Order billing saved for ${selectedOrder.order_number}.`, 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save order billing.', 'error');
    } finally {
      setSavingBilling(false);
    }
  };

  const handlePaymentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) {
      onNotify('Select a tailoring order first.', 'error');
      return;
    }
    if (savedAgreedPrice <= 0) {
      onNotify('Set and save the Agreed Selling Price in Order Billing before collecting payment.', 'error');
      return;
    }

    const payAmt = Number(amount || 0);
    if (!Number.isFinite(payAmt) || payAmt <= 0) {
      onNotify('Payment amount must be greater than zero.', 'error');
      return;
    }
    if (payAmt > outstandingBalance + 0.01) {
      onNotify(`Amount exceeds outstanding balance (${formatMoney(outstandingBalance, currency)}).`, 'error');
      return;
    }
    if (method === 'Cash' && hasTenderedInput && tenderedNum < payAmt - 0.01) {
      onNotify(
        `Cash tendered is less than the payment amount by ${formatMoney(cashShortfall, currency)}.`,
        'error'
      );
      return;
    }

    const parsedPaidAt = paidAtInput ? new Date(paidAtInput) : new Date();
    if (Number.isNaN(parsedPaidAt.getTime())) {
      onNotify('Please enter a valid payment date and time.', 'error');
      return;
    }

    setProcessing(true);
    try {
      const clientUuid = generateUuid();
      const res = await apiRequest<{ payment: Payment }>('/api/payments', {
        method: 'POST',
        body: JSON.stringify({
          orderId: selectedOrder.id,
          amount: payAmt,
          paymentMethod: method,
          paymentType,
          mpesaReference: method === 'Cash' ? '' : transactionRef.trim().toUpperCase(),
          paidAt: parsedPaidAt.toISOString(),
          notes: notes.trim(),
          clientUuid,
        }),
      });
      await onRefresh();
      setReceiptPayment(res.payment);
      setAmount('');
      setCashTendered('');
      setTransactionRef('');
      setPaidAtInput(toLocalDateTimeInput());
      setNotes('');
      onNotify(`${method} payment recorded (${res.payment.receipt_number}).`, 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : `Failed to record ${method} payment.`, 'error');
    } finally {
      setProcessing(false);
    }
  };

  const buildReceiptHtml = (p: Payment) => {
    const orderObj = data.orders.find((o) => o.id === p.order_id);
    const orderTotalPaid = data.payments
      .filter((pay) => pay.order_id === p.order_id && pay.status === 'Completed')
      .reduce((s, pay) => s + Number(pay.amount || 0), 0);
    const remaining = orderObj ? Math.max(0, Number(orderObj.agreed_price) - orderTotalPaid) : null;
    const refLabel = p.payment_method === 'M-Pesa' ? 'M-Pesa Ref' : 'Transaction Ref';

    return `
      <div class="tp-doc tp-receipt">
        <div class="tp-header">
          <h2 class="tp-title">${escapeHtml(businessName)}</h2>
          ${businessAddress ? `<p class="tp-subtitle">${escapeHtml(businessAddress)}</p>` : ''}
          ${businessPhone ? `<p class="tp-subtitle">Tel: ${escapeHtml(businessPhone)}</p>` : ''}
          <p class="tp-subtitle" style="margin-top:4px;font-weight:600;">Official Tailoring Payment Receipt</p>
          <p class="tp-meta tp-mono" style="font-weight:700;color:#0f172a;">${escapeHtml(p.receipt_number)}</p>
        </div>
        <div>
          <div class="tp-row"><span class="tp-row-label">Date</span><span class="tp-row-val tp-mono">${escapeHtml(formatDate(p.paid_at))}</span></div>
          <div class="tp-row"><span class="tp-row-label">Customer</span><span class="tp-row-val">${escapeHtml(p.customer_name || '')}</span></div>
          <div class="tp-row"><span class="tp-row-label">Order Ref</span><span class="tp-row-val tp-mono">${escapeHtml(p.order_number || '')}</span></div>
          <div class="tp-row"><span class="tp-row-label">Method</span><span class="tp-row-val">${escapeHtml(p.payment_method)} (${escapeHtml(p.payment_type)})</span></div>
          ${p.mpesa_receipt_number ? `<div class="tp-row"><span class="tp-row-label">${refLabel}</span><span class="tp-row-val tp-mono">${escapeHtml(p.mpesa_receipt_number)}</span></div>` : ''}
        </div>
        <div class="tp-total">
          <span>Amount Paid</span>
          <span class="tp-mono">${escapeHtml(formatMoney(p.amount, currency))}</span>
        </div>
        ${remaining !== null ? `
          <div class="tp-row" style="margin-top:6px;">
            <span class="tp-row-label">Remaining Balance</span>
            <span class="tp-row-val tp-mono">${escapeHtml(formatMoney(remaining, currency))}</span>
          </div>
        ` : ''}
        <div class="tp-footer">
          ${escapeHtml(receiptFooter || 'Thank you for choosing our tailoring workshop.')}
        </div>
      </div>
    `;
  };

  const buildReceiptPdfSpec = (p: Payment): PdfDocumentSpec => {
    const orderObj = data.orders.find((o) => o.id === p.order_id);
    const orderTotalPaid = data.payments
      .filter((pay) => pay.order_id === p.order_id && pay.status === 'Completed')
      .reduce((s, pay) => s + Number(pay.amount || 0), 0);
    const remaining = orderObj ? Math.max(0, Number(orderObj.agreed_price) - orderTotalPaid) : null;

    const subtitleParts = [
      businessAddress || null,
      businessPhone ? `Tel: ${businessPhone}` : null,
      'Official Tailoring Payment Receipt',
    ].filter(Boolean);

    const rows = [
      { label: 'Date', value: formatDate(p.paid_at) },
      { label: 'Customer', value: p.customer_name || '' },
      { label: 'Order Reference', value: p.order_number || '' },
      { label: 'Payment Method', value: `${p.payment_method} (${p.payment_type})` },
    ];
    if (p.mpesa_receipt_number) {
      rows.push({
        label: p.payment_method === 'M-Pesa' ? 'M-Pesa Ref' : 'Transaction Ref',
        value: p.mpesa_receipt_number,
      });
    }
    if (remaining !== null) {
      rows.push({ label: 'Remaining Order Balance', value: formatMoney(remaining, currency) });
    }

    return {
      title: businessName,
      subtitle: subtitleParts.join(' · '),
      meta: `Receipt No: ${p.receipt_number}`,
      compactReceipt: true,
      sections: [{ title: 'Transaction Details', rows }],
      totalRow: { label: 'Amount Paid', value: formatMoney(p.amount, currency) },
      footer: receiptFooter || 'Thank you for choosing our tailoring workshop.',
    };
  };

  const handlePrintReceipt = (p: Payment) => {
    const res = printHtmlDocument({
      title: `Receipt ${p.receipt_number}`,
      htmlBody: buildReceiptHtml(p),
    });
    if (res.inIframe) {
      onNotify(
        'Print dialog requested. If blocked by the preview iframe, click Save PDF to Desktop or Save HTML.',
        'success'
      );
    }
  };

  const handleSaveReceiptPdf = async (p: Payment) => {
    try {
      const res = await savePdfToDesktop(buildReceiptPdfSpec(p), `receipt-${p.receipt_number}.pdf`);
      if (res.cancelled) return;
      onNotify(
        res.method === 'picker'
          ? `Saved receipt-${p.receipt_number}.pdf to your selected location.`
          : res.reason === 'iframe_blocked'
          ? `Downloaded receipt-${p.receipt_number}.pdf (preview frame blocks Desktop File Explorer — click "Open Full Tab" to pick any folder).`
          : `Downloaded receipt-${p.receipt_number}.pdf to your computer.`,
        'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to export receipt PDF.', 'error');
    }
  };

  const handleDownloadReceipt = async (p: Payment) => {
    try {
      const res = await downloadPrintableHtml({
        title: `Receipt ${p.receipt_number} - ${businessName}`,
        filename: `receipt-${p.receipt_number}.html`,
        htmlBody: buildReceiptHtml(p),
      });
      if (res.cancelled) return;
      onNotify(
        res.method === 'picker'
          ? `Saved receipt-${p.receipt_number}.html to your selected folder.`
          : `Downloaded printable receipt ${p.receipt_number}.html.`,
        'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save printable HTML.', 'error');
    }
  };

  const isElectron =
    typeof window !== 'undefined' && Boolean(window.smartTailoringDesktop?.isElectron);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-bold text-slate-900">POS and Payments</h1>
        <p className="text-sm text-slate-500">
          Calculate order prices, discounts, production margins, balances, and record Cash, manual M-Pesa, or Bank payments offline.
        </p>
      </div>

      {/* Order Selection + Billing Calculator */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-100 pb-4">
          <div className="flex-1 max-w-xl">
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Select Tailoring Order for Billing &amp; Checkout *
            </label>
            <select
              value={selectedOrderId}
              onChange={(e) => {
                setSelectedOrderId(e.target.value);
                setAmount('');
                setCashTendered('');
                setTransactionRef('');
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Select order...</option>
              {payableOrders.map((o) => (
                <option key={o.id} value={String(o.id)}>
                  {o.order_number} — {o.customer_name} ({o.garment_type} ×{o.quantity}){' '}
                  {Number(o.agreed_price) <= 0 ? '[Unpriced]' : `· ${formatMoney(o.agreed_price, currency)}`}
                </option>
              ))}
            </select>
          </div>
          {selectedOrder && (
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <div>
                <span className="text-slate-500 block">Garment &amp; Qty</span>
                <span className="font-semibold text-slate-900">
                  {selectedOrder.garment_type} × {orderQty}
                </span>
              </div>
              {latestEstimatedCost !== null && (
                <div>
                  <span className="text-slate-500 block">Est. Material Cost</span>
                  <span className="font-mono font-semibold text-slate-700">
                    {formatMoney(latestEstimatedCost, currency)}
                  </span>
                </div>
              )}
              <div>
                <span className="text-slate-500 block">Actual Material Cost</span>
                <span className="font-mono font-semibold text-slate-900">
                  {formatMoney(actualMaterialCost, currency)}
                </span>
              </div>
            </div>
          )}
        </div>

        {selectedOrder ? (
          <form onSubmit={handleSaveBilling} className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-slate-900 inline-flex items-center gap-2">
                <Calculator className="h-4 w-4 text-teal-700" />
                Order Pricing &amp; Cost Calculator
              </h2>
              {billingDirty && (
                <span className="text-xs font-medium text-amber-700">Unsaved billing changes</span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Unit Price ({currency}) · Qty {orderQty}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Discount ({currency})</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Labour Cost ({currency})</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={labourCost}
                  onChange={(e) => setLabourCost(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Other Expenses ({currency})</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={otherExpenses}
                  onChange={(e) => setOtherExpenses(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                />
              </div>
            </div>

            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3.5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
              <div>
                <span className="text-slate-500 block">Subtotal</span>
                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                  {formatMoney(grossSubtotal, currency)}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Agreed Selling Price</span>
                <span className="font-mono font-bold text-slate-900 tabular-nums">
                  {formatMoney(calculatedAgreedPrice, currency)}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Total Prod. Cost</span>
                <span className="font-mono font-semibold text-slate-700 tabular-nums">
                  {formatMoney(totalProductionCost, currency)}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Estimated Margin</span>
                <span
                  className={`font-mono font-bold tabular-nums ${
                    projectedMargin >= 0 ? 'text-teal-700' : 'text-red-700'
                  }`}
                >
                  {formatMoney(projectedMargin, currency)}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Paid to Date</span>
                <span className="font-mono font-bold text-teal-700 tabular-nums">
                  {formatMoney(orderPaid, currency)}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Balance Due</span>
                <span className="font-mono font-bold text-amber-700 tabular-nums">
                  {formatMoney(projectedBalance, currency)}
                </span>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={savingBilling}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              >
                <Save className="h-3.5 w-3.5" />
                {savingBilling ? 'Saving...' : 'Save Order Billing'}
              </button>
            </div>
          </form>
        ) : (
          <p className="text-xs text-slate-500">
            Create an active tailoring order in Tailoring Orders, then select it here to calculate pricing and collect payments.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Payment Terminal */}
        <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 space-y-4 self-start">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-slate-900">Payment Checkout</h2>
            <span className="text-xs font-mono text-slate-500">Local Offline POS</span>
          </div>

          {selectedOrder && (
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3.5 grid grid-cols-3 gap-2 text-xs">
              <div>
                <span className="text-slate-500 block">Saved Price</span>
                <span className="font-mono font-bold text-slate-900 tabular-nums">
                  {formatMoney(savedAgreedPrice, currency)}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Paid to Date</span>
                <span className="font-mono font-bold text-teal-700 tabular-nums">
                  {formatMoney(orderPaid, currency)}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Balance Due</span>
                <span className="font-mono font-bold text-amber-700 tabular-nums">
                  {formatMoney(outstandingBalance, currency)}
                </span>
              </div>
            </div>
          )}

          {selectedOrder && savedAgreedPrice <= 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              This order has no saved selling price yet. Enter the Unit Price in the calculator above and click{' '}
              <strong>Save Order Billing</strong> before collecting payment.
            </div>
          )}

          {/* Method Selector */}
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Payment Method</label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setMethod('Cash')}
                className={`flex items-center justify-center gap-1.5 rounded-lg border py-2.5 text-xs font-semibold transition-colors ${
                  method === 'Cash'
                    ? 'border-teal-700 bg-teal-50 text-teal-900'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Banknote className="h-4 w-4" />
                Cash
              </button>
              <button
                type="button"
                onClick={() => setMethod('M-Pesa')}
                className={`flex items-center justify-center gap-1.5 rounded-lg border py-2.5 text-xs font-semibold transition-colors ${
                  method === 'M-Pesa'
                    ? 'border-teal-700 bg-teal-50 text-teal-900'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Smartphone className="h-4 w-4" />
                M-Pesa
              </button>
              <button
                type="button"
                onClick={() => setMethod('Bank')}
                className={`flex items-center justify-center gap-1.5 rounded-lg border py-2.5 text-xs font-semibold transition-colors ${
                  method === 'Bank'
                    ? 'border-teal-700 bg-teal-50 text-teal-900'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Building className="h-4 w-4" />
                Bank
              </button>
            </div>
          </div>

          {method === 'M-Pesa' && (
            <div className="rounded-lg border border-teal-200 bg-teal-50 p-3 text-xs text-teal-900">
              <strong>Manual M-Pesa Payment:</strong> Receive the customer&apos;s transfer directly on your workshop
              M-Pesa Till, Paybill, or phone first, then enter the amount and optional M-Pesa confirmation code below to
              record it locally.
            </div>
          )}

          {method === 'Bank' && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              <strong>Bank Transfer / EFT:</strong> Verify the deposit or transfer with your bank, then enter the
              received amount and optional bank reference below.
            </div>
          )}

          <form onSubmit={handlePaymentSubmit} className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Amount ({currency}) *</label>
                <input
                  type="number"
                  step="0.01"
                  min="1"
                  max={outstandingBalance > 0 ? outstandingBalance : undefined}
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={outstandingBalance > 0 ? String(outstandingBalance) : '0.00'}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Payment Type</label>
                <select
                  value={paymentType}
                  onChange={(e) => setPaymentType(e.target.value as typeof paymentType)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="Deposit">Deposit</option>
                  <option value="Partial">Partial</option>
                  <option value="Final">Final</option>
                </select>
              </div>
            </div>

            {outstandingBalance > 0 && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAmount(String(Math.round(outstandingBalance * 0.5 * 100) / 100));
                    setPaymentType('Deposit');
                  }}
                  className="rounded border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                >
                  50% Deposit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAmount(String(outstandingBalance));
                    setPaymentType('Final');
                  }}
                  className="rounded border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                >
                  Full Balance ({formatMoney(outstandingBalance, currency)})
                </button>
              </div>
            )}

            {(method === 'M-Pesa' || method === 'Bank') && (
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  {method === 'M-Pesa'
                    ? 'M-Pesa Transaction Code / Reference (Optional)'
                    : 'Bank Transfer Reference / Slip No. (Optional)'}
                </label>
                <input
                  type="text"
                  value={transactionRef}
                  onChange={(e) => setTransactionRef(e.target.value)}
                  placeholder={method === 'M-Pesa' ? 'e.g. UB12ABC345' : 'e.g. EFT-90421'}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono uppercase"
                />
              </div>
            )}

            {method === 'Cash' && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
                <div className="grid grid-cols-2 gap-3 items-end">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Cash Tendered ({currency})</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={cashTendered}
                      onChange={(e) => setCashTendered(e.target.value)}
                      placeholder="Optional"
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-mono"
                    />
                  </div>
                  <div className="text-right">
                    <span className="block text-[11px] text-slate-500">
                      {cashShortfall > 0 ? 'Shortfall' : 'Change Due'}
                    </span>
                    <span
                      className={`font-mono text-sm font-bold tabular-nums ${
                        cashShortfall > 0 ? 'text-red-700' : 'text-teal-700'
                      }`}
                    >
                      {formatMoney(cashShortfall > 0 ? cashShortfall : changeDue, currency)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Date &amp; Time</label>
                <input
                  type="datetime-local"
                  value={paidAtInput}
                  onChange={(e) => setPaidAtInput(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Notes (Optional)</label>
                <input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional payment note..."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={
                processing ||
                !selectedOrder ||
                savedAgreedPrice <= 0 ||
                outstandingBalance <= 0
              }
              className="w-full rounded-lg bg-teal-700 px-4 py-2.5 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
            >
              {processing
                ? 'Saving Payment...'
                : method === 'M-Pesa'
                ? 'Confirm & Record M-Pesa Payment'
                : method === 'Bank'
                ? 'Confirm & Record Bank Payment'
                : 'Record Cash Payment'}
            </button>
          </form>
        </div>

        {/* Payment History Table */}
        <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-slate-900">Payment Transactions</h2>
            <span className="text-xs text-slate-500">{data.payments.length} recorded</span>
          </div>
          {data.payments.length === 0 ? (
            <div className="p-10 text-center">
              <CreditCard className="h-8 w-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm font-medium text-slate-700">No payment transactions yet</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600 font-semibold">
                    <th className="py-3 px-4">Receipt</th>
                    <th className="py-3 px-4">Order / Customer</th>
                    <th className="py-3 px-4">Method</th>
                    <th className="py-3 px-4">Status / Ref</th>
                    <th className="py-3 px-4 text-right">Amount</th>
                    <th className="py-3 px-4 text-right">Print</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.payments.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900">
                        {p.receipt_number}
                        <span className="block font-sans text-[11px] font-normal text-slate-500">
                          {formatDate(p.paid_at)}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-mono font-semibold text-slate-800">{p.order_number}</span>
                        <span className="block text-slate-500">{p.customer_name}</span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-medium text-slate-800">{p.payment_method}</span>
                        <span className="block text-slate-500">{p.payment_type}</span>
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`font-semibold ${
                            p.status === 'Completed'
                              ? 'text-teal-700'
                              : p.status === 'Pending'
                              ? 'text-amber-700'
                              : 'text-red-600'
                          }`}
                        >
                          {p.status}
                        </span>
                        {p.mpesa_receipt_number && (
                          <span className="block font-mono text-[10px] text-slate-500">
                            {p.mpesa_receipt_number}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-bold text-slate-900 tabular-nums">
                        {formatMoney(p.amount, currency)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {p.status === 'Completed' && (
                          <button
                            type="button"
                            onClick={() => setReceiptPayment(p)}
                            className="inline-flex items-center gap-1 rounded border border-slate-200 px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-100"
                          >
                            <Printer className="h-3 w-3" />
                            Receipt
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Printable Receipt Modal */}
      {receiptPayment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4 no-print">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-700">
                <CheckCircle2 className="h-4 w-4" />
                Payment Receipt
              </span>
              <button type="button" onClick={() => setReceiptPayment(null)} className="text-slate-400">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="border border-slate-200 rounded-lg p-5 space-y-3 text-xs">
              <div className="text-center border-b border-dashed border-slate-300 pb-3">
                <h3 className="font-display text-base font-bold text-slate-900">{businessName}</h3>
                {businessAddress && <p className="text-[11px] text-slate-500">{businessAddress}</p>}
                {businessPhone && <p className="text-[11px] text-slate-500">Tel: {businessPhone}</p>}
                <p className="text-slate-500 mt-0.5">Official Tailoring Payment Receipt</p>
                <p className="font-mono font-bold text-slate-900 mt-1">{receiptPayment.receipt_number}</p>
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-500">Date:</span>
                  <span className="font-mono">{formatDate(receiptPayment.paid_at)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Customer:</span>
                  <span className="font-semibold">{receiptPayment.customer_name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Order Ref:</span>
                  <span className="font-mono">{receiptPayment.order_number}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Method / Type:</span>
                  <span>
                    {receiptPayment.payment_method} · {receiptPayment.payment_type}
                  </span>
                </div>
                {receiptPayment.mpesa_receipt_number && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">
                      {receiptPayment.payment_method === 'M-Pesa' ? 'M-Pesa Ref:' : 'Transaction Ref:'}
                    </span>
                    <span className="font-mono">{receiptPayment.mpesa_receipt_number}</span>
                  </div>
                )}
              </div>
              <div className="border-t border-dashed border-slate-300 pt-3 flex justify-between text-sm font-bold">
                <span>Amount Paid</span>
                <span className="font-mono text-teal-700">{formatMoney(receiptPayment.amount, currency)}</span>
              </div>
              {receiptFooter && (
                <p className="text-center text-[11px] text-slate-500 border-t border-slate-100 pt-2">
                  {receiptFooter}
                </p>
              )}
            </div>

            {!isElectron && isEmbeddedIframe() && (
              <p className="mt-3 text-[11px] text-slate-600 no-print">
                Preview iframe restricts Desktop File Explorer &amp; printing.{' '}
                <a
                  href={typeof window !== 'undefined' ? window.location.href : '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-teal-700 hover:text-teal-800 underline"
                >
                  Open Full Tab
                  <ExternalLink className="h-3 w-3" />
                </a>{' '}
                to pick any Desktop folder directly.
              </p>
            )}

            <div className="flex flex-wrap justify-end gap-2 mt-4 no-print">
              <button
                type="button"
                onClick={() => setReceiptPayment(null)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => void handleDownloadReceipt(receiptPayment)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" />
                Save HTML
              </button>
              <button
                type="button"
                onClick={() => void handleSaveReceiptPdf(receiptPayment)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-teal-800"
              >
                <FileDown className="h-3.5 w-3.5" />
                Save PDF to Desktop
              </button>
              <button
                type="button"
                onClick={() => handlePrintReceipt(receiptPayment)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                <Printer className="h-3.5 w-3.5" />
                Print Receipt
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
