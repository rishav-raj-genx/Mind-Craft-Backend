const express = require('express');
const router = express.Router();
const { exchangeCodeForTokens } = require('../services/calendarExport');

// ── GET /api/auth/google/callback ───────────────────────────────────────
// Handles the redirect from Google OAuth. Must match the exact URI in
// Google Cloud Console. Returns HTML that posts the tokens back to the
// opener window and closes the popup.
router.get('/google/callback', async (req, res, next) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).send('Authorization code is required');
    }

    const tokens = await exchangeCodeForTokens(code);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authenticating...</title>
        </head>
        <body>
          <script>
            // Send tokens back to the parent window
            if (window.opener) {
              window.opener.postMessage({ googleTokens: ${JSON.stringify(tokens)} }, '*');
            }
            // Close the popup
            window.close();
          </script>
          <p>Authentication complete. You can close this window.</p>
        </body>
      </html>
    `;

    res.send(html);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('Authentication failed: ' + (err.message || 'Unknown error'));
  }
});

module.exports = router;
