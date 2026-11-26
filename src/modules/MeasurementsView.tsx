import React, { useMemo, useState } from 'react';
import { Edit2, History, Plus, Ruler, X } from 'lucide-react';
import { apiRequest, formatDate, generateUuid } from '../lib/api';
import type { Measurement, MeasurementHistoryItem, WorkspaceData } from '../types';

const GARMENT_FIELDS: Record<string, Array<{ key: string; label: string }>> = {
  Suit: [
    { key: 'chest', label: 'Chest' },
    { key: 'waist', label: 'Waist' },
    { key: 'hips', label: 'Hips / Seat' },
    { key: 'shoulder', label: 'Shoulder Width' },
    { key: 'sleeve_length', label: 'Sleeve Length' },
    { key: 'jacket_length', label: 'Jacket Length' },
    { key: 'neck', label: 'Neck' },
    { key: 'trouser_length', label: 'Trouser Outseam' },
    { key: 'inseam', label: 'Trouser Inseam' },
    { key: 'thigh', label: 'Thigh' },
    { key: 'bottom', label: 'Hem / Bottom' },
  ],
  Jacket: [
    { key: 'chest', label: 'Chest' },
    { key: 'waist', label: 'Stomach / Waist' },
    { key: 'shoulder', label: 'Shoulder Width' },
    { key: 'sleeve_length', label: 'Sleeve Length' },
    { key: 'jacket_length', label: 'Jacket Length' },
    { key: 'neck', label: 'Neck' },
    { key: 'armhole', label: 'Armhole' },
  ],
  Trouser: [
    { key: 'waist', label: 'Waist' },
    { key: 'hips', label: 'Hips / Seat' },
    { key: 'trouser_length', label: 'Outseam Length' },
    { key: 'inseam', label: 'Inseam' },
    { key: 'thigh', label: 'Thigh' },
    { key: 'knee', label: 'Knee' },
    { key: 'bottom', label: 'Hem / Bottom' },
  ],
  Shirt: [
    { key: 'neck', label: 'Collar / Neck' },
    { key: 'chest', label: 'Chest' },
    { key: 'waist', label: 'Waist' },
    { key: 'shoulder', label: 'Shoulder' },
    { key: 'sleeve_length', label: 'Sleeve Length' },
    { key: 'shirt_length', label: 'Shirt Length' },
    { key: 'cuff', label: 'Cuff' },
  ],
  Dress: [
    { key: 'bust', label: 'Bust' },
    { key: 'waist', label: 'Waist' },
    { key: 'hips', label: 'Hips' },
    { key: 'shoulder', label: 'Shoulder' },
    { key: 'bodice_length', label: 'Bodice / Half Length' },
    { key: 'sleeve_length', label: 'Sleeve Length' },
    { key: 'dress_length', label: 'Full Dress Length' },
  ],
  Skirt: [
    { key: 'waist', label: 'Waist' },
    { key: 'hips', label: 'Hips' },
    { key: 'skirt_length', label: 'Skirt Length' },
  ],
  Other: [
    { key: 'chest', label: 'Chest / Bust' },
    { key: 'waist', label: 'Waist' },
    { key: 'hips', label: 'Hips' },
    { key: 'shoulder', label: 'Shoulder' },
    { key: 'sleeve_length', label: 'Sleeve Length' },
    { key: 'garment_length', label: 'Garment Length' },
  ],
};

