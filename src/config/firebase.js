/**
 * firebase.js — Firebase Admin SDK Initialization
 *
 * Initializes the Admin SDK for token verification.
 * Supports either FIREBASE_SERVICE_ACCOUNT_JSON on hosted environments
 * or FIREBASE_SERVICE_ACCOUNT_PATH for local development.
 */

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

let serviceAccount = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (err) {
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON:', err.message);
  }
} else {
  const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    ? path.resolve(__dirname, '../../', process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
    : path.resolve(__dirname, '../../serviceAccountKey.json');

  if (fs.existsSync(keyPath)) {
    serviceAccount = require(keyPath);
  } else {
    console.warn(
      '⚠️  Firebase service account key not found at:',
      keyPath,
      '\n   → Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH for auth.',
    );
  }
}

// ── Initialize the Admin app ──────────────────────────────────────────
if (serviceAccount) {
  const projectId = serviceAccount.project_id || 'mind-craft-5191e';
  const appConfig = {
    credential: admin.credential.cert(serviceAccount),
  };

  admin.initializeApp(appConfig);
  console.log(`✅ Firebase Admin SDK initialized (project: ${projectId})`);
} else {
  // Initialize without credentials so the app can still start
  // (useful for development when key is not yet set up)
  admin.initializeApp({
    projectId: 'mind-craft-5191e',
  });
  console.warn('⚠️  Firebase initialized in limited mode (no service account)');
}

// ── Export shared instances ───────────────────────────────────────────
const auth = admin.auth();

module.exports = { admin, auth };
