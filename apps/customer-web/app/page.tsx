'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, cents } from '../lib/api';

type Product = {
  id: string;
  brandId: string;
  brandName: string;
  name: string;
  slug: string;
  description?: string;
  category: string;
  priceCents: number;
  prepMinutes?: number;
};

type CartItem = Product & { quantity: number };

type Screen = 'login' | 'home' | 'cart' | 'checkout' | 'tracking';

export default function CustomerApp() {
  const [screen, setScreen] = useState<Screen>('login');
  const [token, setToken] = useState('');
  const [phone, setPhone] = useState('3331234567');
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [category, setCategory] = useState<string>('all');
  const [quote, setQuote] = useState<any>(null);
  const [order, setOrder] = useState<any>(null);
  const [tracking, setTracking] = useState<any>(null);
  const [error, setError] = useState('');

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tokenRef = useRef('');
  const orderIdRef = useRef<string | null>(null);

  const filteredProducts = category === 'all' ? products : products.filter((p) => p.category === category);
  const cartCount = cart.reduce((s, i) => s + i.quantity, 0);
  const subtotal = cart.reduce((s, i) => s + i.priceCents * i.quantity, 0);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    orderIdRef.current = order?.masterOrderId ?? null;
  }, [order?.masterOrderId]);

  useEffect(() => {
    const stored = localStorage.getItem('customerToken');
    const storedPhone = localStorage.getItem('customerPhone');

    if (stored) {
      setToken(stored);
      tokenRef.current = stored;

      if (storedPhone) setPhone(storedPhone);

      setScreen('home');
      loadCatalog();
    }
  }, []);

  const refreshTracking = useCallback(async (orderId = orderIdRef.current, tokenOverride = tokenRef.current) => {
    if (!orderId || !tokenOverride) return;

    try {
      const data = await apiFetch<any>(`/customer/orders/${orderId}/tracking`, {
        token: tokenOverride,
      });

      setTracking(data);

      const terminalStatuses = ['DELIVERED', 'CANCELLED', 'DISPUTED_REVIEW'];

      if (terminalStatuses.includes(data?.status) && pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();

    const orderId = orderIdRef.current;
    const currentToken = tokenRef.current;

    if (!orderId || !currentToken) return;

    refreshTracking(orderId, currentToken);

    pollingRef.current = setInterval(() => {
      refreshTracking(orderIdRef.current, tokenRef.current);
    }, 7000);
  }, [refreshTracking, stopPolling]);

  useEffect(() => {
    if (screen === 'tracking') {
      startPolling();
    } else {
      stopPolling();
    }

    return () => {
      stopPolling();
    };
  }, [screen, startPolling, stopPolling]);

  async function login() {
    setError('');

    try {
      const res = await apiFetch<{ accessToken: string; customerId: string }>('/auth/dev/customer', {
        method: 'POST',
        body: JSON.stringify({ phone }),
      });

      setToken(res.accessToken);
      tokenRef.current = res.accessToken;

      localStorage.setItem('customerToken', res.accessToken);
      localStorage.setItem('customerPhone', phone);

      setScreen('home');
      await loadCatalog();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function loadCatalog() {
    const data = await apiFetch<{ categories: string[]; products: Product[] }>('/customer/catalog');
    setProducts(data.products);
    setCategories(data.categories);
  }

  function add(product: Product) {
    setCart((items) => {
      const existing = items.find((i) => i.id === product.id);

      if (existing) {
        return items.map((i) => i.id === product.id ? { ...i, quantity: i.quantity + 1 } : i);
      }

      return [...items, { ...product, quantity: 1 }];
    });
  }

  function remove(productId: string) {
    setCart((items) =>
      items
        .map((i) => i.id === productId ? { ...i, quantity: i.quantity - 1 } : i)
        .filter((i) => i.quantity > 0),
    );
  }

  async function loadQuote() {
    setError('');

    try {
      const data = await apiFetch('/customer/orders/quote', {
        method: 'POST',
        body: JSON.stringify({
          paymentMethod: 'CASH',
          items: cart.map((i) => ({ productId: i.id, quantity: i.quantity })),
        }),
      });

      setQuote(data);
      setScreen('checkout');
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function checkout() {
    setError('');

    try {
      const data = await apiFetch<any>('/customer/orders', {
        method: 'POST',
        token,
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          customer: { name: 'Cliente demo' },
          address: {
            street: 'Via Demo 1',
            city: 'Bacoli',
            notes: 'Citofono demo',
          },
          paymentMethod: 'CASH',
          customerNotes: 'Ordine demo customer-web',
          items: cart.map((i) => ({ productId: i.id, quantity: i.quantity })),
        }),
      });

      setOrder(data);
      orderIdRef.current = data.masterOrderId;

      setScreen('tracking');
      await refreshTracking(data.masterOrderId, tokenRef.current);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function customerDecision(action: 'continue' | 'cancel') {
    if (!order?.masterOrderId) return;
    setError('Per ora la decisione cliente viene gestita da Admin Console nel MVP.');
  }

  const Header = ({ title, back }: { title: string; back?: Screen }) => (
    <div className="mb-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        {back && <button onClick={() => setScreen(back)} className="text-xl">←</button>}
        <h1 className="text-xl font-bold">{title}</h1>
      </div>

      {screen !== 'login' && (
        <button onClick={() => setScreen('cart')} className="rounded-xl bg-black px-3 py-2 text-sm text-white">
          Cart {cartCount}
        </button>
      )}
    </div>
  );

  if (screen === 'login') {
    return (
      <main className="mx-auto min-h-screen max-w-md bg-gray-50 p-4">
        <h1 className="mb-2 text-2xl font-bold">Food Cluster</h1>
        <p className="mb-6 text-gray-600">Login demo cliente</p>

        <input
          className="mb-3 w-full rounded-2xl border bg-white p-3"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Telefono"
        />

        <button onClick={login} className="w-full rounded-2xl bg-black py-3 text-white">
          Entra
        </button>

        {error && <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      </main>
    );
  }

  if (screen === 'home') {
    return (
      <main className="mx-auto min-h-screen max-w-md bg-gray-50 p-4 pb-24">
        <Header title="Food Cluster" />

        <p className="mb-4 text-gray-600">Stessi prezzi del locale. Una sola consegna.</p>

        <div className="mb-4 flex gap-2 overflow-x-auto">
          <button
            onClick={() => setCategory('all')}
            className={`rounded-full px-4 py-2 ${category === 'all' ? 'bg-black text-white' : 'bg-white'}`}
          >
            Tutto
          </button>

          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`rounded-full px-4 py-2 ${category === c ? 'bg-black text-white' : 'bg-white'}`}
            >
              {c}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          {filteredProducts.map((p) => (
            <div key={p.id} className="rounded-2xl bg-white p-4 shadow">
              <div className="flex justify-between gap-3">
                <div>
                  <p className="font-semibold">{p.name}</p>
                  <p className="text-sm text-gray-500">{p.brandName} · {p.category}</p>
                  <p className="mt-1 text-sm text-gray-600">{p.description}</p>
                </div>

                <div className="text-right">
                  <p className="font-semibold">{cents(p.priceCents)}</p>
                  <button onClick={() => add(p)} className="mt-2 rounded-full bg-black px-3 py-1 text-white">
                    +
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {error && <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      </main>
    );
  }

  if (screen === 'cart') {
    return (
      <main className="mx-auto min-h-screen max-w-md bg-gray-50 p-4 pb-24">
        <Header title="Carrello" back="home" />

        {!cart.length && <p className="rounded-2xl bg-white p-4 shadow">Carrello vuoto.</p>}

        {cart.map((item) => (
          <div key={item.id} className="mb-3 rounded-2xl bg-white p-4 shadow">
            <div className="flex justify-between">
              <div>
                <p className="font-semibold">{item.name}</p>
                <p className="text-sm text-gray-500">{item.brandName}</p>
              </div>

              <p>{cents(item.priceCents * item.quantity)}</p>
            </div>

            <div className="mt-3 flex items-center gap-3">
              <button onClick={() => remove(item.id)} className="rounded-xl border px-3 py-1">
                -
              </button>

              <span>{item.quantity}</span>

              <button onClick={() => add(item)} className="rounded-xl border px-3 py-1">
                +
              </button>
            </div>
          </div>
        ))}

        <div className="mb-4 rounded-2xl bg-white p-4 shadow">
          <div className="flex justify-between">
            <span>Subtotale</span>
            <b>{cents(subtotal)}</b>
          </div>

          {subtotal < 2500 && (
            <p className="mt-2 text-sm text-gray-500">
              Ti mancano {cents(2500 - subtotal)} per la consegna gratuita.
            </p>
          )}
        </div>

        <button
          disabled={!cart.length}
          onClick={loadQuote}
          className="w-full rounded-2xl bg-black py-4 text-white disabled:opacity-40"
        >
          Vai al checkout
        </button>

        {error && <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      </main>
    );
  }

  if (screen === 'checkout') {
    return (
      <main className="mx-auto min-h-screen max-w-md bg-gray-50 p-4 pb-24">
        <Header title="Checkout" back="cart" />

        <div className="mb-4 rounded-2xl bg-white p-4 shadow">
          <p className="mb-2 font-semibold">Riepilogo</p>

          <div className="flex justify-between">
            <span>Prodotti</span>
            <span>{cents(quote?.subtotalCents ?? 0)}</span>
          </div>

          <div className="flex justify-between">
            <span>Delivery</span>
            <span>{cents(quote?.deliveryFeeCents ?? 0)}</span>
          </div>

          <div className="flex justify-between">
            <span>Sconto cash</span>
            <span>-{cents(quote?.discountCents ?? 0)}</span>
          </div>

          <div className="mt-2 flex justify-between text-lg font-bold">
            <span>Totale</span>
            <span>{cents(quote?.totalCents ?? 0)}</span>
          </div>
        </div>

        <div className="mb-4 rounded-2xl bg-white p-4 shadow">
          <p className="font-semibold">Pagamento</p>
          <p className="text-sm text-gray-600">Cash alla consegna · demo MVP</p>
        </div>

        <button onClick={checkout} className="w-full rounded-2xl bg-black py-4 text-white">
          Conferma ordine
        </button>

        {error && <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-md bg-gray-50 p-4 pb-24">
      <Header title={`Ordine #${tracking?.orderNumber ?? order?.orderNumber ?? ''}`} back="home" />

      <div className="mb-4 rounded-2xl bg-white p-4 shadow">
        <p className="font-semibold">Stato: {tracking?.status ?? order?.status}</p>

        <p className="mt-1 text-sm text-gray-500">
          Aggiornamento automatico ogni 7 secondi.
        </p>

        <button onClick={() => refreshTracking()} className="mt-3 rounded-xl border px-3 py-2 text-sm">
          Aggiorna tracking
        </button>
      </div>

      {tracking?.decisionPayload && (
        <div className="mb-4 rounded-2xl bg-yellow-50 p-4 shadow">
          <p className="font-semibold">Decisione richiesta</p>
          <p className="text-sm text-gray-700">
            Un brand non può completare l’ordine. In MVP gestisci la risoluzione da Admin Console.
          </p>

          <div className="mt-3 flex gap-2">
            <button onClick={() => customerDecision('continue')} className="rounded-xl border px-3 py-2">
              Continua partial
            </button>

            <button onClick={() => customerDecision('cancel')} className="rounded-xl border px-3 py-2">
              Annulla tutto
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {tracking?.subOrders?.map((s: any) => (
          <div key={s.brandId} className="rounded-2xl bg-white p-4 shadow">
            <p className="font-semibold">{s.brandName}</p>
            <p className="text-sm text-gray-500">{s.status}</p>
          </div>
        ))}
      </div>

      {error && <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    </main>
  );
}
