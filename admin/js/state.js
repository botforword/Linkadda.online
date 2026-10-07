import { db, ref, onValue, get, set, update, remove, auth, onAuthStateChanged } from './firebase.js';
import { RTDB_NODES } from './config.js';
import { safeJson, slugify, uid } from './utils.js';

const CACHE_KEY = 'linkadda_admin_store_cache_v4';

function loadCachedStore() {
  const initial = {
    hero: {},
    categories: {},
    products: {},
    events: {},
    banner: {},
    faq: {},
    testimonials: {},
    settings: {},
    payment: {},
    orders: {},
    analytics: {},
    media: {},
    visitors: {},
    customers: {},
    sellers: {},
    seller_applications: {},
  };

  // 1. Seed from window.__preloadedCatalog immediately (instant 0ms bootstrap)
  try {
    const preCatalog = (typeof window !== 'undefined' && window.__preloadedCatalog) ? window.__preloadedCatalog : null;
    if (preCatalog && typeof preCatalog === 'object') {
      ['products', 'categories', 'banner', 'hero', 'faq', 'testimonials'].forEach((k) => {
        if (preCatalog[k] && typeof preCatalog[k] === 'object' && Object.keys(preCatalog[k]).length > 0) {
          initial[k] = { ...preCatalog[k] };
        }
      });
    }
  } catch (_) {}

  // 2. Merge from live storefront cache if available
  try {
    const rawLive = localStorage.getItem('linkadda_cached_live_data');
    if (rawLive) {
      const parsedLive = JSON.parse(rawLive);
      if (parsedLive && typeof parsedLive === 'object') {
        ['products', 'categories', 'banner'].forEach((k) => {
          if (parsedLive[k] && typeof parsedLive[k] === 'object' && Object.keys(parsedLive[k]).length > 0) {
            initial[k] = { ...(initial[k] || {}), ...parsedLive[k] };
          }
        });
      }
    }
  } catch (_) {}

  // 3. Merge from admin's own saved cache (if it contains actual data)
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        Object.keys(initial).forEach((k) => {
          if (parsed[k] && typeof parsed[k] === 'object' && Object.keys(parsed[k]).length > 0) {
            initial[k] = { ...(initial[k] || {}), ...parsed[k] };
          }
        });
      }
    }
  } catch (_) {}

  // 4. Sanitize store branding to prevent JaiGram crossover
  try {
    if (initial.settings && typeof initial.settings === 'object') {
      if (!initial.settings.siteName || /jaigram|jai/i.test(initial.settings.siteName)) {
        initial.settings.siteName = 'Linkadda Online';
      }
    }
    // Clean up any legacy JaiGram keys from localStorage
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /jaigram/i.test(k)) {
        localStorage.removeItem(k);
      }
    }
  } catch (_) {}

  return initial;
}

const STORE = loadCachedStore();
const subscribers = new Set();
const activeUnsubs = new Map();
let emitTimer = null;
let saveCacheTimer = null;

function syncWebsiteCache() {
  try {
    const liveCache = {
      categories: STORE.categories || {},
      products: STORE.products || {},
      banner: STORE.banner || {},
      timestamp: Date.now(),
    };
    localStorage.setItem('linkadda_cached_live_data', JSON.stringify(liveCache));
    if (STORE.payment) {
      localStorage.setItem('linkadda_payment_payment', JSON.stringify(STORE.payment));
    }
    if (STORE.settings) {
      localStorage.setItem('linkadda_payment_settings', JSON.stringify(STORE.settings));
    }
    if (STORE.faq) {
      localStorage.setItem('linkadda_cached_faq', JSON.stringify(STORE.faq));
    }
  } catch (_) {}
}

function saveStoreCache() {
  if (saveCacheTimer) return;
  saveCacheTimer = setTimeout(() => {
    saveCacheTimer = null;
    try {
      const updatedCache = {
        settings: STORE.settings || {},
        payment: STORE.payment || {},
        hero: STORE.hero || {},
        banner: STORE.banner || {},
        faq: STORE.faq || {},
        testimonials: STORE.testimonials || {},
        categories: STORE.categories || {},
        products: STORE.products || {},
        orders: STORE.orders || {},
        events: STORE.events || {},
        visitors: STORE.visitors || {},
        customers: STORE.customers || {},
        analytics: STORE.analytics || {},
        sellers: STORE.sellers || {},
        seller_applications: STORE.seller_applications || {},
        timestamp: Date.now(),
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(updatedCache));
      syncWebsiteCache();
    } catch (_) {}
  }, 250);
}

function emit() {
  if (emitTimer) cancelAnimationFrame(emitTimer);
  emitTimer = requestAnimationFrame(() => {
    saveStoreCache();
    const snapshot = getSnapshot();
    subscribers.forEach((fn) => {
      try {
        fn(snapshot);
      } catch (err) {
        console.error('Subscriber error:', err);
      }
    });
  });
}

