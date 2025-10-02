// netlify/functions/create-fapshi-checkout.js
// Node 18+ (Netlify) - serverless function
const admin = require('firebase-admin');

let firebaseInitialized = false;

function initFirebaseAdmin() {
  if (firebaseInitialized) return;

  const svcBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '';
  if (!svcBase64) {
    console.warn('FIREBASE_SERVICE_ACCOUNT_BASE64 not set. Token verification will be skipped.');
    firebaseInitialized = true;
    return;
  }

  const svcJson = JSON.parse(Buffer.from(svcBase64, 'base64').toString('utf8'));
  admin.initializeApp({
    credential: admin.credential.cert(svcJson),
  });
  firebaseInitialized = true;
}

exports.handler = async (event, context) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ message: 'Method Not Allowed' }) };
    }

    initFirebaseAdmin();

    const body = JSON.parse(event.body || '{}');
    const { amount, currency, description, redirectUrl, externalId } = body;

    if (!amount || amount < 100) {
      return { statusCode: 400, body: JSON.stringify({ message: 'Montant invalide (min 100)' }) };
    }

    // Optionnel : vérification du token Firebase envoyé par le client
    let userIdFromToken = null;
    const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    if (authHeader.startsWith('Bearer ') && admin.apps.length) {
      const idToken = authHeader.split(' ')[1];
      try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        userIdFromToken = decoded.uid;
      } catch (err) {
        // token invalide : on peut refuser ou continuer sans vérif
        console.warn('Impossible de vérifier token Firebase :', err.message);
        return { statusCode: 401, body: JSON.stringify({ message: 'Token invalide' }) };
      }
    }

    // Prépare la requête vers Fapshi (sandbox). Pour production: utilisez l'URL live si indiqué.
    const fapshiUrl = process.env.FAPSHI_ENV === 'production'
      ? 'https://fapshi.com/initiate-pay'    // ajuster si la doc officielle donne une URL différente
      : 'https://sandbox.fapshi.com/initiate-pay';

    const fapshiResp = await fetch(fapshiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apiuser': process.env.FAPSHI_API_USER || '',
        'apikey': process.env.FAPSHI_API_KEY || '',
      },
      body: JSON.stringify({
        amount: Math.round(amount),
        redirectUrl: redirectUrl || '',
        userId: userIdFromToken || '',
        externalId: externalId || '',
        message: description || '',
      })
    });

    const fapshiJson = await fapshiResp.json();

    if (!fapshiResp.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({ message: 'Erreur Fapshi', details: fapshiJson })
      };
    }

    // La doc Fapshi renvoie { message, link, transId, dateInitiated }
    return {
      statusCode: 200,
      body: JSON.stringify({
        checkoutUrl: fapshiJson.link,
        transId: fapshiJson.transId || null,
        message: fapshiJson.message || 'Checkout créé'
      })
    };

  } catch (err) {
    console.error('create-fapshi-checkout error:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Erreur interne', error: err.message }) };
  }
};
