/**
 * auth.js — Firebase Authentication Middleware
 *
 * Verifies Firebase ID tokens sent from the Android client in the
 * Authorization header. Extracts uid, email, and name from the
 * decoded token and attaches them to req.user for downstream handlers.
 */

const { auth } = require('../config/firebase');

/**
 * Express middleware that validates a Firebase ID token.
 *
 * Expected header:
 *   Authorization: Bearer <firebase-id-token>
 *
 * On success, sets req.user = { uid, email, name, picture }
 * On failure, returns 401 Unauthorized.
 */
async function verifyFirebaseToken(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Missing or malformed Authorization header. Expected: Bearer <token>',
    });
  }

  const idToken = header.split('Bearer ')[1];

  try {
    const decoded = await auth.verifyIdToken(idToken);

    // Attach verified user info to the request object
    req.user = {
      uid:     decoded.uid,
      email:   decoded.email   || '',
      name:    decoded.name    || '',
      picture: decoded.picture || '',
    };

    next();
  } catch (err) {
    console.error('🔒 Token verification failed:', err.code || err.message);

    const status = err.code === 'auth/id-token-expired' ? 401 : 403;
    return res.status(status).json({
      success: false,
      error:
        err.code === 'auth/id-token-expired'
          ? 'Token has expired. Please re-authenticate.'
          : 'Invalid authentication token.',
    });
  }
}

/**
 * Optional auth middleware — sets req.user if a valid token exists,
 * but does not block the request if it's missing.
 */
async function optionalAuth(req, _res, next) {
  const header = req.headers.authorization;

  if (header && header.startsWith('Bearer ')) {
    try {
      const idToken = header.split('Bearer ')[1];
      const decoded = await auth.verifyIdToken(idToken);
      req.user = {
        uid:     decoded.uid,
        email:   decoded.email   || '',
        name:    decoded.name    || '',
        picture: decoded.picture || '',
      };
    } catch (_err) {
      // Silently ignore — user just won't be authenticated
      req.user = null;
    }
  } else {
    req.user = null;
  }

  next();
}

module.exports = { verifyFirebaseToken, optionalAuth };
