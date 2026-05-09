'use client';

import { useEffect, useState } from 'react';
import { apiFetch, cents } from '../lib/api';

export default function AdminApp() {
  const [token, setToken] = useState('');
  const [orders, setOrders] = useState<any[]>([]);
  const [ledger, setLedger] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const stored = localStorage.getItem('adminToken');
    if (stored) {
      setToken(stored);
      loadAll(stored);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => loadAll(token), 10000);
    return () => clearInterval(interval);
  }, [token]);

  async function login() {
    setError('');
    try {
      const res = await apiFetch<{ accessToken: string }>('/auth/dev/admin', { method: 'POST', body: JSON.stringify({}) });
      setToken(res.accessToken);
      localStorage.setItem('adminToken', res.accessToken);
      await loadAll(res.accessToken);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function loadAll(t = token) {
    if (!t) return;
    try {
      const [live, led] = await Promise.all([
        apiFetch<any[]>('/admin/orders/live', { token: t }),
        apiFetch<any>('/admin/ledger/current', { token: t }),
      ]);
      setOrders(live);
      setLedger(led);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function cancelAll(orderId: string) {
    await action(`/admin/orders/${orderId}/cancel-all`);
  }

  async function continuePartial(orderId: string) {
    await action(`/admin/orders/${orderId}/continue-partial`);
  }

  async function action(path: string) {
    setError('');
    try {
      await apiFetch(path, { method: 'POST', token, body: JSON.stringify({}) });
      await loadAll();
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (!token) {
    return (
      <main className="mx-auto min-h-screen max-w-md bg-gray-50 p-4">
        <h1 className="mb-2 text-2xl font-bold">Admin Console</h1>
        <p className="mb-4 text-gray-600">Login demo admin.</p>
        <button onClick={login} className="w-full rounded-2xl bg-black py-3 text-white">Entra come Admin</button>
        {error && <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-5xl bg-gray-50 p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Admin Operations</h1>
          <p className="text-sm text-gray-500">Live ops + settlement snapshot</p>
        </div>
        <button onClick={() => loadAll()} className="rounded-xl border px-3 py-2">Refresh</button>
      </div>
      {error && <p className="mb-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <section className="mb-6">
        <h2 className="mb-3 text-lg font-semibold">Live Orders</h2>
        {!orders.length && <div className="rounded-2xl bg-white p-4 shadow">Nessun ordine live.</div>}
        <div className="space-y-3">
          {orders.map((order) => (
            <div key={order.id} className="rounded-2xl bg-white p-4 shadow">
              <div className="flex justify-between">
                <b>#{order.orderNumber}</b>
                <span>{cents(order.totalCents)}</span>
              </div>
              <p className="text-sm text-gray-500">{order.status} · Captain: {order.captainBrand?.name ?? '-'}</p>
              <div className="mt-3 grid gap-2 md:grid-cols-3">
                {order.subOrders.map((s: any) => (
                  <div key={s.id} className="rounded-xl bg-gray-50 p-3">
                    <p className="font-medium">{s.brand.name}</p>
                    <p className="text-sm text-gray-500">{s.status}</p>
                    <p className="text-sm">{cents(s.subtotalCents)}</p>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <button onClick={() => continuePartial(order.id)} className="rounded-xl border px-3 py-2">Continue partial</button>
                <button onClick={() => cancelAll(order.id)} className="rounded-xl border px-3 py-2">Cancel all</button>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-lg font-semibold">Ledger</h2>
        {ledger && (
          <>
            <div className={`mb-3 rounded-2xl p-4 shadow ${ledger.isBalanced ? 'bg-green-50' : 'bg-red-50'}`}>
              Global balance: {cents(ledger.globalBalanceCents)} · {ledger.isBalanced ? 'Balanced' : 'Unbalanced'}
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {ledger.balances.map((b: any) => (
                <div key={b.brandId} className="rounded-2xl bg-white p-4 shadow">
                  <p className="font-semibold">{b.brandName}</p>
                  <p className="text-sm text-gray-500">{b.settlementLabel}</p>
                  <p className="text-2xl font-bold">{cents(Math.abs(b.balanceCents))}</p>
                  <div className="mt-2 text-xs text-gray-500">
                    <p>Sales {cents(b.grossSalesCents)}</p>
                    <p>Cash {cents(b.cashCollectedCents)}</p>
                    <p>Delivery {cents(b.deliveryFeeCents)}</p>
                    <p>Reversals {cents(b.reversalsCents)}</p>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
