import React, { useMemo, useState } from 'react';
import { Edit2, Plus, Search, User, X } from 'lucide-react';
import { apiRequest, formatDate, formatMoney, generateUuid } from '../lib/api';
import type { Customer, WorkspaceData } from '../types';

interface CustomersViewProps {
  data: WorkspaceData;
  currency: string;
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const CustomersView: React.FC<CustomersViewProps> = ({
  data,
  currency,
  onRefresh,
  onNotify,
}) => {
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');

  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data.customers;
    return data.customers.filter(
      (c) =>
        c.full_name.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q) ||
        c.customer_number.toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q)
    );
  }, [data.customers, search]);

  const customerFinancials = (customerId: number) => {
    const custOrders = data.orders.filter((o) => o.customer_id === customerId && o.status !== 'Cancelled');
    const billed = custOrders.reduce((s, o) => s + Number(o.agreed_price || 0), 0);
    const paid = data.payments
      .filter((p) => p.customer_id === customerId && p.status === 'Completed')
      .reduce((s, p) => s + Number(p.amount || 0), 0);
    return {
      orderCount: custOrders.length,
      billed,
      paid,
      balance: Math.max(0, billed - paid),
    };
  };

  const openCreate = () => {
    setEditing(null);
    setFormError('');
    setFullName('');
    setPhone('');
    setEmail('');
    setAddress('');
    setNotes('');
    setShowModal(true);
  };

  const openEdit = (c: Customer) => {
    setEditing(c);
    setFormError('');
    setFullName(c.full_name);
    setPhone(c.phone);
    setEmail(c.email || '');
    setAddress(c.address || '');
    setNotes(c.notes || '');
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    const cleanName = fullName.trim();
    const cleanPhone = phone.trim();
    if (!cleanName || !cleanPhone) {
      setFormError('Customer full name and phone number are required.');
      return;
    }

    setSaving(true);
    try {
      if (editing) {
        await apiRequest(`/api/customers/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            fullName: cleanName,
            phone: cleanPhone,
            email: email.trim(),
            address: address.trim(),
            notes: notes.trim(),
          }),
        });
        await onRefresh();
        onNotify('Customer details updated.', 'success');
      } else {
        const dup = data.customers.find((c) => c.phone.trim() === cleanPhone);
        if (dup) {
          throw new Error(`Duplicate customer prevented: ${dup.full_name} already uses ${cleanPhone}.`);
        }
        const clientUuid = generateUuid();
        await apiRequest('/api/customers', {
          method: 'POST',
          body: JSON.stringify({
            fullName: cleanName,
            phone: cleanPhone,
            email: email.trim(),
            address: address.trim(),
            notes: notes.trim(),
            clientUuid,
          }),
        });
        await onRefresh();
        onNotify('Customer registered successfully.', 'success');
      }
      setShowModal(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save customer.';
      setFormError(msg);
      onNotify(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  const selectedCustomer = selectedId ? data.customers.find((c) => c.id === selectedId) || null : null;
  const selectedOrders = selectedCustomer
    ? data.orders.filter((o) => o.customer_id === selectedCustomer.id)
    : [];
  const selectedPayments = selectedCustomer
    ? data.payments.filter((p) => p.customer_id === selectedCustomer.id)
    : [];
  const selectedMeasurements = selectedCustomer
    ? data.measurements.filter((m) => m.customer_id === selectedCustomer.id)
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900">Customers</h1>
          <p className="text-sm text-slate-500">
            Register clients, prevent duplicate records, and review order and payment histories.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800 whitespace-nowrap self-start sm:self-auto"
        >
          <Plus className="h-4 w-4" />
          Register Customer
        </button>
      </div>

      {/* Search Bar */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="relative max-w-md">
          <Search className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by customer number, name, phone, or email..."
            className="w-full rounded-lg border border-slate-300 bg-white pl-10 pr-3.5 py-2 text-sm focus:border-teal-600 focus:outline-none"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Customer Table */}
        <div className={`${selectedCustomer ? 'lg:col-span-7' : 'lg:col-span-12'} rounded-xl border border-slate-200 bg-white overflow-hidden`}>
          {filteredCustomers.length === 0 ? (
            <div className="p-10 text-center">
              <User className="h-8 w-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm font-medium text-slate-700">No customers found</p>
              <p className="text-xs text-slate-500 mt-1">Register your first customer to start taking measurements and orders.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4">Customer No.</th>
                    <th className="py-3 px-4">Full Name</th>
                    <th className="py-3 px-4">Phone</th>
                    <th className="py-3 px-4 text-right">Orders</th>
                    <th className="py-3 px-4 text-right">Outstanding</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {filteredCustomers.map((c) => {
                    const fin = customerFinancials(c.id);
                    const isSelected = selectedId === c.id;
                    return (
                      <tr
                        key={c.id}
                        onClick={() => setSelectedId(c.id)}
                        className={`cursor-pointer transition-colors ${
                          isSelected ? 'bg-teal-50/60' : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="py-3 px-4 font-mono text-xs font-medium text-slate-700">
                          {c.customer_number}
                        </td>
                        <td className="py-3 px-4 font-medium text-slate-900">
                          <div>{c.full_name}</div>
                          {c.email && <div className="text-xs text-slate-500">{c.email}</div>}
                        </td>
                        <td className="py-3 px-4 font-mono text-xs text-slate-600">{c.phone}</td>
                        <td className="py-3 px-4 text-right font-mono text-xs tabular-nums">{fin.orderCount}</td>
                        <td className={`py-3 px-4 text-right font-mono text-xs font-semibold tabular-nums ${fin.balance > 0 ? 'text-amber-700' : 'text-slate-700'}`}>
                          {formatMoney(fin.balance, currency)}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openEdit(c);
                            }}
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

        {/* Customer Profile Detail Panel */}
        {selectedCustomer && (
          <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 space-y-5 self-start">
            <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-4">
              <div>
                <p className="font-mono text-xs text-teal-700 font-semibold">{selectedCustomer.customer_number}</p>
                <h2 className="font-display text-lg font-bold text-slate-900">{selectedCustomer.full_name}</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {selectedCustomer.phone} {selectedCustomer.email ? `· ${selectedCustomer.email}` : ''}
                </p>
                {selectedCustomer.address && (
                  <p className="text-xs text-slate-500 mt-0.5">{selectedCustomer.address}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="p-1 text-slate-400 hover:text-slate-700"
                aria-label="Close customer profile"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {(() => {
              const fin = customerFinancials(selectedCustomer.id);
              return (
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="text-[11px] text-slate-500">Total Billed</p>
                    <p className="font-mono text-xs font-bold text-slate-900 tabular-nums mt-0.5">
                      {formatMoney(fin.billed, currency)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="text-[11px] text-slate-500">Total Paid</p>
                    <p className="font-mono text-xs font-bold text-teal-700 tabular-nums mt-0.5">
                      {formatMoney(fin.paid, currency)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="text-[11px] text-slate-500">Balance</p>
                    <p className="font-mono text-xs font-bold text-amber-700 tabular-nums mt-0.5">
                      {formatMoney(fin.balance, currency)}
                    </p>
                  </div>
                </div>
              );
            })()}

            <div>
              <h3 className="text-xs font-semibold text-slate-700 mb-2">
                Saved Measurements ({selectedMeasurements.length})
              </h3>
              {selectedMeasurements.length === 0 ? (
                <p className="text-xs text-slate-500">No measurement records for this customer.</p>
              ) : (
                <div className="space-y-1.5">
                  {selectedMeasurements.map((m) => (
                    <div key={m.id} className="rounded-lg border border-slate-200 px-3 py-2 text-xs flex justify-between">
                      <span className="font-medium text-slate-800">{m.garment_type} (v{m.version})</span>
                      <span className="text-slate-500">{formatDate(m.updated_at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-700 mb-2">
                Order History ({selectedOrders.length})
              </h3>
              {selectedOrders.length === 0 ? (
                <p className="text-xs text-slate-500">No tailoring orders yet.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {selectedOrders.map((o) => (
                    <div key={o.id} className="py-2 flex items-center justify-between text-xs">
                      <div>
                        <span className="font-mono font-semibold text-slate-900">{o.order_number}</span>
                        <span className="text-slate-500"> · {o.garment_type} · {o.status}</span>
                      </div>
                      <span className="font-mono font-semibold tabular-nums">{formatMoney(o.agreed_price, currency)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-700 mb-2">
                Payment History ({selectedPayments.length})
              </h3>
              {selectedPayments.length === 0 ? (
                <p className="text-xs text-slate-500">No payments recorded.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {selectedPayments.map((p) => (
                    <div key={p.id} className="py-2 flex items-center justify-between text-xs">
                      <div>
                        <span className="font-mono font-semibold text-slate-900">{p.receipt_number}</span>
                        <span className="text-slate-500"> · {p.payment_method} ({p.status})</span>
                      </div>
                      <span className="font-mono font-semibold text-teal-700 tabular-nums">
                        {formatMoney(p.amount, currency)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Create / Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-bold text-slate-900">
                {editing ? 'Edit Customer' : 'Register New Customer'}
              </h2>
              <button type="button" onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-3.5">
              {formError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700" role="alert">
                  {formError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Full Name *</label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
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
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Email Address (Optional)</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Address (Optional)</label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Tailoring Notes</label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
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
                  {saving ? 'Saving...' : editing ? 'Update Customer' : 'Register Customer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
