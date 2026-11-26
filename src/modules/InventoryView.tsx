import React, { useMemo, useState } from 'react';
import { AlertTriangle, Boxes, Edit2, PackagePlus, Plus, Search, X } from 'lucide-react';
import { apiRequest, formatDate, formatMoney, generateUuid } from '../lib/api';
import type { Material, MaterialUsageRecord, WorkspaceData } from '../types';

const MATERIAL_CATEGORIES = [
  'Suit Fabric',
  'Dress Fabric',
  'Lining',
  'Interfacing',
  'Thread',
  'Buttons',
  'Zippers',
  'Accessories',
];

interface InventoryViewProps {
  data: WorkspaceData;
  currency: string;
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const InventoryView: React.FC<InventoryViewProps> = ({
  data,
  currency,
  onRefresh,
  onNotify,
}) => {
  const [tab, setTab] = useState<'catalog' | 'usage' | 'movements'>('catalog');
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('All');

  // Material modal
  const [showMatModal, setShowMatModal] = useState(false);
  const [editingMat, setEditingMat] = useState<Material | null>(null);
  const [mName, setMName] = useState('');
  const [mCat, setMCat] = useState('Suit Fabric');
  const [mDesc, setMDesc] = useState('');
  const [mUnit, setMUnit] = useState('meters');
  const [mPrice, setMPrice] = useState('');
  const [mQty, setMQty] = useState('0');
  const [mMin, setMMin] = useState('5');

  // Purchase modal
  const [purchaseMat, setPurchaseMat] = useState<Material | null>(null);
  const [pQty, setPQty] = useState('');
  const [pCost, setPCost] = useState('');
  const [pNotes, setPNotes] = useState('');

  // Usage form
  const [uOrderId, setUOrderId] = useState(data.orders[0] ? String(data.orders[0].id) : '');
  const [uMatId, setUMatId] = useState(data.materials[0] ? String(data.materials[0].id) : '');
  const [uIssued, setUIssued] = useState('');
  const [uConsumed, setUConsumed] = useState('');
  const [uReturned, setUReturned] = useState('0');
  const [uWasted, setUWasted] = useState('0');
  const [uNotes, setUNotes] = useState('');

  // Settle modal
  const [settleTarget, setSettleTarget] = useState<MaterialUsageRecord | null>(null);
  const [sConsumed, setSConsumed] = useState('');
  const [sReturned, setSReturned] = useState('0');
  const [sWasted, setSWasted] = useState('0');
  const [sNotes, setSNotes] = useState('');

  const filteredMaterials = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.materials.filter((m) => {
      if (catFilter !== 'All' && m.category !== catFilter) return false;
      if (q) {
        return (
          m.name.toLowerCase().includes(q) ||
          m.sku.toLowerCase().includes(q) ||
          m.category.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [data.materials, search, catFilter]);

  const lowStockCount = data.materials.filter((m) => Number(m.current_qty) <= Number(m.min_stock_level)).length;

  const openMaterialModal = (m?: Material) => {
    if (m) {
      setEditingMat(m);
      setMName(m.name);
      setMCat(m.category);
      setMDesc(m.description || '');
      setMUnit(m.unit);
      setMPrice(String(m.purchase_price));
      setMQty(String(m.current_qty));
      setMMin(String(m.min_stock_level));
    } else {
      setEditingMat(null);
      setMName('');
      setMCat('Suit Fabric');
      setMDesc('');
      setMUnit('meters');
      setMPrice('');
      setMQty('0');
      setMMin('5');
    }
    setShowMatModal(true);
  };

  const handleSaveMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingMat) {
        await apiRequest(`/api/materials/${editingMat.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: mName,
            category: mCat,
            description: mDesc,
            unit: mUnit,
            purchasePrice: Number(mPrice || 0),
            minStockLevel: Number(mMin || 5),
          }),
        });
      } else {
        await apiRequest('/api/materials', {
          method: 'POST',
          body: JSON.stringify({
            name: mName,
            category: mCat,
            description: mDesc,
            unit: mUnit,
            purchasePrice: Number(mPrice || 0),
            currentQty: Number(mQty || 0),
            minStockLevel: Number(mMin || 5),
          }),
        });
      }
      await onRefresh();
      setShowMatModal(false);
      onNotify(editingMat ? 'Material updated.' : 'Material registered.', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save material.', 'error');
    }
  };

  const handleRecordPurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!purchaseMat) return;
    try {
      await apiRequest(`/api/materials/${purchaseMat.id}/purchase`, {
        method: 'POST',
        body: JSON.stringify({
          qty: Number(pQty),
          unitCost: Number(pCost),
          notes: pNotes,
        }),
      });
      await onRefresh();
      setPurchaseMat(null);
      onNotify('Stock purchase recorded and unit valuation updated.', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to record purchase.', 'error');
    }
  };

  const handleRecordUsage = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const order = data.orders.find((o) => String(o.id) === uOrderId);
      const material = data.materials.find((m) => String(m.id) === uMatId);
      if (!order) throw new Error('Select a tailoring order.');
      if (!material) throw new Error('Select a material.');

      const issued = Number(uIssued || 0);
      const consumed = Number(uConsumed || 0);
      const returned = Number(uReturned || 0);
      const wasted = Number(uWasted || 0);

      if (issued <= 0) throw new Error('Issued quantity must be greater than zero.');
      if (consumed < 0 || returned < 0 || wasted < 0) throw new Error('Quantities cannot be negative.');
      if (consumed + returned + wasted > issued) {
        throw new Error('Consumed + returned + wasted cannot exceed issued quantity.');
      }
      if (Number(material.current_qty) < issued) {
        throw new Error(`Insufficient stock (${material.current_qty} ${material.unit} available).`);
      }

      const clientUuid = generateUuid();
      await apiRequest('/api/material-usage', {
        method: 'POST',
        body: JSON.stringify({
          orderId: order.id,
          materialId: material.id,
          issuedQty: issued,
          consumedQty: consumed,
          returnedQty: returned,
          wastedQty: wasted,
          notes: uNotes,
          clientUuid,
        }),
      });
      await onRefresh();
      onNotify('Material usage recorded and stock updated.', 'success');

      setUIssued('');
      setUConsumed('');
      setUReturned('0');
      setUWasted('0');
      setUNotes('');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to record material usage.', 'error');
    }
  };

  const handleSettle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settleTarget) return;
    try {
      await apiRequest(`/api/material-usage/${settleTarget.id}/settle`, {
        method: 'POST',
        body: JSON.stringify({
          consumedQty: Number(sConsumed || 0),
          returnedQty: Number(sReturned || 0),
          wastedQty: Number(sWasted || 0),
          notes: sNotes,
        }),
      });
      await onRefresh();
      setSettleTarget(null);
      onNotify('Material consumption, returns, and wastage settled accurately.', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to settle issuance.', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900">Inventory Management</h1>
          <p className="text-sm text-slate-500">
            Track fabrics, notions, stock purchases, workshop issuances, actual consumption, returns, and wastage.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-slate-200/70 p-1 rounded-lg">
            {[
              { id: 'catalog', label: 'Materials Stock' },
              { id: 'usage', label: 'Material Usage & Consumption' },
              { id: 'movements', label: 'Stock Movements' },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id as typeof tab)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
                  tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === 'catalog' && (
            <button
              type="button"
              onClick={() => openMaterialModal()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-teal-800 whitespace-nowrap"
            >
              <Plus className="h-4 w-4" />
              Add Material
            </button>
          )}
        </div>
      </div>

      {lowStockCount > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-800 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            <strong>Low Stock Alert:</strong> {lowStockCount} material{lowStockCount === 1 ? ' is' : 's are'} at or below minimum stock levels.
          </span>
        </div>
      )}

      {tab === 'catalog' && (
        <>
          <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col md:flex-row gap-3 justify-between">
            <div className="relative flex-1 max-w-md">
              <Search className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search SKU, material name, or category..."
                className="w-full rounded-lg border border-slate-300 pl-10 pr-3.5 py-2 text-sm focus:border-teal-600 focus:outline-none"
              />
            </div>
            <select
              value={catFilter}
              onChange={(e) => setCatFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="All">All Categories</option>
              {MATERIAL_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            {filteredMaterials.length === 0 ? (
              <div className="p-10 text-center">
                <Boxes className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                <p className="text-sm font-medium text-slate-700">No materials registered yet</p>
                <p className="text-xs text-slate-500 mt-1">Register your fabrics, linings, buttons, and threads to manage stock.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4">SKU</th>
                      <th className="py-3 px-4">Material</th>
                      <th className="py-3 px-4">Category</th>
                      <th className="py-3 px-4 text-right">Available</th>
                      <th className="py-3 px-4 text-right">In Workshop</th>
                      <th className="py-3 px-4 text-right">Min Level</th>
                      <th className="py-3 px-4 text-right">Unit Cost</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredMaterials.map((m) => {
                      const isLow = Number(m.current_qty) <= Number(m.min_stock_level);
                      return (
                        <tr key={m.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4 font-mono text-xs text-slate-600">{m.sku}</td>
                          <td className="py-3 px-4">
                            <p className="font-medium text-slate-900">{m.name}</p>
                            {m.description && <p className="text-xs text-slate-500">{m.description}</p>}
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-600">{m.category}</td>
                          <td className={`py-3 px-4 text-right font-mono text-xs font-bold tabular-nums ${isLow ? 'text-red-600' : 'text-slate-900'}`}>
                            {m.current_qty} {m.unit}
                            {isLow && <span className="block font-sans text-[10px] font-semibold">Low Stock</span>}
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-xs text-slate-600 tabular-nums">
                            {m.reserved_qty} {m.unit}
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-xs text-slate-500 tabular-nums">
                            {m.min_stock_level} {m.unit}
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-xs text-slate-800 tabular-nums">
                            {formatMoney(m.purchase_price, currency)}
                          </td>
                          <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => {
                                setPurchaseMat(m);
                                setPQty('');
                                setPCost(String(m.purchase_price));
                                setPNotes('');
                              }}
                              className="inline-flex items-center gap-1 rounded border border-teal-200 bg-teal-50 px-2.5 py-1 text-xs font-semibold text-teal-800 hover:bg-teal-100"
                            >
                              <PackagePlus className="h-3 w-3" />
                              Purchase
                            </button>
                            <button
                              type="button"
                              onClick={() => openMaterialModal(m)}
                              className="inline-flex items-center gap-1 rounded border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                            >
                              <Edit2 className="h-3 w-3" />
                              Edit
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'usage' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Issue / Record Actual Usage Form */}
          <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 space-y-4 self-start">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900">
                Record Material Issuance & Consumption
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Issue materials to an order now, or log issued + consumed + returned + wasted quantities together. Actual cost is valued strictly from recorded consumption & wastage.
              </p>
            </div>
            <form onSubmit={handleRecordUsage} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Tailoring Order *</label>
                <select
                  required
                  value={uOrderId}
                  onChange={(e) => setUOrderId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">Select order...</option>
                  {data.orders.filter((o) => o.status !== 'Cancelled').map((o) => (
                    <option key={o.id} value={String(o.id)}>
                      {o.order_number} — {o.customer_name} ({o.garment_type})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Material *</label>
                <select
                  required
                  value={uMatId}
                  onChange={(e) => setUMatId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">Select material...</option>
                  {data.materials.map((m) => (
                    <option key={m.id} value={String(m.id)}>
                      {m.name} ({m.current_qty} {m.unit} avail. · {formatMoney(m.purchase_price, currency)})
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Issued Qty *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={uIssued}
                    onChange={(e) => setUIssued(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Actual Consumed</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={uConsumed}
                    onChange={(e) => setUConsumed(e.target.value)}
                    placeholder="0 (if settling later)"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Unused Returned</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={uReturned}
                    onChange={(e) => setUReturned(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Wasted / Damaged</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={uWasted}
                    onChange={(e) => setUWasted(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Notes</label>
                <input
                  value={uNotes}
                  onChange={(e) => setUNotes(e.target.value)}
                  placeholder="Cutting batch or wastage reason..."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <button
                type="submit"
                className="w-full rounded-lg bg-teal-700 px-4 py-2.5 text-xs font-semibold text-white hover:bg-teal-800"
              >
                Record Material Usage
              </button>
            </form>
          </div>

          {/* Usage Records History */}
          <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-slate-900">Production Usage Records</h2>
              <span className="text-xs text-slate-500">Zero double-counting on returns</span>
            </div>
            {data.usageRecords.length === 0 ? (
              <div className="p-10 text-center text-xs text-slate-500">No material usage recorded yet.</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {data.usageRecords.map((u) => {
                  const accounted = Number(u.consumed_qty) + Number(u.returned_qty) + Number(u.wasted_qty);
                  const unsettled = Math.max(0, Number(u.issued_qty) - accounted);
                  return (
                    <div key={u.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="space-y-1 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-slate-900">{u.order_number}</span>
                          <span className="text-slate-400">·</span>
                          <span className="font-semibold text-slate-800">{u.material_name}</span>
                          <span className="text-slate-400">·</span>
                          <span className={`font-semibold ${u.status === 'Settled' ? 'text-teal-700' : 'text-amber-700'}`}>
                            {u.status}
                          </span>
                        </div>
                        <p className="font-mono text-slate-600 tabular-nums">
                          Issued: {u.issued_qty} · Consumed: {u.consumed_qty} · Returned: {u.returned_qty} · Wasted: {u.wasted_qty} {u.material_unit}
                        </p>
                        <p className="text-slate-500">
                          Actual Material Cost: <strong className="font-mono text-slate-900">{formatMoney(u.actual_cost, currency)}</strong>
                        </p>
                      </div>
                      {unsettled > 0.001 && u.id > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setSettleTarget(u);
                            setSConsumed(String(unsettled));
                            setSReturned('0');
                            setSWasted('0');
                            setSNotes('');
                          }}
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 shrink-0"
                        >
                          Settle Usage ({unsettled} {u.material_unit} left)
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'movements' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600 font-semibold">
                <th className="py-3 px-4">Date</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4">Material</th>
                <th className="py-3 px-4">Order</th>
                <th className="py-3 px-4 text-right">Quantity</th>
                <th className="py-3 px-4 text-right">Total Value</th>
                <th className="py-3 px-4">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.inventoryTransactions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">No inventory movements recorded yet.</td>
                </tr>
              ) : (
                data.inventoryTransactions.map((tx) => (
                  <tr key={tx.id}>
                    <td className="py-2.5 px-4 font-mono text-slate-600">{formatDate(tx.created_at)}</td>
                    <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">{tx.tx_type}</td>
                    <td className="py-2.5 px-4 font-medium text-slate-800">{tx.material_name}</td>
                    <td className="py-2.5 px-4 font-mono text-slate-600">{tx.order_number || '—'}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">{tx.qty} {tx.material_unit}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">{formatMoney(tx.total_cost, currency)}</td>
                    <td className="py-2.5 px-4 text-slate-500">{tx.notes}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Material Register / Edit Modal */}
      {showMatModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-base font-bold text-slate-900">
                {editingMat ? 'Edit Material' : 'Register New Material'}
              </h2>
              <button type="button" onClick={() => setShowMatModal(false)} className="text-slate-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleSaveMaterial} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Material Name *</label>
                <input required value={mName} onChange={(e) => setMName(e.target.value)} placeholder="Super 120s Charcoal Wool" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Category *</label>
                  <select value={mCat} onChange={(e) => setMCat(e.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
                    {MATERIAL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Unit *</label>
                  <select value={mUnit} onChange={(e) => setMUnit(e.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
                    {['meters', 'yards', 'spools', 'pieces', 'rolls'].map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Unit Cost ({currency})</label>
                  <input type="number" step="0.01" min="0" required value={mPrice} onChange={(e) => setMPrice(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono" />
                </div>
                {!editingMat && (
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Opening Qty</label>
                    <input type="number" step="0.01" min="0" required value={mQty} onChange={(e) => setMQty(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono" />
                  </div>
                )}
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Min Stock Level</label>
                  <input type="number" step="0.01" min="0" required value={mMin} onChange={(e) => setMMin(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono" />
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Description</label>
                <input value={mDesc} onChange={(e) => setMDesc(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowMatModal(false)} className="rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-700">Cancel</button>
                <button type="submit" className="rounded-lg bg-teal-700 px-4 py-2 font-semibold text-white hover:bg-teal-800">Save Material</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Purchase Modal */}
      {purchaseMat && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-base font-bold text-slate-900">Record Material Purchase</h2>
              <button type="button" onClick={() => setPurchaseMat(null)} className="text-slate-400"><X className="h-5 w-5" /></button>
            </div>
            <p className="text-xs text-slate-600 mb-3"><strong>{purchaseMat.name}</strong> ({purchaseMat.unit})</p>
            <form onSubmit={handleRecordPurchase} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Purchased Quantity ({purchaseMat.unit}) *</label>
                <input type="number" step="0.01" min="0.01" required value={pQty} onChange={(e) => setPQty(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono" />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Purchase Unit Cost ({currency}) *</label>
                <input type="number" step="0.01" min="0" required value={pCost} onChange={(e) => setPCost(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono" />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Supplier / Invoice Notes</label>
                <input value={pNotes} onChange={(e) => setPNotes(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setPurchaseMat(null)} className="rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-700">Cancel</button>
                <button type="submit" className="rounded-lg bg-teal-700 px-4 py-2 font-semibold text-white hover:bg-teal-800">Add to Stock</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Settle Issuance Modal */}
      {settleTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display text-base font-bold text-slate-900">Settle Workshop Issuance</h2>
              <button type="button" onClick={() => setSettleTarget(null)} className="text-slate-400"><X className="h-5 w-5" /></button>
            </div>
            <p className="text-xs text-slate-600 mb-4">
              {settleTarget.order_number} · {settleTarget.material_name} (Issued: {settleTarget.issued_qty} {settleTarget.material_unit})
            </p>
            <form onSubmit={handleSettle} className="space-y-3 text-xs">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Consumed</label>
                  <input type="number" step="0.01" min="0" required value={sConsumed} onChange={(e) => setSConsumed(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm font-mono" />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Returned</label>
                  <input type="number" step="0.01" min="0" required value={sReturned} onChange={(e) => setSReturned(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm font-mono" />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Wasted</label>
                  <input type="number" step="0.01" min="0" required value={sWasted} onChange={(e) => setSWasted(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm font-mono" />
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Notes</label>
                <input value={sNotes} onChange={(e) => setSNotes(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setSettleTarget(null)} className="rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-700">Cancel</button>
                <button type="submit" className="rounded-lg bg-teal-700 px-4 py-2 font-semibold text-white hover:bg-teal-800">Confirm Settlement</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