interface MeasurementsViewProps {
  data: WorkspaceData;
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const MeasurementsView: React.FC<MeasurementsViewProps> = ({
  data,
  onRefresh,
  onNotify,
}) => {
  const [filterCustomerId, setFilterCustomerId] = useState<string>('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Measurement | null>(null);
  const [historyTarget, setHistoryTarget] = useState<Measurement | null>(null);
  const [historyItems, setHistoryItems] = useState<MeasurementHistoryItem[]>([]);
  const [saving, setSaving] = useState(false);

  const [customerId, setCustomerId] = useState<string>('');
  const [garmentType, setGarmentType] = useState<string>('Suit');
  const [unit, setUnit] = useState<'cm' | 'in'>('cm');
  const [values, setValues] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');

  const filtered = useMemo(() => {
    if (!filterCustomerId) return data.measurements;
    return data.measurements.filter((m) => String(m.customer_id) === filterCustomerId);
  }, [data.measurements, filterCustomerId]);

  const openCreate = () => {
    setEditing(null);
    setCustomerId(filterCustomerId || (data.customers[0] ? String(data.customers[0].id) : ''));
    setGarmentType('Suit');
    setUnit('cm');
    setValues({});
    setNotes('');
    setShowModal(true);
  };

  const openEdit = (m: Measurement) => {
    setEditing(m);
    setCustomerId(String(m.customer_id));
    setGarmentType(m.garment_type);
    setUnit(m.unit === 'in' ? 'in' : 'cm');
    try {
      const parsed = JSON.parse(m.values_json) as Record<string, string | number>;
      const strObj: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) strObj[k] = String(v);
      setValues(strObj);
    } catch {
      setValues({});
    }
    setNotes(m.notes || '');
    setShowModal(true);
  };

  const openHistory = async (m: Measurement) => {
    setHistoryTarget(m);
    try {
      const res = await apiRequest<{ history: MeasurementHistoryItem[] }>(`/api/measurements/${m.id}/history`);
      setHistoryItems(res.history);
      return;
    } catch {
      // fallback to loaded history
    }
    setHistoryItems(
      data.measurementHistory
        .filter((h) => h.measurement_id === m.id)
        .sort((a, b) => b.version - a.version)
    );
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId) {
      onNotify('Please select a customer first.', 'error');
      return;
    }
    setSaving(true);
    try {
      const numericValues: Record<string, number> = {};
      for (const [k, v] of Object.entries(values)) {
        if (v !== '' && !Number.isNaN(Number(v))) {
          numericValues[k] = Number(v);
        }
      }

      if (editing) {
        await apiRequest(`/api/measurements/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify({ garmentType, unit, values: numericValues, notes }),
        });
        await onRefresh();
        onNotify('Updated measurements saved (previous version preserved in history).', 'success');
      } else {
        const clientUuid = generateUuid();
        await apiRequest('/api/measurements', {
          method: 'POST',
          body: JSON.stringify({
            customerId: Number(customerId),
            garmentType,
            unit,
            values: numericValues,
            notes,
            clientUuid,
          }),
        });
        await onRefresh();
        onNotify('Measurement record saved.', 'success');
      }
      setShowModal(false);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save measurements.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const fields = GARMENT_FIELDS[garmentType] || GARMENT_FIELDS.Other;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900">Measurements</h1>
          <p className="text-sm text-slate-500">
            Record garment-specific body measurements in centimetres with non-destructive revision history.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          disabled={data.customers.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap self-start sm:self-auto"
        >
          <Plus className="h-4 w-4" />
          Record Measurements
        </button>
      </div>

      {/* Customer Filter */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-wrap items-center gap-3">
        <label className="text-xs font-medium text-slate-600">Filter by Customer:</label>
        <select
          value={filterCustomerId}
          onChange={(e) => setFilterCustomerId(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 focus:border-teal-600 focus:outline-none"
        >
          <option value="">All Customers</option>
          {data.customers.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.customer_number} — {c.full_name}
            </option>
          ))}
        </select>
      </div>

      {/* Measurement Cards Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-10 text-center">
            <Ruler className="h-8 w-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-slate-700">No measurement records yet</p>
            <p className="text-xs text-slate-500 mt-1">
              {data.customers.length === 0
                ? 'Register a customer first before recording measurements.'
                : 'Click "Record Measurements" to capture body measurements.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filtered.map((m) => {
              let parsed: Record<string, number> = {};
              try {
                parsed = JSON.parse(m.values_json);
              } catch {
                parsed = {};
              }
              return (
                <div key={m.id} className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-slate-50/70">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-semibold text-slate-900">{m.customer_name}</span>
                      <span className="text-slate-400">·</span>
                      <span className="font-medium text-teal-700">{m.garment_type}</span>
                      <span className="text-slate-400">·</span>
                      <span className="font-mono text-xs text-slate-500">v{m.version} ({m.unit})</span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                      {Object.entries(parsed).map(([k, v]) => (
                        <span key={k} className="font-mono tabular-nums">
                          <span className="text-slate-400 capitalize">{k.replace(/_/g, ' ')}:</span>{' '}
                          <strong className="text-slate-800">{v}{m.unit}</strong>
                        </span>
                      ))}
                    </div>
                    {m.notes && <p className="text-xs text-slate-500">Note: {m.notes}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => openHistory(m)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      <History className="h-3.5 w-3.5" />
                      History
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(m)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                      Update
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Record / Update Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto">
          <div className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-6 shadow-xl my-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-bold text-slate-900">
                {editing ? `Update ${editing.garment_type} Measurements (v${editing.version + 1})` : 'Record Customer Measurements'}
              </h2>
              <button type="button" onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleSave} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Customer *</label>
                  <select
                    required
                    disabled={!!editing}
                    value={customerId}
                    onChange={(e) => setCustomerId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100"
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
                  <label className="block text-xs font-medium text-slate-700 mb-1">Garment Type *</label>
                  <select
                    value={garmentType}
                    onChange={(e) => setGarmentType(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    {Object.keys(GARMENT_FIELDS).map((g) => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                <span className="text-xs font-medium text-slate-700">Measurement Unit (cm default)</span>
                <div className="flex gap-1">
                  {(['cm', 'in'] as const).map((u) => (
                    <button
                      key={u}
                      type="button"
                      onClick={() => setUnit(u)}
                      className={`px-3 py-1 rounded text-xs font-semibold ${
                        unit === u ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'
                      }`}
                    >
                      {u}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {fields.map((f) => (
                  <div key={f.key}>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      {f.label} ({unit})
                    </label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                      placeholder="0.0"
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono tabular-nums focus:border-teal-600 focus:outline-none"
                    />
                  </div>
                ))}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Fitting & Posture Notes</label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g., Sloping right shoulder, prefers slim taper..."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
                >
                  {saving ? 'Saving...' : editing ? 'Save New Version' : 'Save Measurements'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* History Modal */}
      {historyTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-display text-base font-bold text-slate-900">
                  Measurement Revision History
                </h2>
                <p className="text-xs text-slate-500">
                  {historyTarget.customer_name} · {historyTarget.garment_type}
                </p>
              </div>
              <button type="button" onClick={() => setHistoryTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="h-5 w-5" />
              </button>
            </div>
            {historyItems.length === 0 ? (
              <p className="text-xs text-slate-500 py-4">No archived versions available locally.</p>
            ) : (
              <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                {historyItems.map((h) => {
                  let vals: Record<string, number> = {};
                  try {
                    vals = JSON.parse(h.values_json);
                  } catch {
                    vals = {};
                  }
                  return (
                    <div key={h.id} className="rounded-lg border border-slate-200 p-3 text-xs space-y-1">
                      <div className="flex items-center justify-between font-semibold text-slate-900">
                        <span>Version {h.version} ({h.unit})</span>
                        <span className="font-normal text-slate-500">{formatDate(h.recorded_at)}</span>
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-slate-700">
                        {Object.entries(vals).map(([k, v]) => (
                          <span key={k}>{k.replace(/_/g, ' ')}: {v}{h.unit}</span>
                        ))}
                      </div>
                      {h.notes && <p className="text-slate-500">{h.notes}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