export function getSnapshot() {
  const copy = {};
  for (const k in STORE) {
    copy[k] = typeof STORE[k] === 'object' && STORE[k] !== null ? { ...STORE[k] } : STORE[k];
  }
  return copy;
}

export function subscribe(fn) {
  subscribers.add(fn);
  fn(getSnapshot());
  return () => subscribers.delete(fn);
}

function attachNode(key, mode = 'collection') {
  const nodeName = RTDB_NODES[key];
  if (!nodeName) return;

  // Clean up previous subscription if any
  if (activeUnsubs.has(key)) {
    try {
      activeUnsubs.get(key)();
    } catch (_) {}
    activeUnsubs.delete(key);
  }

  try {
    get(ref(db, nodeName))
      .then((snap) => {
        if (snap.exists() && snap.val()) {
          const val = snap.val();
          if (typeof val === 'object' && Object.keys(val).length > 0) {
            STORE[key] = val;
            emit();
          } else if (mode === 'singleton') {
            STORE[key] = val;
            emit();
          }
        } else if (!snap.exists() || !snap.val()) {
          // If RTDB node is empty but STORE has data and user is admin, seed RTDB
          if (auth.currentUser) {
            if (STORE[key] && typeof STORE[key] === 'object' && Object.keys(STORE[key]).length > 0) {
              set(ref(db, nodeName), STORE[key]).catch(() => {});
            }
          }
        }
      })
      .catch(() => {});

    const unsub = onValue(
      ref(db, nodeName),
      (snap) => {
        if (snap.exists() && snap.val()) {
          const val = snap.val();
          if (typeof val === 'object' && Object.keys(val).length > 0) {
            STORE[key] = val;
            emit();
          } else if (mode === 'singleton') {
            STORE[key] = val;
            emit();
          }
        }
      },
      (err) => {
        // Silently catch permission errors until auth resolves
        if (err?.code !== 'PERMISSION_DENIED') {
          console.warn(`RTDB node ${key} notice:`, err?.message || err);
        }
      }
    );
    activeUnsubs.set(key, unsub);
  } catch (err) {
    console.warn(`Attach node ${key} error:`, err);
  }
}

let isRealtimeStarted = false;
export function startRealtime(force = false) {
  if (isRealtimeStarted && !force) return;
  isRealtimeStarted = true;
  attachNode('hero', 'singleton');
  attachNode('categories');
  attachNode('products');
  attachNode('events');
  attachNode('banner', 'singleton');
  attachNode('faq');
  attachNode('testimonials');
  attachNode('settings', 'singleton');
  attachNode('payment', 'singleton');
  attachNode('orders');
  attachNode('analytics', 'singleton');
  attachNode('media');
  attachNode('visitors');
  attachNode('reviews');
  attachNode('customers');
  attachNode('sellers');
  attachNode('seller_applications');
}

// Proactively start listeners on load
startRealtime();

// Automatically bind listeners to auth state transitions
onAuthStateChanged(auth, (user) => {
  if (user) {
    startRealtime(true);
  }
});

function isSingleton(node) {
  return ['hero', 'banner', 'settings', 'payment', 'analytics'].includes(node);
}

function nodeRef(node, id = null) {
  if (!RTDB_NODES[node]) throw new Error(`Unknown node: ${node}`);
  return id ? ref(db, `${RTDB_NODES[node]}/${id}`) : ref(db, RTDB_NODES[node]);
}

export async function saveRecord(node, id, data) {
  const payload = {
    ...data,
    id: id || data.id || uid(node),
    updatedAt: Date.now(),
  };
  if (!payload.createdAt) payload.createdAt = Date.now();
  if (isSingleton(node)) {
    STORE[node] = payload;
    emit();
    syncWebsiteCache();
    await set(nodeRef(node), payload);
    return payload;
  }
  if (!STORE[node]) STORE[node] = {};
  STORE[node][payload.id] = payload;
  emit();
  syncWebsiteCache();
  await set(nodeRef(node, payload.id), payload);
  return payload;
}

