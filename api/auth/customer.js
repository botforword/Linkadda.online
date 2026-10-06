import crypto from 'node:crypto';
import { deriveCustomerId, handleCors, verifyAdminRequest } from '../_utils.js';

let cachedToken = null;
let tokenExpiresAt = 0;

async function getFirebaseAdminToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }
  const apiKey = (process.env.FIREBASE_API_KEY || '').trim();
  const adminEmail = (process.env.admin || '').trim();
  const adminPassword = (process.env.password || '').trim();

  if (!apiKey || !adminEmail || !adminPassword) {
    return null;
  }

  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword, returnSecureToken: true }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.idToken) {
      cachedToken = data.idToken;
      tokenExpiresAt = Date.now() + (Number(data.expiresIn) || 3600) * 1000;
      return cachedToken;
    }
  } catch (err) {
    console.warn('Firebase admin token error:', err.message);
  }
  return null;
}

export const computeCustomerId = deriveCustomerId;

export async function fetchCustomerRecord(uid, token) {
  const authQuery = token ? `?auth=${encodeURIComponent(token)}` : '';

  // 1. Try standard /customers/ node
  try {
    const res = await fetch(`https://linkadda-online-default-rtdb.firebaseio.com/customers/${encodeURIComponent(uid)}.json${authQuery}`);
    if (res.ok) {
      const data = await res.json();
      if (data && !data.error && data.email) return data;
    }
  } catch (_) {}

  // 2. Try guaranteed /events/customers/ node
  try {
    const res = await fetch(`https://linkadda-online-default-rtdb.firebaseio.com/events/customers/${encodeURIComponent(uid)}.json${authQuery}`);
    if (res.ok) {
      const data = await res.json();
      if (data && !data.error && data.email) return data;
    }
  } catch (_) {}

  return null;
}

export async function fetchAllCustomers(token) {
  const authQuery = token ? `?auth=${encodeURIComponent(token)}` : '';
  const customerMap = new Map();

  // 1. Read from /events/customers
  try {
    const res = await fetch(`https://linkadda-online-default-rtdb.firebaseio.com/events/customers.json${authQuery}`);
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') {
        Object.keys(data).forEach(key => {
          const item = data[key];
          if (item && item.email) {
            customerMap.set(item.email.toLowerCase().trim(), item);
          }
        });
      }
    }
  } catch (err) {
    console.warn('Fetch all from events/customers notice:', err.message);
  }

  // 2. Read from /customers
  try {
    const res = await fetch(`https://linkadda-online-default-rtdb.firebaseio.com/customers.json${authQuery}`);
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') {
        Object.keys(data).forEach(key => {
          const item = data[key];
          if (item && item.email) {
            const emailKey = item.email.toLowerCase().trim();
            const existing = customerMap.get(emailKey);
            customerMap.set(emailKey, { ...existing, ...item });
          }
        });
      }
    }
  } catch (_) {}

  const list = Array.from(customerMap.values());
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return list;
}

export async function saveCustomerRecord(uid, customer, token) {
  const authQuery = token ? `?auth=${encodeURIComponent(token)}` : '';
  let saved = false;

  // 1. Save to /events/customers/ (guaranteed permitted on active RTDB)
  try {
    const res = await fetch(`https://linkadda-online-default-rtdb.firebaseio.com/events/customers/${encodeURIComponent(uid)}.json${authQuery}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(customer),
    });
    if (res.ok) {
      const data = await res.json();
      if (!data?.error) saved = true;
    }
  } catch (err) {
    console.warn('Save to events/customers error:', err.message);
  }

  // 2. Also save to standard /customers/ (when database.rules.json is active)
  try {
    await fetch(`https://linkadda-online-default-rtdb.firebaseio.com/customers/${encodeURIComponent(uid)}.json${authQuery}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(customer),
    });
  } catch (_) {}

  return saved;
}

export async function deleteCustomerRecord(uid, token) {
  const authQuery = token ? `?auth=${encodeURIComponent(token)}` : '';
  try {
    await fetch(`https://linkadda-online-default-rtdb.firebaseio.com/events/customers/${encodeURIComponent(uid)}.json${authQuery}`, {
      method: 'DELETE',
    });
  } catch (_) {}
  try {
    await fetch(`https://linkadda-online-default-rtdb.firebaseio.com/customers/${encodeURIComponent(uid)}.json${authQuery}`, {
      method: 'DELETE',
    });
  } catch (_) {}
}

async function isAuthorizedAdmin(req) {
  return await verifyAdminRequest(req);
}

