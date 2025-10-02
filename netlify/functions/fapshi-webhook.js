// netlify/functions/fapshi-webhook.js
const admin = require('firebase-admin');
const bodyParser = require('body-parser'); // non nécessaire si Netlify t'envoie déjà JSON

if (!admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  const svc = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
  admin.initializeApp({ credential: admin.credential.cert(svc) });
}

exports.handler = async (event) => {
  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    // Exemple: body.transId, body.status, body.externalId
    console.log('Webhook reçu:', body);

    // Si le paiement est confirmé, enregistrer/créditer
    if (body.status === 'SUCCESSFUL' || body.status === 'SUCCESS') {
      const db = admin.firestore();
      const transRef = db.collection('fapshiTransactions').doc(body.transId || body.externalId);
      await transRef.set({ status: 'SUCCESSFUL', confirmedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

      // Exemple : créditer le solde de l'utilisateur (externalId => user uid)
      if (body.externalId) {
        const userRef = db.collection('users').doc(body.externalId);
        // Lecture du solde + update : fais attention aux races, utilise transaction si besoin
        await db.runTransaction(async tx => {
          const snap = await tx.get(userRef);
          const current = snap.exists ? (snap.data().balance || 0) : 0;
          tx.set(userRef, { balance: current + (body.amount || 0) }, { merge: true });
        });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('Webhook error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'internal webhook error' }) };
  }
};
