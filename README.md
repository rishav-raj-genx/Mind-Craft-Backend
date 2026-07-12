# Mindcraft Backend

Production backend for Mindcraft, built with Node.js, Express, Neo4j AuraDB, Firebase Auth, Sarvam AI, WebSockets, and Render cron workflows.

## Tech Stack

- Node.js 20+
- Express
- Neo4j AuraDB using Bolt
- Firebase Admin SDK for authentication verification and FCM
- Sarvam AI speech-to-text and Indic LLM study hints
- WebSocket chat/notifications
- Render Blueprint and cron workflow
- `sharp` + `multer` for compressed doubt image uploads

## Local Setup

```bash
cd backend
npm install
cp .env.example .env # if you create one, otherwise edit .env manually
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

## Required Environment Variables

```env
PORT=3000
NODE_ENV=development

NEO4J_URI=bolt+s://your-aura-instance.databases.neo4j.io
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password
NEO4J_DATABASE=neo4j

FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}

SARVAM_API_KEY=your-sarvam-api-key
SARVAM_STT_URL=https://api.sarvam.ai/speech-to-text
SARVAM_CHAT_URL=https://api.sarvam.ai/v1/chat/completions

CORS_ORIGIN=*
```

Optional Google Calendar/Meet variables:

```env
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
```

## Scripts

```bash
npm start                  # production server
npm run dev                # watch-mode development server
npm run workflow:weekly-audit
npm run db:clear           # guarded AuraDB wipe, requires CONFIRM_CLEAR_AURADB=YES
```

## Main API Areas

- `GET /health`
- `/api/auth`
- `/api/user`
- `/api/match`
- `/api/chat`
- `/api/doubt`
- `/api/session`
- `/api/voice-search`
- gamification routes for tokens, streaks, and badges

## Sarvam AI Doubt Assist

When a doubt is posted, the backend:

1. Sends the title/content/tag to Sarvam's Indic LLM endpoint.
2. Requests a short bilingual English/Hindi study hint.
3. Rejects repeated generic hints and retries with a stricter prompt.
4. Falls back to a topic-specific local hint if Sarvam times out or fails.
5. Stores the result directly on the Neo4j `Doubt` node as `aiHint`.

## Doubt Image Uploads

The doubt route accepts up to 4 images in the multipart field:

```txt
images
```

Each image is:

1. validated by MIME type and size,
2. compressed to WebP with `sharp`,
3. stored on the `Doubt` node as JSON in the `images` property,
4. returned to clients for thumbnail/slideshow display.

## Render Deployment

### If Deploying From The Full Monorepo

Use the root repository containing:

```txt
backend/
frontend-react/
render.yaml
```

In Render:

- New + -> Blueprint
- Branch: `main`
- Blueprint Path: `render.yaml`

The root `render.yaml` already uses:

```yaml
rootDir: backend
```

### If Deploying From A Backend-Only Repo

If your GitHub repo only contains backend files like:

```txt
server.js
package.json
src/
```

then use `backend/render.yaml` as that repo's root `render.yaml`. It intentionally does not use `rootDir: backend`.

## Pre-Deployment Checks

```bash
cd backend
node --check server.js
node --check src/routes/doubt.js
node --check src/services/sarvamAI.js
node --check src/workflows/weeklyAudit.js
node --check scripts/clearAuraDb.js
```

## Clearing AuraDB Before Demo

This is destructive:

```bash
cd backend
CONFIRM_CLEAR_AURADB=YES npm run db:clear
```

It runs:

```cypher
MATCH (n) DETACH DELETE n;
```
