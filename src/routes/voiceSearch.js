/**
 * voiceSearch.js — Sarvam AI Vernacular Voice Search Route
 *
 * Receives audio blobs via multipart upload, validates MIME type and
 * file size at the API gate, transcribes via Sarvam AI, extracts the
 * skill intent, and feeds it into the Neo4j matching engine.
 *
 * Endpoints:
 *   POST /api/voice-search — Upload audio → transcript → skill → matches
 */

const express = require('express');
const multer  = require('multer');
const router  = express.Router();

const { verifyFirebaseToken } = require('../middleware/auth');
const { transcribeAudio, SUPPORTED_LANGUAGES } = require('../services/sarvamAI');
const { extractSkillIntent }  = require('../services/intentParser');
const { findMatches }         = require('../services/matchingEngine');
const {
  ALLOWED_AUDIO_MIMES,
  MAX_AUDIO_SIZE_BYTES,
} = require('../utils/constants');

// ── Multer configuration with strict validation ───────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_AUDIO_SIZE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_AUDIO_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error(
        `Invalid audio format: "${file.mimetype}". ` +
        `Accepted formats: ${ALLOWED_AUDIO_MIMES.join(', ')}`,
      );
      err.statusCode = 415; // Unsupported Media Type
      cb(err, false);
    }
  },
});

/**
 * MIME-type and file-size verification middleware.
 *
 * Runs BEFORE the multer upload to catch oversized or wrongly-typed
 * requests at the API gate with clean error messages.
 */
function validateAudioHeaders(req, res, next) {
  const contentType = req.headers['content-type'] || '';

  if (!contentType.includes('multipart/form-data')) {
    return res.status(400).json({
      success: false,
      error: 'Request must be multipart/form-data with an audio file.',
    });
  }

  // Check Content-Length if provided
  const contentLength = parseInt(req.headers['content-length'], 10);
  if (contentLength && contentLength > MAX_AUDIO_SIZE_BYTES) {
    return res.status(413).json({
      success: false,
      error: `Audio file too large. Maximum size: ${MAX_AUDIO_SIZE_BYTES / (1024 * 1024)} MB.`,
    });
  }

  next();
}

// ── POST /api/voice-search ────────────────────────────────────────────
router.post(
  '/',
  verifyFirebaseToken,
  validateAudioHeaders,
  upload.single('audio'),
  async (req, res, next) => {
    try {
      // ── Validate file presence ──────────────────────────────────
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No audio file provided. Send as multipart field named "audio".',
        });
      }

      const languageCode = req.body.languageCode || 'hi-IN';

      // Validate language code
      if (!SUPPORTED_LANGUAGES[languageCode]) {
        return res.status(400).json({
          success: false,
          error: `Unsupported language: "${languageCode}". Supported: ${Object.keys(SUPPORTED_LANGUAGES).join(', ')}`,
        });
      }

      // ── Step 1: Transcribe audio via Sarvam AI ──────────────────
      const transcription = await transcribeAudio(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        { languageCode },
      );

      // ── Step 2: Extract skill intent from transcript ────────────
      const intent = extractSkillIntent(transcription.transcript);

      // ── Step 3: Query Neo4j if skill detected ───────────────────
      let matches = [];
      if (intent.skill) {
        try {
          matches = await findMatches(req.user.uid, {
            limit: 10,
            skillFilter: intent.skill,
          });
        } catch (err) {
          console.warn('⚠️  Neo4j match query skipped:', err.message);
        }
      }

      res.json({
        success: true,
        data: {
          transcript: transcription.transcript,
          language:   SUPPORTED_LANGUAGES[languageCode],
          detectedSkill: intent.skill,
          confidence:    intent.confidence,
          matchMethod:   intent.method,
          matches,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/voice-search/languages ───────────────────────────────────
router.get('/languages', (_req, res) => {
  res.json({
    success: true,
    data:    SUPPORTED_LANGUAGES,
  });
});

module.exports = router;
