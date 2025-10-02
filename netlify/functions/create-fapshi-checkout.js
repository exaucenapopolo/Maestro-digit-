// netlify/functions/create-fapshi-checkout.js
// Node 18+ (Netlify) - serverless function
// Robust Fapshi checkout creator: timeout, Firestore logging, token verification, dual-field compatibility

const fetch = globalThis.fetch || ((...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args)));
const admin = require('firebase-admin');

let firebaseInitialized = false;

function initFirebaseFromBase64(base64) {
  try {
    const svcJson = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(svcJson) });
    }
    firebaseInitialized = true;
    console.log('✅ Firebase admin initialized from BASE64.');
  } catch (err) {
    console.error('❌ Failed to init Firebase from BASE64:', err.message);
    throw err;
  }
}

function initFirebaseFromEnv() {
  try {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error('Missing FIREBASE_PROJECT_ID or FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY');
    }

    // Fix escaped newlines if necessary
    privateKey = privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey;

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey })
      });
    }
    firebaseInitialized = true;
    console.log('✅ Firebase admin initialized from ENV VARS.');
  } catch (err) {
    console.error('❌ Failed to init Firebase from ENV VARS:', err.message);
    throw err;
  }
}

function ensureFirebaseInitialized() {
  if (firebaseInitialized) return;

  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (base64) {
    initFirebaseFromBase64(base64);
    return;
  }

  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    initFirebaseFromEnv();
    return;
  }

  // not fatal: continue but token verification & firestore writes will be skipped
  console.warn('⚠️ Firebase admin not initialized: no service account provided (BASE64 or ENV VARS). Token verification & Firestore writes skipped.');
  firebaseInitialized = false;
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

