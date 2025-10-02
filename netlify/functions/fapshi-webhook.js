// netlify/functions/fapshi-webhook.js
'use strict';

const admin = require('firebase-admin');
const crypto = require('crypto'); // présent si tu veux implémenter la vérif de signature

// Helpers pour initialiser Firebase (supporte BASE64 ou ENV VARS)
function initFirebaseFromBase64(base64) {
  try {
    const svcJson = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(svcJson) });
    }
    console.log('✅ Firebase initialized from SERVICE_ACCOUNT_BASE64.');
    return true;
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

    // Corriger les '\n' échappés si nécessaire
    privateKey = privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey;

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey
        })
      });
    }
    console.log('✅ Firebase initialized from ENV VARS.');
    return true;
  } catch (err) {
    console.error('❌ Failed to init Firebase from ENV VARS:', err.message);
    throw err;
  }
}

function ensureFirebaseInitialized() {
  if (admin.apps.length) {
    console.log('✅ Firebase already initialized.');
    return;
  }

  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (base64) {
    initFirebaseFromBase64(base64);
    return;
  }

  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    initFirebaseFromEnv();
    return;
  }

  throw new Error('Firebase credentials not provided (BASE64 or ENV VARS).');
}

// Helper parse body safely
function parseEventBody(event) {
  if (!event || !event.body) return null;
  try {
    // Netlify fournit event.body en string JSON
    return typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (err) {
    console.warn('Warning: failed to parse event.body as JSON:', err.message);
    return null;
  }
}

// Netlify handler
exports.handler = async (event, context) => {
  console.log('>>> Fapshi Webhook received.');
  console.log('>>> Request Method:', event.httpMethod || event.http_method || event.method);
  console.log('>>> Request Headers:', JSON.stringify(event.headers || {}, null, 2));

  if ((event.httpMethod || event.method) !== 'POST') {
    console.warn('>>> Method Not Allowed. Expected POST, got', event.httpMethod || event.method);
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  // Try initialize Firebase admin
  try {
    ensureFirebaseInitialized();
  } catch (initErr) {
    console.error('❌ Firebase initialization failed or missing credentials:', initErr.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Clé privée Firebase non configurée ou invalide.', details: initErr.message })
    };
  }

  // NOTE: signature verification disabled by default (for testing)
  console.warn('⚠️ WARNING: Fapshi signature verification is DISABLED for testing purposes. Re-enable for production!');

  // Parse body (and log it)
  const body = parseEventBody(event);
  console.log('>>> Fapshi Webhook Body:', body ? JSON.stringify(body, null, 2) : '<empty or invalid JSON>');

  if (!body) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Body JSON invalide ou manquant' })
    };
  }

  // Extract fields expected from Fapshi webhook
  // Exemple: { status: 'SUCCESSFUL', amount: 100, transId: 'abc123', externalId: 'user-uid' }
  const { status, amount, transId, externalId } = body;

  if (status !== 'SUCCESSFUL' && status !== 'SUCCESS') {
    console.warn(`>>> Transaction status is "${status}". Ignoring non-successful transaction.`);
    // Return 200 so provider does not retry indefinitely
    return { statusCode: 200, body: JSON.stringify({ message: 'Ignoring non-successful transaction.' }) };
  }

  // Basic validation
  if (!transId || (typeof amount === 'undefined' || amount === null || Number.isNaN(Number(amount)))) {
    console.error('❌ Invalid transaction ID or amount in webhook data. transId:', transId, 'Amount:', amount);
    return { statusCode: 400, body: JSON.stringify({ error: 'Données de transaction webhook invalides (ID ou montant manquant/invalide).' }) };
  }

  const db = admin.firestore();

  // Recherche la transaction dans la collection 'fapshiTransactions' par transId
  const fapshiTransactionRef = db.collection('fapshiTransactions').doc(transId.toString());

  let userIdentifier;
  try {
    const fapshiTransactionDoc = await fapshiTransactionRef.get();

    if (!fapshiTransactionDoc.exists) {
      console.error(`❌ Transaction Fapshi (${transId}) not found in fapshiTransactions collection. Cannot link to user.`);
      // Important: retourner 200 pour éviter réessais infinis du provider
      return { statusCode: 200, body: JSON.stringify({ message: 'Transaction Fapshi inconnue, ignorée.' }) };
    }

    const transactionData = fapshiTransactionDoc.data();
    userIdentifier = transactionData.userId || transactionData.externalId || externalId;

    if (!userIdentifier) {
      console.error(`❌ userId missing in fapshiTransactions document for transId: ${transId}`);
      return { statusCode: 500, body: JSON.stringify({ error: 'Impossible de trouver l\'ID utilisateur lié à cette transaction.' }) };
    }

    // Mettre à jour le statut de la transaction Fapshi dans notre base
    await fapshiTransactionRef.update({
      status: 'CONFIRMED',
      dateConfirmed: admin.firestore.FieldValue.serverTimestamp(),
      rawWebhook: body // optionnel: pour debug, tu peux le retirer en prod
    });

    console.log(`✅ Status updated for fapshiTransaction ${transId} to CONFIRMED.`);

  } catch (lookupError) {
    console.error('❌ Error looking up fapshi transaction in Firestore:', lookupError.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur lors de la recherche de la transaction Fapshi.', details: lookupError.message }) };
  }

  // Update user's balance (transactionally)
  const userRef = db.collection('users').doc(userIdentifier.toString());

  try {
    const numericAmount = Number(amount);
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);

      if (!userDoc.exists) {
        console.warn(`>>> User ${userIdentifier} not found in Firestore (during balance update). Creating with initial balance.`);
        t.set(userRef, { balance: numericAmount }, { merge: true });
      } else {
        const currentBalance = userDoc.data().balance || 0;
        const newBalance = Number(currentBalance) + numericAmount;
        t.update(userRef, { balance: newBalance });
        console.log(`>>> Updated balance for user ${userIdentifier}: ${currentBalance} -> ${newBalance}`);
      }
    });

    console.log(`✅ Transaction successful for user ${userIdentifier}. Balance updated by ${amount}.`);
    return { statusCode: 200, body: JSON.stringify({ message: 'Webhook processed successfully.' }) };

  } catch (firestoreError) {
    console.error('❌ Firestore balance update transaction failed:', firestoreError.message);
    // On renvoie 500 pour alerter (provider pourrait réessayer), selon stratégie
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur lors de la mise à jour du solde Firebase.', details: firestoreError.message }) };
  }
};