export default async function handler(req, res) {
  if (handleCors(req, res, 'GET, POST, OPTIONS')) return;

  const token = await getFirebaseAdminToken();

  // Helper to extract query parameters safely
  const query = (() => {
    if (req.query && typeof req.query === 'object') return req.query;
    try {
      const url = new URL(req.url || '', 'http://localhost');
      const params = {};
      for (const [k, v] of url.searchParams.entries()) {
        params[k] = v;
      }
      return params;
    } catch (_) {
      return {};
    }
  })();

  // GET: Fetch all customers (Admin only) or fetch individual customer by email / uid
  if (req.method === 'GET') {
    const wantsListAll = query.all === 'true' || query.list === 'true';

    if (wantsListAll) {
      const authorized = await isAuthorizedAdmin(req);
      if (!authorized) {
        return res.status(403).json({ error: 'Unauthorized. Admin credentials required to list customers.' });
      }

      try {
        const users = await fetchAllCustomers(token);
        return res.status(200).json({
          success: true,
          count: users.length,
          users,
        });
      } catch (err) {
        return res.status(500).json({ error: err.message || 'Failed to list users.' });
      }
    }

    const email = String(query.email || '').toLowerCase().trim();
    let uid = String(query.uid || '').trim();

    if (!uid && email) {
      uid = computeCustomerId(email);
    }

    if (!uid) {
      return res.status(400).json({ error: 'Please provide email or uid parameter.' });
    }

    try {
      const customer = await fetchCustomerRecord(uid, token);
      const isAuthorized = await isAuthorizedAdmin(req);

      // Sanitize customer details for unauthenticated requests to prevent PII harvesting
      const safeCustomer = customer ? {
        uid: customer.uid,
        displayName: customer.displayName || 'Customer',
        hasSavedName: customer.hasSavedName !== false,
        email: query.email ? customer.email : undefined,
      } : null;

      return res.status(200).json({
        success: true,
        uid,
        customer: isAuthorized ? customer : safeCustomer,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to fetch customer record.' });
    }
  }

  // POST: Create, unify, or update customer profile (handles Name and Email edits!)
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (!body && typeof req.on === 'function') {
        body = await new Promise((resolve) => {
          let data = '';
          req.on('data', chunk => { data += chunk; });
          req.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (_) { resolve({}); }
          });
          req.on('error', () => resolve({}));
        });
      } else if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) { body = {}; }
      }
      body = body || {};

      const email = String(body.email || body.newEmail || '').toLowerCase().trim();
      const oldEmail = String(body.oldEmail || '').toLowerCase().trim();
      const oldUid = String(body.oldUid || '').trim() || (oldEmail ? computeCustomerId(oldEmail) : null);

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'A valid email address is required.' });
      }

      const uid = computeCustomerId(email);
      const fallbackName = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      const incomingProvider = String(body.provider || 'email_otp').trim();

      // Retrieve existing customer record (checking new UID first, or old UID if email changed)
      let existing = await fetchCustomerRecord(uid, token);
      if (!existing && oldUid && oldUid !== uid) {
        existing = await fetchCustomerRecord(oldUid, token);
      }

      // Determine display name:
      // Priority 1: Explicitly provided newName, name, or displayName in current request
      const incomingName = String(body.newName || body.name || body.displayName || '').trim();
      let finalDisplayName = fallbackName;
      if (incomingName && incomingName !== fallbackName) {
        finalDisplayName = incomingName;
      } else if (existing?.displayName && existing.displayName !== fallbackName) {
        finalDisplayName = existing.displayName;
      } else if (incomingName) {
        finalDisplayName = incomingName;
      }

      // Combine auth providers into unified list
      const existingProviders = Array.isArray(existing?.providers)
        ? existing.providers
        : (existing?.provider ? [existing.provider] : []);
      const mergedProviders = Array.from(new Set([...existingProviders, incomingProvider].filter(Boolean)));

      const unifiedCustomer = {
        uid,
        email,
        displayName: finalDisplayName,
        provider: incomingProvider,
        providers: mergedProviders.length ? mergedProviders : [incomingProvider],
        verified: true,
        createdAt: existing?.createdAt || Date.now(),
        lastLoginAt: Date.now(),
        updatedAt: Date.now(),
      };

      await saveCustomerRecord(uid, unifiedCustomer, token);

      // If email changed and old UID exists, verify caller is authorized before deleting old account!
      if (oldUid && oldUid !== uid) {
        const isMasterAdmin = await isAuthorizedAdmin(req);
        const authHeader = req?.headers?.authorization || req?.headers?.Authorization || '';
        const clientToken = authHeader.replace(/^Bearer\s+/i, '').trim();

        let isAuthorizedSession = isMasterAdmin;
        if (!isAuthorizedSession && clientToken && clientToken.includes('.')) {
          const [expiresStr, sig] = clientToken.split('.');
          const secret = getAuthSecret();
          const expectedSig = crypto.createHmac('sha256', secret).update(`${oldEmail || email}:${expiresStr}`).digest('hex');
          if (Date.now() < Number(expiresStr) && sig === expectedSig) {
            isAuthorizedSession = true;
          }
        }

        if (!isAuthorizedSession) {
          return res.status(403).json({
            error: 'Unauthorized: Valid customer session token required to migrate or delete previous customer account.',
          });
        }

        await deleteCustomerRecord(oldUid, token);
      }

      return res.status(200).json({
        success: true,
        customer: unifiedCustomer,
        isNew: !existing,
      });
    } catch (err) {
      console.error('Customer handler error:', err);
      return res.status(500).json({ error: err.message || 'Internal server error resolving customer.' });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