exports.handler = async (event, context) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed. Use POST only' }) };
    }

    // parse incoming body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (err) {
      console.error('Invalid JSON body:', err.message);
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    // required fields
    const { amount, currency = 'XAF', description, redirectUrl, externalId } = body || {};
    if (!amount || !redirectUrl || !externalId) {
      console.error('Missing params:', { amount, redirectUrl, externalId });
      return { statusCode: 400, body: JSON.stringify({ error: 'Paramètres manquants: amount, redirectUrl ou externalId' }) };
    }

    // init firebase admin if possible
    try { ensureFirebaseInitialized(); } catch (e) { console.error('Firebase init error:', e.message); }

    // verify token if present
    const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    let uidFromToken = null;
    if (authHeader && authHeader.startsWith('Bearer ') && admin.apps.length) {
      const idToken = authHeader.split(' ')[1];
      try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        uidFromToken = decoded.uid;
        console.log('Token verified, uid =', uidFromToken);
      } catch (err) {
        console.warn('Invalid Firebase token:', err.message);
        return { statusCode: 401, body: JSON.stringify({ error: 'Token Firebase invalide' }) };
      }
    }

    // read envs (support plusieurs noms)
    const API_USER = process.env.FAPSHI_API_USER || process.env.FAPSHI_APIUSER || process.env.FAPSHI_API;
    const SECRET_KEY = process.env.FAPSHI_API_KEY || process.env.FAPSHI_SECRET_KEY || process.env.FAPSHI_SECRET;
    const WEBHOOK_URL = process.env.FAPSHI_WEBHOOK_URL || process.env.FAPSHI_WEBHOOK;
    const ENV = (process.env.FAPSHI_ENV || process.env.NODE_ENV || '').toLowerCase();

    if (!API_USER || !SECRET_KEY) {
      console.error('Missing Fapshi env vars', { hasApiUser: !!API_USER, hasSecret: !!SECRET_KEY });
      return { statusCode: 500, body: JSON.stringify({ error: 'Configuration serveur Fapshi incomplète' }) };
    }

    // Build payload: include both camelCase and snake_case variants to maximize compatibility
    const payload = {
      amount: Math.round(amount),
      currency,
      description: description || 'Paiement MADIL',
      // both variants:
      redirect_url: redirectUrl,
      redirectUrl: redirectUrl,
      webhook_url: WEBHOOK_URL || undefined,
      webhookUrl: WEBHOOK_URL || undefined,
      metadata: { userId: externalId, uidFromToken: uidFromToken || null }
    };

    // choose endpoint (adjust if Fapshi doc differs)
    const fapshiUrl = (ENV === 'production' || process.env.FAPSHI_LIVE === 'true')
      ? (process.env.FAPSHI_LIVE_URL || 'https://live.fapshi.com/initiate-pay')
      : (process.env.FAPSHI_SANDBOX_URL || 'https://sandbox.fapshi.com/initiate-pay');

    console.log('Calling Fapshi', { fapshiUrl, amount: payload.amount, currency: payload.currency, externalId });

    // timeout handling
    const controller = new AbortController();
    const timeoutMs = parseInt(process.env.FAPSHI_TIMEOUT_MS || '10000', 10); // 10s default
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fapshiResp = await fetch(fapshiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apiuser': API_USER,
          'apikey': SECRET_KEY
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const rawText = await fapshiResp.text();
      const respJson = tryParseJson(rawText);

      console.log('Fapshi response status:', fapshiResp.status);
      console.log('Fapshi response body (truncated):', (typeof rawText === 'string' && rawText.length > 1000) ? rawText.slice(0,1000) + '... (truncated)' : rawText);

      if (!fapshiResp.ok) {
        // return provider response for debugging (but not keys)
        return {
          statusCode: fapshiResp.status === 200 ? 500 : fapshiResp.status,
          body: JSON.stringify({
            error: 'Erreur Fapshi',
            fapshiStatus: fapshiResp.status,
            fapshiBody: respJson || rawText
          })
        };
      }

      // extract URL from common shapes
      const checkoutUrl = respJson?.data?.url || respJson?.link || respJson?.checkoutUrl || respJson?.url;
      const fapshiTransId = respJson?.transId || respJson?.transactionId || respJson?.data?.transId || null;

      if (!checkoutUrl) {
        console.error('Fapshi returned success but no checkout URL', respJson || rawText);
        return {
          statusCode: 502,
          body: JSON.stringify({ error: 'Réponse du processeur incomplète: URL de paiement manquante', details: respJson || rawText })
        };
      }

      // try to record transaction in Firestore (non blocking)
      try {
        if (admin.apps.length) {
          const db = admin.firestore();
          const transactionsRef = db.collection('fapshiTransactions');
          const transactionDocId = fapshiTransId || (Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12));

          await transactionsRef.doc(transactionDocId).set({
            fapshiTransId: fapshiTransId,
            userId: externalId,
            uidFromToken: uidFromToken || null,
            amount: payload.amount,
            currency: payload.currency,
            status: 'PENDING',
            dateInitiated: admin.firestore.FieldValue.serverTimestamp(),
            checkoutUrl
          });

          console.log(`✅ Transaction recorded: ${transactionDocId}`);
        } else {
          console.warn('Firestore not initialized — skipping transaction record');
        }
      } catch (dbErr) {
        console.error('Failed to write transaction to Firestore:', dbErr.message);
        // continue: still return checkoutUrl
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          checkoutUrl,
          transId: fapshiTransId || null,
          raw: respJson || rawText
        })
      };

    } catch (err) {
      if (err.name === 'AbortError') {
        console.error('Fapshi API timeout');
        return { statusCode: 504, body: JSON.stringify({ error: 'Timeout lors de la connexion à Fapshi' }) };
      }
      console.error('Error while calling Fapshi:', err.stack || err.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'Erreur interne lors de la communication avec Fapshi' }) };
    } finally {
      clearTimeout(timeout);
    }

  } catch (err) {
    console.error('Unhandled error in create-fapshi-checkout:', err.stack || err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur interne' }) };
  }
};
