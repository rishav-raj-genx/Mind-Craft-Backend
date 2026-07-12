/**
 * calendarExport.js — Google Calendar Event Export
 *
 * Helper function that maps an accepted Mindcraft tutoring session to a
 * Google Calendar event using the googleapis OAuth2 client. Requires
 * the user's Google OAuth tokens (obtained via the /api/auth/google flow).
 *
 * Maps session fields:
 *   - skill         → event summary
 *   - scheduledAt   → start time
 *   - mode          → location / conferencing
 *   - notes         → event description
 *   - matchId       → extended property for linking back
 */

const { google } = require('googleapis');

/**
 * Creates an OAuth2 client with the application's credentials.
 * @returns {import('googleapis').Auth.OAuth2Client}
 */
function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

/**
 * Generates the Google OAuth2 authorization URL.
 * The frontend should redirect the user to this URL to grant calendar access.
 *
 * @param {string} [state] — Optional state param for CSRF protection
 * @returns {string} Authorization URL
 */
function getAuthUrl(state = '') {
  const oAuth2Client = createOAuth2Client();
  return oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state,
    prompt: 'consent',
  });
}

/**
 * Exchanges an authorization code for OAuth tokens.
 *
 * @param {string} code — Authorization code from Google callback
 * @returns {Promise<{ access_token: string, refresh_token?: string }>}
 */
async function exchangeCodeForTokens(code) {
  const oAuth2Client = createOAuth2Client();
  const { tokens } = await oAuth2Client.getToken(code);
  return tokens;
}

/**
 * Exports a tutoring session to the user's Google Calendar.
 *
 * @param {object} session   — Session object from Neo4j
 * @param {string} session.skill        — Skill being taught
 * @param {number} session.scheduledAt  — Epoch millis
 * @param {string} session.mode         — 'Online' or 'In-Person'
 * @param {string} [session.meetLink]   — Google Meet URL (if online)
 * @param {string} [session.location]   — Physical location (if in-person)
 * @param {string} [session.notes]      — Additional notes
 * @param {string} session.sessionId    — For linking back
 * @param {string} session.matchId      — For linking back
 * @param {object} tokens               — Google OAuth tokens
 * @param {string} tokens.access_token
 * @param {string} [tokens.refresh_token]
 * @param {string} peerName             — Name of the other user (for event summary)
 * @param {string} [peerEmail]          — Email of the other user (for attendees)
 * @returns {Promise<{ eventId: string, htmlLink: string, meetLink?: string }>}
 */
async function exportSessionToCalendar(session, tokens, peerName = 'Peer', peerEmail = null) {
  if (!process.env.GOOGLE_CLIENT_ID) {
    throw Object.assign(
      new Error('Google Calendar API not configured. Set GOOGLE_CLIENT_ID in .env'),
      { statusCode: 503 },
    );
  }

  const oAuth2Client = createOAuth2Client();
  oAuth2Client.setCredentials(tokens);

  const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

  // ── Map session to calendar event ─────────────────────────────────
  const startDate = new Date(session.scheduledAt);
  const endDate   = new Date(startDate.getTime() + 60 * 60 * 1000); // 1-hour session

  const event = {
    summary:     `🎓 Mindcraft: ${session.skill} with ${peerName}`,
    description: buildDescription(session, peerName),
    start: {
      dateTime: startDate.toISOString(),
      timeZone: 'Asia/Kolkata',
    },
    end: {
      dateTime: endDate.toISOString(),
      timeZone: 'Asia/Kolkata',
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 30 },
        { method: 'popup', minutes: 10 },
      ],
    },
    extendedProperties: {
      private: {
        mindcraft_session_id: session.sessionId || '',
        mindcraft_match_id:   session.matchId   || '',
      },
    },
    attendees: peerEmail ? [{ email: peerEmail }] : [],
  };

  // ── Add location or conferencing based on mode ────────────────────
  if (session.mode === 'Online') {
    if (session.meetLink) {
      event.location = session.meetLink;
      event.conferenceData = {
        entryPoints: [
          {
            entryPointType: 'video',
            uri:            session.meetLink,
            label:          'Google Meet',
          },
        ],
        conferenceSolution: {
          name: 'Google Meet',
          key:  { type: 'hangoutsMeet' },
        },
      };
    } else {
      // Auto-generate meet link
      event.conferenceData = {
        createRequest: {
          requestId: session.sessionId || Math.random().toString(36).substring(7),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
    }
  } else if (session.mode === 'In-Person' && session.location) {
    event.location = session.location;
  }

  // ── Insert the event ──────────────────────────────────────────────
  const response = await calendar.events.insert({
    calendarId:               'primary',
    resource:                 event,
    conferenceDataVersion:    session.mode === 'Online' ? 1 : 0,
    sendUpdates:              'none',
  });

  console.log(`📅 Calendar event created: ${response.data.htmlLink}`);
  
  let generatedMeetLink = null;
  if (session.mode === 'Online' && !session.meetLink && response.data.conferenceData) {
    const entryPoint = response.data.conferenceData.entryPoints?.find(ep => ep.entryPointType === 'video');
    if (entryPoint && entryPoint.uri) {
      generatedMeetLink = entryPoint.uri;
      console.log(`📹 Generated Meet Link: ${generatedMeetLink}`);
    }
  }

  return {
    eventId:  response.data.id,
    htmlLink: response.data.htmlLink,
    meetLink: generatedMeetLink,
  };
}

/**
 * Builds a rich description for the calendar event.
 */
function buildDescription(session, peerName) {
  const lines = [
    `📚 Skill: ${session.skill}`,
    `👤 Peer: ${peerName}`,
    `📍 Mode: ${session.mode}`,
  ];

  if (session.meetLink)  lines.push(`🔗 Meet: ${session.meetLink}`);
  if (session.location)  lines.push(`📍 Location: ${session.location}`);
  if (session.notes)     lines.push(`\n📝 Notes:\n${session.notes}`);

  lines.push('\n—\nScheduled via Mindcraft 🧠');
  return lines.join('\n');
}

module.exports = {
  createOAuth2Client,
  getAuthUrl,
  exchangeCodeForTokens,
  exportSessionToCalendar,
};
