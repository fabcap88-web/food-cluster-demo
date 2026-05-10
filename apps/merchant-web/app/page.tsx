'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, cents } from '../lib/api';

const brands = [
  { slug: 'burgeri', name: 'Burgerì' },
  { slug: 'toastiamo', name: 'Toastiamo' },
  { slug: 'sticky-sticks', name: 'Sticky Sticks' },
];

// Status labels in Italian for the demo UI
const STATUS_LABELS: Record<string, string> = {
  PENDING: 'In attesa',
  PENDING_TIMEOUT: 'Scaduto – ancora accettabile',
  ACCEPTED_WAITING_GROUP: 'Accettato (attesa gruppo)',
  ACCEPTED: 'Accettato',
  PREPARING: 'In preparazione',
  READY: 'Pronto',
  HANDED_OFF: 'Consegnato al rider',
  REJECTED: 'Rifiutato',
  CANCELLED: 'Annullato',
};

export default function MerchantApp() {
  const [token, setToken] = useState('');
  const [brandSlug, setBrandSlug] = useState('burgeri');
  const [orders, setOrders] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Track which sub-orders are currently being actioned to prevent double-clicks
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startPolling = useCallback(
    (t: string) => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      pollingRef.current = setInterval(() => loadOrders(t), 10_000);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    const stored = localStorage.getItem('merchantToken');
    if (stored) {
      setToken(stored);
      loadOrders(stored);
      startPolling(stored);
    }
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function login() {
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ accessToken: string; brandId: string }>(
        '/auth/dev/merchant',
        { method: 'POST', body: JSON.stringify({ brandSlug }) },
      );
      localStorage.setItem('merchantToken', res.accessToken);
      localStorage.setItem('merchantBrandId', res.brandId);
      setToken(res.accessToken);
      await loadOrders(res.accessToken);
      startPolling(res.accessToken);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    if (pollingRef.current) clearInterval(pollingRef.current);
    localStorage.removeItem('merchantToken');
    localStorage.removeItem('merchantBrandId');
    setToken('');
    setOrders([]);
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
    await action(subOrderId, `/merchant/sub-orders/${subOrderId}/accept`, { prepEtaMinutes });
  }

  async function reject(subOrderId: string) {
    await action(subOrderId, `/merchant/sub-orders/${subOrderId}/reject`, {
      reason: 'Non disponibile in demo',
    });
  }

  async function updateStatus(subOrderId: string, status: string) {
    await action(subOrderId, `/merchant/sub-orders/${subOrderId}/status`, { status });
  }

  // FIX: actions now set a per-order busy flag to prevent double-clicks.
  // Previously rapid taps could fire two PATCH requests for the same sub-order,
  // resulting in the second call hitting a 400 "Invalid transition" error and
  // displaying a red error banner even though the first action succeeded.
  async function action(subOrderId: string, path: string, body: any) {
    if (busy[subOrderId]) return;
    setError('');
    setBusy((prev) => ({ ...prev, [subOrderId]: true }));
    try {
      await apiFetch(path, { method: 'PATCH', token, body: JSON.stringify(body) });
      // Immediate reload after a successful action so the UI reflects the new
      // status without waiting for the next 10s polling tick.
      await loadOrders();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy((prev) => ({ ...prev, [subOrderId]: false }));
    }
  }

  if (!token) {
    return (
      <main className="mx-auto min-h-screen max-w-md bg-gray-50 p-4">
        <h1 className="mb-2 text-2xl font-bold">Merchant Login</h1>
        <p className="mb-4 text-gray-600">Seleziona brand demo.</p>
        <select
          className="mb-3 w-full rounded-2xl border bg-white p-3"
          value={brandSlug}
          onChange={(e) => setBrandSlug(e.target.value)}
        >
          {brands.map((b) => (
            <option key={b.slug} value={b.slug}>
              {b.name}
            </option>
          ))}
        </select>
        <button
          onClick={login}
          disabled={loading}
          className="w-full rounded-2xl bg-black py-3 text-white disabled:opacity-50"
        >
          {loading ? 'Accesso…' : 'Entra'}
        </button>
        {error && (
          <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>
        )}
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-gray-50 p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Merchant Dashboard</h1>
          <p className="text-sm text-gray-500">Aggiornamento automatico ogni 10s</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => loadOrders()}
            className="rounded-xl border px-3 py-2 text-sm"
          >
            Refresh
          </button>
          <button
            onClick={logout}
            className="rounded-xl border px-3 py-2 text-sm text-red-600"
          >
            Esci
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 flex items-start justify-between rounded-xl bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
          <button onClick={() => setError('')} className="ml-3 text-red-400 hover:text-red-600">
            ✕
          </button>
        </div>
      )}

      {!orders.length && (
        <div className="rounded-2xl bg-white p-4 shadow text-gray-500">
          Nessun ordine attivo.
        </div>
      )}

      <div className="space-y-3">
        {orders.map((order) => {
          const isBusy = !!busy[order.subOrderId];
          const isPending =
            order.status === 'PENDING' || order.status === 'PENDING_TIMEOUT';

          return (
            <div
              key={order.subOrderId}
              className={`rounded-2xl bg-white p-4 shadow transition-opacity ${isBusy ? 'opacity-60' : ''}`}
            >
              <div className="mb-2 flex justify-between gap-3">
                <b>#{order.orderNumber}</b>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    order.status === 'PENDING_TIMEOUT'
                      ? 'bg-amber-100 text-amber-800'
                      : order.status === 'PENDING'
                      ? 'bg-blue-100 text-blue-800'
                      : order.status === 'ACCEPTED' || order.status === 'ACCEPTED_WAITING_GROUP'
                      ? 'bg-green-100 text-green-800'
                      : order.status === 'REJECTED' || order.status === 'CANCELLED'
                      ? 'bg-red-100 text-red-800'
                      : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {STATUS_LABELS[order.status] ?? order.status}
                </span>
              </div>

              <p className="text-sm text-gray-500">
                {order.isPartOfMultiBrandOrder ? 'Multi-brand' : 'Singolo brand'} · Captain:{' '}
                {order.captainBrandName ?? '-'}
              </p>

              {order.customerNotes && (
                <p className="mt-1 text-sm italic text-gray-500">
                  Note: {order.customerNotes}
                </p>
              )}

              <div className="my-3 space-y-1">
                {order.items.map((i: any, idx: number) => (
                  <p key={idx} className="text-sm">
                    {i.quantity}× {i.name}
                    {i.notes ? (
                      <span className="ml-1 text-gray-400">({i.notes})</span>
                    ) : null}
                  </p>
                ))}
              </div>

              <p className="mb-3 text-sm font-semibold">
                Totale sub-order: {cents(order.subtotalCents)}
              </p>

              {isPending ? (
                <>
                  <p className="mb-1 text-xs text-gray-500">Seleziona tempo di preparazione:</p>
                  <div className="mb-2 grid grid-cols-6 gap-2">
                    {[5, 10, 15, 20, 25, 30].map((m) => (
                      <button
                        key={m}
                        disabled={isBusy}
                        onClick={() => accept(order.subOrderId, m)}
                        className="rounded-xl border p-2 text-sm hover:bg-green-50 disabled:opacity-40"
                      >
                        {m}m
                      </button>
                    ))}
                  </div>
                  <button
                    disabled={isBusy}
                    onClick={() => reject(order.subOrderId)}
                    className="w-full rounded-2xl border py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-40"
                  >
                    Rifiuta ordine
                  </button>
                </>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  <button
                    disabled={isBusy || !['ACCEPTED'].includes(order.status)}
                    onClick={() => updateStatus(order.subOrderId, 'PREPARING')}
                    className="rounded-xl border p-2 text-sm disabled:opacity-30"
                  >
                    Inizia prep
                  </button>
                  <button
                    disabled={
                      isBusy ||
                      !['ACCEPTED', 'PREPARING'].includes(order.status)
                    }
                    onClick={() => updateStatus(order.subOrderId, 'READY')}
                    className="rounded-xl border p-2 text-sm disabled:opacity-30"
                  >
                    Pronto
                  </button>
                  <button
                    disabled={isBusy || order.status !== 'READY'}
                    onClick={() => updateStatus(order.subOrderId, 'HANDED_OFF')}
                    className="rounded-xl border p-2 text-sm disabled:opacity-30"
                  >
                    Handoff
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