export async function createRecord(node, data) {
  const payload = {
    ...data,
    id: data.id || uid(node),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (isSingleton(node)) {
    STORE[node] = payload;
    emit();
    syncWebsiteCache();
    await set(nodeRef(node), payload);
    return payload;
  }
  if (!STORE[node]) STORE[node] = {};
  STORE[node][payload.id] = payload;
  emit();
  syncWebsiteCache();
  await set(nodeRef(node, payload.id), payload);
  return payload;
}

export async function updateRecord(node, id, data) {
  if (isSingleton(node)) {
    const next = { ...(STORE[node] || {}), ...data, updatedAt: Date.now() };
    STORE[node] = next;
    emit();
    syncWebsiteCache();
    await set(nodeRef(node), next);
    return next;
  }
  const current = STORE[node]?.[id] || {};
  const next = { ...current, ...data, id, updatedAt: Date.now() };
  if (!STORE[node]) STORE[node] = {};
  STORE[node][id] = next;
  emit();
  syncWebsiteCache();
  await update(nodeRef(node, id), { ...data, updatedAt: Date.now() });
  return next;
}

export async function updateRecordsBatch(node, batchMap) {
  const nodeName = RTDB_NODES[node];
  if (!nodeName) throw new Error(`Unknown node: ${node}`);
  if (!STORE[node]) STORE[node] = {};
  for (const [id, item] of Object.entries(batchMap)) {
    STORE[node][id] = { ...(STORE[node][id] || {}), ...(item || {}) };
  }
  emit();
  syncWebsiteCache();
  await update(ref(db, nodeName), batchMap);
}

export async function deleteRecord(node, id) {
  if (isSingleton(node)) {
    delete STORE[node];
    emit();
    syncWebsiteCache();
    await set(nodeRef(node), null);
    return;
  }
  if (STORE[node] && STORE[node][id]) {
    delete STORE[node][id];
    emit();
    syncWebsiteCache();
  }
  await remove(nodeRef(node, id));
}

export async function duplicateRecord(node, id) {
  const source = getItem(node, id);
  if (!source) throw new Error('Record not found');
  const clone = safeJson(source);
  clone.slug = `${slugify(clone.slug || clone.title || id)}-copy`;
  clone.title = clone.title ? `${clone.title} Copy` : clone.title;
  clone.id = uid(node);
  clone.createdAt = Date.now();
  clone.updatedAt = Date.now();
  if (isSingleton(node)) {
    await set(nodeRef(node), clone);
    return clone;
  }
  await set(nodeRef(node, clone.id), clone);
  return clone;
}

export function listCollection(node) {
  const value = STORE[node] || {};
  return Object.entries(value).map(([id, item]) => ({ ...(item || {}), id }));
}

export function getItem(node, id) {
  return STORE[node]?.[id] || null;
}

export function stats() {
  const products = listCollection('products').filter((item) => item.status !== 'deleted').length;
  const categories = listCollection('categories').filter((item) => item.status !== 'deleted').length;
  const orders = listCollection('orders');
  const visitors = listCollection('visitors');
  const events = listCollection('events');
  const today = new Date().toISOString().slice(0, 10);
  const isOrderClick = (item) => {
    const t = String(item.type || '').toLowerCase();
    if (t === 'telegram_click' || t === 'review_submission' || t === 'visitor') return false;
    return t.includes('order') || t.includes('click') || Boolean(item.productId || item.package || item.productName);
  };
  const todaysOrders = orders.filter((item) => String(item.date || '').slice(0, 10) === today).length;
  const todaysVisitors = visitors.filter((item) => String(item.date || '').slice(0, 10) === today).length;
  const todaysClicks = events.filter((item) => String(item.date || '').slice(0, 10) === today && isOrderClick(item)).length;
  return {
    products,
    categories,
    orders: orders.length,
    todaysOrders,
    visitors: visitors.length,
    todaysVisitors,
    clicks: events.filter(isOrderClick).length,
    todaysClicks,
  };
}

export function recentOrders(limit = 6) {
  return listCollection('orders')
    .sort((a, b) => (Number(b.timestamp || b.createdAt || b.updatedAt || 0)) - (Number(a.timestamp || a.createdAt || a.updatedAt || 0)))
    .slice(0, limit);
}

export function recentProducts(limit = 6) {
  return listCollection('products')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit);
}

export function recentActivity(limit = 10) {
  const prettyPage = (page) => {
    const value = String(page || 'Visit').toLowerCase();
    if (value === 'index' || value === 'home' || value === 'homepage') return 'Homepage';
    return page || 'Visit';
  };
  const orders = recentOrders(limit).map((item) => ({
    type: 'order',
    title: item.package || item.title || 'Order',
    meta: item.status || 'pending',
    timestamp: item.timestamp || item.updatedAt || Date.now(),
  }));
  const events = listCollection('events')
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit)
    .map((item) => ({
      type: item.type || 'event',
      title: item.package || item.title || item.label || 'Event',
      meta: item.page || item.source || item.path || '',
      timestamp: item.timestamp || Date.now(),
    }));
  const visitors = listCollection('visitors')
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit)
    .map((item) => ({
      type: 'visitor',
      title: prettyPage(item.page),
      meta: item.date || '',
      timestamp: item.timestamp || Date.now(),
    }));
  return [...orders, ...events, ...visitors]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit);
}
