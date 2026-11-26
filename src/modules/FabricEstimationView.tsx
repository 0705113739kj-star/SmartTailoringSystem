import React, { useState } from 'react';
import { AlertCircle, Calculator, Check, Edit2, Plus, Settings2, X } from 'lucide-react';
import { apiRequest, formatDate, formatMoney, generateUuid } from '../lib/api';
import type { EstimationItem, EstimationRule, WorkspaceData } from '../types';

interface FabricEstimationViewProps {
  data: WorkspaceData;
  currency: string;
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const FabricEstimationView: React.FC<FabricEstimationViewProps> = ({
  data,
  currency,
  onRefresh,
  onNotify,
}) => {
  const [tab, setTab] = useState<'estimate' | 'saved' | 'rules'>('estimate');
  const [orderId, setOrderId] = useState<string>(data.orders[0] ? String(data.orders[0].id) : '');
  const [ruleId, setRuleId] = useState<string>('');
  const [fabricWidthCm, setFabricWidthCm] = useState<string>('150');
  const [allowancePercent, setAllowancePercent] = useState<string>('10');
  const [mainFabricId, setMainFabricId] = useState<string>('');
  const [liningMatId, setLiningMatId] = useState<string>('');
  const [interfacingMatId, setInterfacingMatId] = useState<string>('');
  const [estNotes, setEstNotes] = useState<string>('');

  const [calculatedItems, setCalculatedItems] = useState<EstimationItem[] | null>(null);
  const [measurementFactor, setMeasurementFactor] = useState<number>(1);
  const [saving, setSaving] = useState(false);

  // Rule Editor Modal
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [editingRule, setEditingRule] = useState<EstimationRule | null>(null);
  const [rGarment, setRGarment] = useState('Jacket');
  const [rStyle, setRStyle] = useState('Standard');
  const [rBaseMeters, setRBaseMeters] = useState('2.0');
  const [rWidth, setRWidth] = useState('150');
  const [rAllowance, setRAllowance] = useState('10');
  const [rLiningRatio, setRLiningRatio] = useState('0.75');
  const [rInterfacing, setRInterfacing] = useState('0.5');
  const [rThread, setRThread] = useState('1');
  const [rButtons, setRButtons] = useState('4');
  const [rZippers, setRZippers] = useState('0');
  const [rNotes, setRNotes] = useState('');

  const calculateLocally = () => {
    const order = data.orders.find((o) => String(o.id) === orderId);
    if (!order) {
      onNotify('Select a tailoring order first.', 'error');
      return;
    }
    const rule = ruleId
      ? data.estimationRules.find((r) => String(r.id) === ruleId)
      : data.estimationRules.find((r) => r.garment_type.toLowerCase() === order.garment_type.toLowerCase());

    const measurement = order.measurement_id
      ? data.measurements.find((m) => m.id === order.measurement_id)
      : null;

    let factor = 1.0;
    if (measurement?.values_json) {
      try {
        const vals = JSON.parse(measurement.values_json) as Record<string, number>;
        const toCm = (v: number) => (measurement.unit === 'in' ? v * 2.54 : v);
        const chest = vals.chest || vals.bust || 0;
        const waist = vals.waist || 0;
        const length = vals.jacket_length || vals.dress_length || vals.trouser_length || 0;
        if (chest > 0) {
          const cCm = toCm(Number(chest));
          if (cCm > 104) factor += Math.min(0.35, (cCm - 104) * 0.008);
          else if (cCm < 92) factor -= Math.min(0.12, (92 - cCm) * 0.005);
        }
        if (waist > 0) {
          const wCm = toCm(Number(waist));
          if (wCm > 92) factor += Math.min(0.25, (wCm - 92) * 0.006);
        }
        if (length > 0) {
          const lCm = toCm(Number(length));
          if (lCm > 110) factor += Math.min(0.3, (lCm - 110) * 0.006);
        }
      } catch {
        // default factor
      }
    }

    const baseMeters = Number(rule?.base_fabric_meters || 2.0);
    const ruleWidth = Number(rule?.fabric_width_cm || 150);
    const widthCm = Math.max(80, Number(fabricWidthCm || ruleWidth));
    const allowance = Math.max(0, Number(allowancePercent || rule?.allowance_percent || 10));
    const qty = Math.max(1, Number(order.quantity || 1));
    const r2 = (n: number) => Math.round(n * 100) / 100;

    const estFabric = r2(baseMeters * factor * (ruleWidth / widthCm) * (1 + allowance / 100) * qty);
    const estLining = r2(estFabric * Number(rule?.lining_ratio ?? 0.75));
    const estInterfacing = r2(Number(rule?.interfacing_meters ?? 0.5) * qty * (1 + allowance / 100));
    const estThread = Math.ceil(Number(rule?.thread_spools ?? 1) * qty);
    const estButtons = Math.ceil(Number(rule?.buttons_count ?? 0) * qty);
    const estZippers = Math.ceil(Number(rule?.zippers_count ?? 0) * qty);

    const findMat = (idStr: string, cats: string[]) => {
      if (idStr) {
        const m = data.materials.find((mat) => String(mat.id) === idStr);
        if (m) return m;
      }
      return data.materials.find((mat) => cats.includes(mat.category));
    };

    const mkItem = (label: string, cat: string, estQty: number, defUnit: string, mat?: WorkspaceData['materials'][number]): EstimationItem => {
      const avail = mat ? Number(mat.current_qty) : 0;
      const unitCost = mat ? Number(mat.purchase_price) : 0;
      return {
        materialId: mat?.id || null,
        materialName: mat?.name || label,
        category: cat,
        estimatedQty: estQty,
        unit: mat?.unit || defUnit,
        availableQty: avail,
        shortageQty: r2(Math.max(0, estQty - avail)),
        estimatedUnitCost: unitCost,
        estimatedTotalCost: r2(estQty * unitCost),
      };
    };

    const items: EstimationItem[] = [
      mkItem('Primary Fabric', 'Suit Fabric', estFabric, 'meters', findMat(mainFabricId, ['Suit Fabric', 'Dress Fabric'])),
      ...(estLining > 0 ? [mkItem('Lining Fabric', 'Lining', estLining, 'meters', findMat(liningMatId, ['Lining']))] : []),
      ...(estInterfacing > 0 ? [mkItem('Interfacing', 'Interfacing', estInterfacing, 'meters', findMat(interfacingMatId, ['Interfacing']))] : []),
      ...(estThread > 0 ? [mkItem('Sewing Thread', 'Thread', estThread, 'spools', findMat('', ['Thread']))] : []),
      ...(estButtons > 0 ? [mkItem('Buttons', 'Buttons', estButtons, 'pieces', findMat('', ['Buttons']))] : []),
      ...(estZippers > 0 ? [mkItem('Zipper', 'Zippers', estZippers, 'pieces', findMat('', ['Zippers']))] : []),
    ];

    setMeasurementFactor(r2(factor));
    setCalculatedItems(items);
  };

  const handleCalculate = async () => {
    if (!orderId) {
      onNotify('Select a tailoring order first.', 'error');
      return;
    }
    try {
      const res = await apiRequest<{
        calculation: {
          measurementFactor: number;
          items: EstimationItem[];
        };
      }>('/api/estimations/calculate', {
        method: 'POST',
        body: JSON.stringify({
          orderId: Number(orderId),
          ruleId: ruleId ? Number(ruleId) : null,
          fabricWidthCm: Number(fabricWidthCm || 150),
          allowancePercent: Number(allowancePercent || 10),
          mainFabricMaterialId: mainFabricId ? Number(mainFabricId) : null,
          liningMaterialId: liningMatId ? Number(liningMatId) : null,
          interfacingMaterialId: interfacingMatId ? Number(interfacingMatId) : null,
        }),
      });
      setMeasurementFactor(res.calculation.measurementFactor);
      setCalculatedItems(res.calculation.items);
      return;
    } catch {
      calculateLocally();
    }
  };

  const updateItemField = (idx: number, field: 'estimatedQty' | 'estimatedUnitCost', val: number) => {
    if (!calculatedItems) return;
    setCalculatedItems(
      calculatedItems.map((item, i) => {
        if (i !== idx) return item;
        const nextQty = field === 'estimatedQty' ? Math.max(0, val) : item.estimatedQty;
        const nextCost = field === 'estimatedUnitCost' ? Math.max(0, val) : item.estimatedUnitCost;
        return {
          ...item,
          estimatedQty: nextQty,
          estimatedUnitCost: nextCost,
          shortageQty: Math.round(Math.max(0, nextQty - item.availableQty) * 100) / 100,
          estimatedTotalCost: Math.round(nextQty * nextCost * 100) / 100,
        };
      })
    );
  };

  const handleSaveEstimation = async () => {
    if (!orderId || !calculatedItems || calculatedItems.length === 0) return;
    setSaving(true);
    try {
      const clientUuid = generateUuid();
      await apiRequest('/api/estimations', {
        method: 'POST',
        body: JSON.stringify({
          orderId: Number(orderId),
          ruleId: ruleId ? Number(ruleId) : null,
          fabricWidthCm: Number(fabricWidthCm || 150),
          allowancePercent: Number(allowancePercent || 10),
          items: calculatedItems,
          notes: estNotes,
          clientUuid,
        }),
      });
      await onRefresh();
      onNotify('Fabric estimation saved to order (stock unchanged).', 'success');
      setTab('saved');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save estimation.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const openRuleModal = (rule?: EstimationRule) => {
    if (rule) {
      setEditingRule(rule);
      setRGarment(rule.garment_type);
      setRStyle(rule.design_style);
      setRBaseMeters(String(rule.base_fabric_meters));
      setRWidth(String(rule.fabric_width_cm));
      setRAllowance(String(rule.allowance_percent));
      setRLiningRatio(String(rule.lining_ratio));
      setRInterfacing(String(rule.interfacing_meters));
      setRThread(String(rule.thread_spools));
      setRButtons(String(rule.buttons_count));
      setRZippers(String(rule.zippers_count));
      setRNotes(rule.notes || '');
    } else {
      setEditingRule(null);
      setRGarment('Coat');
      setRStyle('Classic Tailored');
      setRBaseMeters('2.5');
      setRWidth('150');
      setRAllowance('10');
      setRLiningRatio('0.8');
      setRInterfacing('0.6');
      setRThread('1');
      setRButtons('4');
      setRZippers('0');
      setRNotes('');
    }
    setShowRuleModal(true);
  };

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = {
        garmentType: rGarment,
        designStyle: rStyle,
        baseFabricMeters: Number(rBaseMeters),
        fabricWidthCm: Number(rWidth),
        allowancePercent: Number(rAllowance),
        liningRatio: Number(rLiningRatio),
        interfacingMeters: Number(rInterfacing),
        threadSpools: Number(rThread),
        buttonsCount: Number(rButtons),
        zippersCount: Number(rZippers),
        notes: rNotes,
      };
      if (editingRule) {
        await apiRequest(`/api/estimation-rules/${editingRule.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await apiRequest('/api/estimation-rules', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      await onRefresh();
      setShowRuleModal(false);
      onNotify('Estimation rule saved.', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save rule.', 'error');
    }
  };

  const totalEstCost = calculatedItems
    ? calculatedItems.reduce((s, it) => s + it.estimatedTotalCost, 0)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900">Fabric Estimation</h1>
          <p className="text-sm text-slate-500">
            Pre-production material planning using configurable rules, measurements, fabric width, and stock availability.
          </p>
        </div>
        <div className="flex items-center gap-1 bg-slate-200/70 p-1 rounded-lg self-start sm:self-auto">
          {[
            { id: 'estimate', label: 'Estimate Order' },
            { id: 'saved', label: `Saved Estimates (${data.estimations.length})` },
            { id: 'rules', label: 'Estimation Rules' },
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
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-100/70 px-4 py-2.5 text-xs text-slate-700 flex items-center gap-2">
        <AlertCircle className="h-4 w-4 text-teal-700 shrink-0" />
        <span>
          <strong>Planning Notice:</strong> Fabric estimates forecast requirements and potential stock shortages before cutting. They never deduct inventory or count as actual production consumption.
        </span>
      </div>

      {tab === 'estimate' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Parameters Panel */}
          <div className="lg:col-span-4 rounded-xl border border-slate-200 bg-white p-5 space-y-4 self-start">
            <h2 className="font-display text-sm font-semibold text-slate-900">Estimation Parameters</h2>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Tailoring Order *</label>
              <select
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">Select order...</option>
                {data.orders.filter((o) => o.status !== 'Cancelled').map((o) => (
                  <option key={o.id} value={String(o.id)}>
                    {o.order_number} — {o.customer_name} ({o.garment_type} ×{o.quantity})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Estimation Rule</label>
              <select
                value={ruleId}
                onChange={(e) => setRuleId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">Auto-match by Garment Type</option>
                {data.estimationRules.map((r) => (
                  <option key={r.id} value={String(r.id)}>
                    {r.garment_type} — {r.design_style} ({r.base_fabric_meters}m base)
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Fabric Width (cm)</label>
                <input
                  type="number"
                  min="80"
                  value={fabricWidthCm}
                  onChange={(e) => setFabricWidthCm(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Allowance (%)</label>
                <input
                  type="number"
                  min="0"
                  max="50"
                  value={allowancePercent}
                  onChange={(e) => setAllowancePercent(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Primary Fabric Stock Item</label>
              <select
                value={mainFabricId}
                onChange={(e) => setMainFabricId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
              >
                <option value="">Auto-select from inventory</option>
                {data.materials.filter((m) => m.category.includes('Fabric')).map((m) => (
                  <option key={m.id} value={String(m.id)}>
                    {m.name} ({m.current_qty} {m.unit} avail.)
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Lining Item</label>
                <select
                  value={liningMatId}
                  onChange={(e) => setLiningMatId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs"
                >
                  <option value="">Auto-match</option>
                  {data.materials.filter((m) => m.category === 'Lining').map((m) => (
                    <option key={m.id} value={String(m.id)}>{m.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Interfacing Item</label>
                <select
                  value={interfacingMatId}
                  onChange={(e) => setInterfacingMatId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs"
                >
                  <option value="">Auto-match</option>
                  {data.materials.filter((m) => m.category === 'Interfacing').map((m) => (
                    <option key={m.id} value={String(m.id)}>{m.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <button
              type="button"
              onClick={handleCalculate}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-800"
            >
              <Calculator className="h-4 w-4" />
              Calculate Material Requirements
            </button>
          </div>

          {/* Results & Shortage Table */}
          <div className="lg:col-span-8 rounded-xl border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-900">
                  Estimated Bill of Materials
                </h2>
                <p className="text-xs text-slate-500">
                  Measurement sizing factor: <span className="font-mono font-semibold">{measurementFactor}×</span> · Adjust quantities or costs before saving.
                </p>
              </div>
              {calculatedItems && (
                <div className="text-right">
                  <span className="text-xs text-slate-500 block">Total Estimated Material Cost</span>
                  <span className="font-mono text-base font-bold text-teal-700 tabular-nums">
                    {formatMoney(totalEstCost, currency)}
                  </span>
                </div>
              )}
            </div>

            {!calculatedItems ? (
              <div className="py-14 text-center border border-dashed border-slate-200 rounded-lg">
                <Calculator className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                <p className="text-sm font-medium text-slate-700">No estimation calculated yet</p>
                <p className="text-xs text-slate-500 mt-1">Select an order and click "Calculate Material Requirements".</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-slate-600 font-semibold">
                        <th className="py-2.5 px-3">Material</th>
                        <th className="py-2.5 px-3 text-right">Est. Qty</th>
                        <th className="py-2.5 px-3 text-right">In Stock</th>
                        <th className="py-2.5 px-3 text-right">Shortage</th>
                        <th className="py-2.5 px-3 text-right">Est. Unit Cost</th>
                        <th className="py-2.5 px-3 text-right">Est. Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {calculatedItems.map((item, idx) => (
                        <tr key={idx}>
                          <td className="py-2.5 px-3">
                            <p className="font-semibold text-slate-900">{item.materialName}</p>
                            <p className="text-[11px] text-slate-500">{item.category} ({item.unit})</p>
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={item.estimatedQty}
                              onChange={(e) => updateItemField(idx, 'estimatedQty', Number(e.target.value))}
                              className="w-20 rounded border border-slate-300 px-2 py-1 text-right font-mono tabular-nums"
                            />
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                            {item.availableQty} {item.unit}
                          </td>
                          <td className={`py-2.5 px-3 text-right font-mono font-semibold tabular-nums ${item.shortageQty > 0 ? 'text-red-600' : 'text-teal-700'}`}>
                            {item.shortageQty > 0 ? `${item.shortageQty} ${item.unit}` : 'In Stock'}
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={item.estimatedUnitCost}
                              onChange={(e) => updateItemField(idx, 'estimatedUnitCost', Number(e.target.value))}
                              className="w-24 rounded border border-slate-300 px-2 py-1 text-right font-mono tabular-nums"
                            />
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono font-semibold text-slate-900 tabular-nums">
                            {formatMoney(item.estimatedTotalCost, currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between pt-2">
                  <input
                    type="text"
                    value={estNotes}
                    onChange={(e) => setEstNotes(e.target.value)}
                    placeholder="Optional estimation notes (e.g., pattern matching allowance)..."
                    className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  />
                  <button
                    type="button"
                    disabled={saving}
                    onClick={handleSaveEstimation}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-60 whitespace-nowrap"
                  >
                    <Check className="h-4 w-4" />
                    {saving ? 'Saving...' : 'Save Estimation to Order'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'saved' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          {data.estimations.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">No fabric estimations saved yet.</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {data.estimations.map((est) => {
                const items = JSON.parse(est.items_json || '[]') as EstimationItem[];
                return (
                  <div key={est.id} className="p-4 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm">
                        <span className="font-mono font-bold text-slate-900">{est.order_number}</span>
                        <span className="text-slate-400"> · </span>
                        <span className="font-medium text-slate-800">{est.customer_name}</span>
                        <span className="text-slate-400"> · </span>
                        <span className="text-xs text-slate-500">
                          Width {est.fabric_width_cm}cm · Allowance {est.allowance_percent}% · {formatDate(est.created_at)}
                        </span>
                      </div>
                      <span className="font-mono text-sm font-bold text-teal-700 tabular-nums">
                        Est. {formatMoney(est.total_estimated_cost, currency)}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs text-slate-600 font-mono">
                      {items.map((it, i) => (
                        <span key={i} className="bg-slate-50 border border-slate-200 rounded px-2 py-1">
                          {it.materialName}: {it.estimatedQty} {it.unit}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'rules' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => openRuleModal()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-teal-800"
            >
              <Plus className="h-4 w-4" />
              Add Estimation Rule
            </button>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600 font-semibold">
                  <th className="py-3 px-4">Garment</th>
                  <th className="py-3 px-4">Design Style</th>
                  <th className="py-3 px-4 text-right">Base Fabric</th>
                  <th className="py-3 px-4 text-right">Ref Width</th>
                  <th className="py-3 px-4 text-right">Allowance</th>
                  <th className="py-3 px-4 text-right">Lining Ratio</th>
                  <th className="py-3 px-4 text-right">Interfacing</th>
                  <th className="py-3 px-4 text-right">Notions</th>
                  <th className="py-3 px-4 text-right">Edit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.estimationRules.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="py-3 px-4 font-semibold text-slate-900">{r.garment_type}</td>
                    <td className="py-3 px-4 text-slate-600">{r.design_style}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{r.base_fabric_meters} m</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{r.fabric_width_cm} cm</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{r.allowance_percent}%</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{r.lining_ratio}×</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{r.interfacing_meters} m</td>
                    <td className="py-3 px-4 text-right font-mono text-[11px] text-slate-600">
                      {r.thread_spools} th · {r.buttons_count} btn · {r.zippers_count} zip
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => openRuleModal(r)}
                        className="inline-flex items-center gap-1 rounded border border-slate-200 px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-100"
                      >
                        <Edit2 className="h-3 w-3" />
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showRuleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-base font-bold text-slate-900 flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-teal-700" />
                {editingRule ? 'Edit Estimation Rule' : 'New Estimation Rule'}
              </h2>
              <button type="button" onClick={() => setShowRuleModal(false)} className="text-slate-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleSaveRule} className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Garment Type</label>
                  <input required value={rGarment} onChange={(e) => setRGarment(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Design Style</label>
                  <input required value={rStyle} onChange={(e) => setRStyle(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Base Fabric (m)</label>
                  <input type="number" step="0.05" required value={rBaseMeters} onChange={(e) => setRBaseMeters(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono" />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Ref Width (cm)</label>
                  <input type="number" required value={rWidth} onChange={(e) => setRWidth(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono" />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Allowance (%)</label>
                  <input type="number" step="0.5" required value={rAllowance} onChange={(e) => setRAllowance(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono" />
                </div>
              </div>
              <div className="grid grid-cols-5 gap-2">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Lining Ratio</label>
                  <input type="number" step="0.05" value={rLiningRatio} onChange={(e) => setRLiningRatio(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono" />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Interfacing (m)</label>
                  <input type="number" step="0.05" value={rInterfacing} onChange={(e) => setRInterfacing(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono" />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Thread</label>
                  <input type="number" value={rThread} onChange={(e) => setRThread(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono" />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Buttons</label>
                  <input type="number" value={rButtons} onChange={(e) => setRButtons(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono" />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Zippers</label>
                  <input type="number" value={rZippers} onChange={(e) => setRZippers(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono" />
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Notes</label>
                <input value={rNotes} onChange={(e) => setRNotes(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowRuleModal(false)} className="rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-700">Cancel</button>
                <button type="submit" className="rounded-lg bg-teal-700 px-4 py-2 font-semibold text-white hover:bg-teal-800">Save Rule</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
