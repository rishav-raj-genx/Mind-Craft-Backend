/**
 * gamification.js — Token Economy, Streak & Badge Routes
 *
 * Endpoints for the Mind Token system, daily consistency streaks, and badges.
 *
 * Endpoints:
 *   GET  /api/tokens/:uid              — Get token balance + recent transactions
 *   POST /api/tokens/award/forum       — Award tokens for forum answer
 *   POST /api/tokens/award/session     — Award tokens for session completion
 *   GET  /api/streak/:uid              — Get streak data + grid + badges
 *   POST /api/streak/checkin           — Record daily check-in (app open)
 *   GET  /api/badges/:uid              — Get dynamic badge progress
 */

const express = require('express');
const { body } = require('express-validator');
const router  = express.Router();

const { verifyFirebaseToken }    = require('../middleware/auth');
const { formatValidationErrors } = require('../middleware/errorHandler');
const {
  awardForumAnswer,
  awardSessionComplete,
  awardStreakBonus,
  getBalance,
  getTransactionHistory,
} = require('../services/tokenEconomy');
const { calculateStreak, recordCheckIn } = require('../services/streakCalculator');
const { calculateBadges, recordBadgeEarned } = require('../services/badgeCalculator');
const { getPagination } = require('../utils/pagination');

// ── GET /api/tokens/:uid ──────────────────────────────────────────────
router.get('/tokens/:uid', verifyFirebaseToken, async (req, res, next) => {
  try {
    const uid   = req.params.uid;
    if (uid !== req.user.uid) return res.status(403).json({ success: false, error: 'Cannot fetch another user\'s token wallet' });
    const { limit } = getPagination(req.query);
    const after = req.query.after || null;

    const [balance, transactions] = await Promise.all([
      getBalance(uid),
      getTransactionHistory(uid, limit, after),
    ]);

    res.json({
      success: true,
      data: {
        balance,
        transactions,
        limit,
        hasMore: transactions.length === limit,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tokens/award/forum ──────────────────────────────────────
router.post(
  '/tokens/award/forum',
  verifyFirebaseToken,
  [],
  async (req, res, next) => {
    try {
      const errors = formatValidationErrors(req);
      if (errors) return res.status(400).json(errors);

      const { questionId } = req.body;
      const uid = req.body.uid || req.user.uid;
      if (uid !== req.user.uid) return res.status(403).json({ success: false, error: 'Cannot award forum tokens to another user' });
      const result = await awardForumAnswer(uid, questionId || '');

      // Check and award streak bonus
      const streak = await calculateStreak(uid);
      let streakBonus = null;
      if ([5, 10, 30].includes(streak.currentStreak)) {
        streakBonus = await awardStreakBonus(uid, streak.currentStreak);
      }

      res.json({
        success: true,
        data: {
          ...result,
          streakBonus,
          currentStreak: streak.currentStreak,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/tokens/award/session ────────────────────────────────────
router.post(
  '/tokens/award/session',
  verifyFirebaseToken,
  [
    body('teacherUid').trim().notEmpty().withMessage('Teacher UID is required'),
    body('learnerUid').trim().notEmpty().withMessage('Learner UID is required'),
    body('sessionId').trim().notEmpty().withMessage('Session ID is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = formatValidationErrors(req);
      if (errors) return res.status(400).json(errors);

      const { teacherUid, learnerUid, sessionId } = req.body;
      const result = await awardSessionComplete(teacherUid, learnerUid, sessionId);

      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/streak/checkin ──────────────────────────────────────────
// Records that the user opened the app today. Idempotent — safe to
// call multiple times per day without creating duplicate entries.
router.post('/streak/checkin', verifyFirebaseToken, async (req, res, next) => {
  try {
    const uid = req.user.uid;

    // Record today's check-in (idempotent)
    const checkInResult = await recordCheckIn(uid);

    // Return full updated streak data
    const streak = await calculateStreak(uid);

    // Check and award streak bonus at milestones
    let streakBonus = null;
    if (!checkInResult.alreadyCheckedIn && streak.currentStreak > 0) {
      if ([5, 10, 30].includes(streak.currentStreak)) {
        streakBonus = await awardStreakBonus(uid, streak.currentStreak);
      }
      const { broadcastToGlobal } = require('../services/chatService');
      broadcastToGlobal(uid, {
        type: 'global_new_message',
        notification: {
          title: 'Streak Increased! 🔥',
          body: `You're now on a ${streak.currentStreak} day streak! Keep going!`,
        },
        data: {
          type: 'streak_update',
          id: `streak-${streak.currentStreak}`,
          route: '/streak',
          matchId: '',
        }
      });
    }

    res.json({
      success: true,
      data: {
        ...streak,
        alreadyCheckedIn: checkInResult.alreadyCheckedIn,
        streakBonus,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/streak/:uid ──────────────────────────────────────────────
router.get('/streak/:uid', verifyFirebaseToken, async (req, res, next) => {
  try {
    const uid    = req.params.uid;
    if (uid !== req.user.uid) return res.status(403).json({ success: false, error: 'Cannot fetch another user\'s streak' });
    const streak = await calculateStreak(uid);

    res.json({
      success: true,
      data: {
        currentStreak:   streak.currentStreak,
        longestStreak:   streak.longestStreak,
        activeDates:     streak.activeDates,
        grid:            streak.grid,
        badges:          streak.badges,
        streakFreezes:   streak.streakFreezes,
        totalActiveDays: streak.totalActiveDays,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/badges/:uid ──────────────────────────────────────────────
router.get('/badges/:uid', verifyFirebaseToken, async (req, res, next) => {
  try {
    const uid = req.params.uid;
    if (uid !== req.user.uid) return res.status(403).json({ success: false, error: 'Cannot fetch another user\'s badges' });
    const result = await calculateBadges(uid);

    // Record any newly earned badges in history
    const { broadcastToGlobal } = require('../services/chatService');
    for (const badge of result.badges) {
      if (badge.level > 0) {
        try {
          const isNew = await recordBadgeEarned(uid, badge.id, badge.name, badge.level);
          if (isNew) {
            broadcastToGlobal(uid, {
              type: 'global_new_message',
              notification: {
                title: 'Badge Unlocked! 🏅',
                body: `You unlocked the Level ${badge.level} ${badge.name} badge!`,
              },
              data: {
                type: 'badge_unlocked',
                id: `badge-${badge.id}-${badge.level}`,
                route: '/badges',
                matchId: '',
              }
            });
          }
        } catch (_) { /* non-critical */ }
      }
    }

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
