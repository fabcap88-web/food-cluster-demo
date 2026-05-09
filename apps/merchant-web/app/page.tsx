'use client';

import { useEffect, useState } from 'react';
import { apiFetch, cents } from '../lib/api';

const brands = [
  { slug: 'burgeri', name: 'Burgerì' },
  { slug: 'toastiamo', name: 'Toastiamo' },
  { slug: 'sticky-sticks', name: 'Sticky Sticks' },
];

export default function MerchantApp() {
  const [token, setToken] = useState('');
  const [brandSlug, setBrandSlug] = useState('burgeri');
  const [brandId, setBrandId] = useState('');
  const [orders, setOrders] = useState<any[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const stored = localStorage.getItem('merchantToken');
    if (stored) {
      setToken(stored);
      setBrandId(localStorage.getItem('merchantBrandId') ?? '');
      loadOrders(stored);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => loadOrders(token), 10000);
    return () => clearInterval(interval);
  }, [token]);

  async function login() {
    setError('');
    try {
      const res = await apiFetch<{ accessToken: string; brandId: string }>('/auth/dev/merchant', {
        method: 'POST',
        body: JSON.stringify({ brandSlug }),
      });
      setToken(res.accessToken);
      setBrandId(res.brandId);
      localStorage.setItem('merchantToken', res.accessToken);
      localStorage.setItem('merchantBrandId', res.brandId);
      await loadOrders(res.accessToken);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function loadOrders(t = token) {
    if (!t) return;
    try {
      const data = await apiFetch<{ orders: any[] }>('/merchant/orders', { token: t });
      setOrders(data.orders);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function accept(subOrderId: string, prepEtaMinutes: number) {
    await action(`/merchant/sub-orders/${subOrderId}/accept`, { prepEtaMinutes });
  }

  async function reject(subOrderId: string) {
    await action(`/merchant/sub-orders/${subOrderId}/reject`, { reason: 'Non disponibile in demo' });
  }

  async function updateStatus(subOrderId: string, status: string) {
    await action(`/merchant/sub-orders/${subOrderId}/status`, { status });
  }

  async function action(path: string, body: any) {
    setError('');
    try {
      await apiFetch(path, { method: 'PATCH', token, body: JSON.stringify(body) });
      await loadOrders();
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (!token) {
    return (
      <main className="mx-auto min-h-screen max-w-md bg-gray-50 p-4">
        <h1 className="mb-2 text-2xl font-bold">Merchant Login</h1>
        <p className="mb-4 text-gray-600">Seleziona brand demo.</p>
        <select className="mb-3 w-full rounded-2xl border bg-white p-3" value={brandSlug} onChange={(e) => setBrandSlug(e.target.value)}>
          {brands.map((b) => <option key={b.slug} value={b.slug}>{b.name}</option>)}
        </select>
        <button onClick={login} className="w-full rounded-2xl bg-black py-3 text-white">Entra</button>
        {error && <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-gray-50 p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Merchant Dashboard</h1>
          <p className="text-sm text-gray-500">Polling fallback ogni 10s</p>
        </div>
        <button onClick={() => loadOrders()} className="rounded-xl border px-3 py-2">Refresh</button>
      </div>
      {error && <p className="mb-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {!orders.length && <div className="rounded-2xl bg-white p-4 shadow">Nessun ordine attivo.</div>}
      <div className="space-y-3">
        {orders.map((order) => (
          <div key={order.subOrderId} className="rounded-2xl bg-white p-4 shadow">
            <div className="mb-2 flex justify-between gap-3">
              <b>#{order.orderNumber}</b>
              <span className="rounded-full bg-gray-100 px-3 py-1 text-sm">{order.status}</span>
            </div>
            <p className="text-sm text-gray-500">{order.isPartOfMultiBrandOrder ? 'Ordine multi-brand' : 'Ordine singolo'} · Captain: {order.captainBrandName ?? '-'}</p>
            <div className="my-3 space-y-1">
              {order.items.map((i: any, idx: number) => (
                <p key={idx} className="text-sm">{i.quantity}× {i.name}</p>
              ))}
            </div>
            <p className="mb-3 text-sm font-semibold">Totale tuo sub-order: {cents(order.subtotalCents)}</p>
            {order.status === 'PENDING' || order.status === 'PENDING_TIMEOUT' ? (
              <>
                <div className="mb-2 grid grid-cols-6 gap-2">
                  {[5, 10, 15, 20, 25, 30].map((m) => (
                    <button key={m} onClick={() => accept(order.subOrderId, m)} className="rounded-xl border p-2 text-sm">{m}m</button>
                  ))}
                </div>
                <button onClick={() => reject(order.subOrderId)} className="w-full rounded-2xl border py-2">Rifiuta</button>
              </>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                <button onClick={() => updateStatus(order.subOrderId, 'PREPARING')} className="rounded-xl border p-2">Prep</button>
                <button onClick={() => updateStatus(order.subOrderId, 'READY')} className="rounded-xl border p-2">Ready</button>
                <button onClick={() => updateStatus(order.subOrderId, 'HANDED_OFF')} className="rounded-xl border p-2">Handoff</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
