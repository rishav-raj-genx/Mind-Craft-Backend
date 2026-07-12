/**
 * server.js — Mindcraft Backend Entry Point
 *
 * Production-grade Express.js REST API for the Mindcraft P2P college
 * tutoring platform. Zero view engines or templating — pure JSON API.
 *
 * Boot sequence:
 *   1. Load environment variables
 *   2. Initialize Firebase Admin SDK
 *   3. Initialize Neo4j driver + create uniqueness constraints
 *   4. Mount Express middleware + routes
 *   5. Start WebSocket server for real-time chat
 *   6. Listen on configured port
 */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
const http     = require('http');
const compression = require('compression');

// ── Config (imported for side-effect initialization) ──────────────────
require('./src/config/firebase');
const { ensureConstraints, verifyConnectivity, closeDriver } = require('./src/config/neo4j');

// ── Middleware ────────────────────────────────────────────────────────
const { globalErrorHandler, notFoundHandler } = require('./src/middleware/errorHandler');

// ── Routes ───────────────────────────────────────────────────────────
const userRoutes         = require('./src/routes/user');
const matchRoutes        = require('./src/routes/match');
const voiceSearchRoutes  = require('./src/routes/voiceSearch');
const gamificationRoutes = require('./src/routes/gamification');
const chatRoutes         = require('./src/routes/chat');
const sessionRoutes      = require('./src/routes/session');
const doubtRoutes        = require('./src/routes/doubt');
const authRoutes         = require('./src/routes/auth');

// ── Services ─────────────────────────────────────────────────────────
const { initWebSocketServer } = require('./src/services/chatService');

// ── Express app ──────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Global middleware ────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // API-only, no HTML served
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(compression({
  threshold: 1024,
  level: 6,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Health check ─────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    success: true,
    service: 'mindcraft-backend',
    version: '1.0.0',
    uptime:  process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ── API routes ───────────────────────────────────────────────────────
app.use('/api/user',         userRoutes);
app.use('/api/match',        matchRoutes);
app.use('/api/voice-search', voiceSearchRoutes);
app.use('/api',              gamificationRoutes);
app.use('/api/chat',         chatRoutes);
app.use('/api/session',      sessionRoutes);
app.use('/api/doubt',        doubtRoutes);
app.use('/api/auth',         authRoutes);

// ── 404 + error handling ─────────────────────────────────────────────
app.use(notFoundHandler);
app.use(globalErrorHandler);

// ── Create HTTP server (shared with WebSocket) ───────────────────────
const httpServer = http.createServer(app);

// ── Boot sequence ────────────────────────────────────────────────────
async function boot() {
  console.log('\n🧠 ══════════════════════════════════════════════');
  console.log('   MINDCRAFT BACKEND — Starting up…');
  console.log('══════════════════════════════════════════════\n');

  // 1. Neo4j — verify connectivity + create constraints
  const neo4jConnected = await verifyConnectivity();
  if (neo4jConnected) {
    await ensureConstraints();
  } else {
    console.warn('⚠️  Neo4j unavailable — graph features will be degraded');
  }

  // 2. WebSocket server for real-time chat
  initWebSocketServer(httpServer);

  // 3. Start listening
  httpServer.listen(PORT, () => {
    console.log(`\n🚀 Mindcraft backend listening on port ${PORT}`);
    console.log(`   Health:        http://localhost:${PORT}/health`);
    console.log(`   API base:      http://localhost:${PORT}/api`);
    console.log(`   WebSocket:     ws://localhost:${PORT}/ws`);
    console.log(`   Environment:   ${process.env.NODE_ENV || 'development'}\n`);
  });

  // ── Graceful shutdown ───────────────────────────────────────────
  const shutdown = async (signal) => {
    console.log(`\n⏹️  ${signal} received — shutting down gracefully…`);

    httpServer.close(() => {
      console.log('   ✔ HTTP server closed');
    });

    await closeDriver();
    console.log('   ✔ All connections closed. Goodbye! 👋\n');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

boot().catch((err) => {
  console.error('❌ Fatal boot error:', err);
  process.exit(1);
});
