/**
 * user.js — User Management Routes
 *
 * CRUD operations for user profiles, syncing directly with the Neo4j graph.
 * All routes require Firebase authentication (for token validation).
 *
 * Endpoints:
 *   POST   /api/user/register       — Create user profile
 *   GET    /api/user/:uid            — Get user profile
 *   PATCH  /api/user/:uid            — Update user profile
 *   GET    /api/user/:uid/profile    — Full profile (tokens + streak + reviews)
 *   POST   /api/user/:uid/follow      — Follow a user
 *   GET    /api/user/:uid/following   — Get followed users list
 */

const express = require('express');
const { body } = require('express-validator');
const router  = express.Router();

const { verifyFirebaseToken }   = require('../middleware/auth');
const { formatValidationErrors } = require('../middleware/errorHandler');
const { getDriver }             = require('../config/neo4j');
const { getUserSkillGraph }     = require('../services/matchingEngine');
const { getBalance, getTransactionHistory } = require('../services/tokenEconomy');
const { calculateStreak }       = require('../services/streakCalculator');
const { getPagination }         = require('../utils/pagination');
const {
  SESSION_COMPLETED,
} = require('../utils/constants');

// Helper to handle neo4j integer conversion
const toNumber = (val) => (val && val.toNumber ? val.toNumber() : val);
const normalizeUserNumbers = (u) => {
  u.mind_tokens = toNumber(u.mind_tokens) || 0;
  u.tokenBalance = toNumber(u.tokenBalance) || 0;
  u.totalSessions = toNumber(u.totalSessions) || 0;
  u.averageRating = toNumber(u.averageRating) || 0;
  u.latitude = toNumber(u.latitude) || 0;
  u.longitude = toNumber(u.longitude) || 0;
  return u;
};

// ── POST /api/user/register ───────────────────────────────────────────
router.post(
  '/register',
  verifyFirebaseToken,
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('college').trim().notEmpty().withMessage('College is required'),
    body('department').trim().notEmpty().withMessage('Department is required'),
    body('year').trim().notEmpty().withMessage('Year is required'),
    body('teaches').isArray({ min: 1 }).withMessage('At least one teaching skill is required'),
    body('learns').isArray({ min: 1 }).withMessage('At least one learning skill is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = formatValidationErrors(req);
      if (errors) return res.status(400).json(errors);

      const uid = req.user.uid;
      const userData = {
        uid,
        name:              req.body.name,
        email:             req.user.email,
        photoUrl:          req.user.picture || req.body.photoUrl || '',
        college:           req.body.college,
        collegeLocation:   req.body.collegeLocation || '',
        department:        req.body.department,
        year:              req.body.year,
        fcmToken:          req.body.fcmToken || '',
        latitude:          req.body.latitude  || 0,
        longitude:         req.body.longitude || 0,
        lastLocationUpdate: Date.now(),
        averageRating:     0,
        totalSessions:     0,
        tokenBalance:      0,
        mind_tokens:       0, // Using mind_tokens for AuraDB schema as requested
        linkedinUsername:   req.body.linkedinUsername   || '',
        githubUsername:     req.body.githubUsername     || '',
        leetcodeUsername:   req.body.leetcodeUsername   || '',
        codeforcesUsername: req.body.codeforcesUsername || '',
        codechefUsername:   req.body.codechefUsername   || '',
        createdAt:         Date.now(),
      };

      const driver = getDriver();
      const session = driver.session();
      
      try {
        await session.executeWrite(async (tx) => {
          // 1. Create/update User idempotently
          await tx.run(
            `MERGE (u:User { uid: $uid })
             ON CREATE SET u.createdAt = $props.createdAt
             SET u += $props`,
            { uid, props: userData }
          );

          // 2. College
          if (userData.college) {
            await tx.run(
              `MATCH (u:User {uid: $uid})
               OPTIONAL MATCH (u)-[old:BELONGS_TO]->(:College)
               DELETE old
               MERGE (c:College { name: $college })
               WITH c MATCH (u:User {uid: $uid})
               MERGE (u)-[:BELONGS_TO]->(c)`,
              { college: userData.college, uid }
            );
          }

          // 3. Teaches
          const teaches = req.body.teaches || [];
          await tx.run(`MATCH (u:User {uid: $uid})-[r:TEACHES]->() DELETE r`, { uid });
          if (teaches.length > 0) {
            await tx.run(
              `MATCH (u:User {uid: $uid})
               UNWIND $skills AS skillName
               MERGE (s:Skill {name: skillName})
               MERGE (u)-[:TEACHES]->(s)`,
              { uid, skills: teaches }
            );
          }

          // 4. Learns
          const learns = req.body.learns || [];
          await tx.run(`MATCH (u:User {uid: $uid})-[r:LEARNS]->() DELETE r`, { uid });
          if (learns.length > 0) {
            await tx.run(
              `MATCH (u:User {uid: $uid})
               UNWIND $skills AS skillName
               MERGE (s:Skill {name: skillName})
               MERGE (u)-[:LEARNS]->(s)`,
              { uid, skills: learns }
            );
          }
        });
        
        userData.teaches = req.body.teaches;
        userData.learns = req.body.learns;
        res.status(201).json({ success: true, data: userData });
      } finally {
        await session.close();
      }
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/user/metadata/options ────────────────────────────────────
router.get('/metadata/options', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.executeRead(async (tx) => {
      const collegesRes = await tx.run(`MATCH (c:College) RETURN c.name AS name`);
      const deptsRes = await tx.run(`MATCH (u:User) WHERE u.department IS NOT NULL RETURN DISTINCT u.department AS name`);
      return {
        colleges: collegesRes.records.map(r => r.get('name')).sort(),
        departments: deptsRes.records.map(r => r.get('name')).sort()
      };
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  } finally {
    await session.close();
  }
});

// ── GET /api/user/search ──────────────────────────────────────────────
router.get('/search', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const { limit, offset } = getPagination(req.query);
    
    // Using a broad MATCH and filtering in Cypher
    const query = `
      MATCH (u:User)
      WHERE u.uid <> $currentUid
      OPTIONAL MATCH (u)-[:TEACHES]->(ts:Skill)
      OPTIONAL MATCH (u)-[:LEARNS]->(ls:Skill)
      WITH u, collect(DISTINCT ts.name) AS teaches, collect(DISTINCT ls.name) AS learns
      WHERE $q = "" OR 
            toLower(u.name) CONTAINS $q OR 
            toLower(u.email) CONTAINS $q OR 
            toLower(u.college) CONTAINS $q OR 
            toLower(u.department) CONTAINS $q OR
            any(s IN teaches WHERE toLower(s) CONTAINS $q) OR
            any(s IN learns WHERE toLower(s) CONTAINS $q)
      RETURN u, teaches, learns
      ORDER BY u.name ASC
      SKIP toInteger($offset) LIMIT toInteger($limit)
    `;
    
    const result = await session.executeRead(tx => tx.run(query, { currentUid: req.user.uid, q, limit, offset }));
    
    const users = result.records.map(record => {
      const u = record.get('u').properties;
      u.teaches = record.get('teaches');
      u.learns = record.get('learns');
      // Normalize neo4j ints
      return normalizeUserNumbers(u);
    });
    
    res.json({ success: true, count: users.length, limit, offset, hasMore: users.length === limit, data: users });
  } catch (err) {
    next(err);
  } finally {
    await session.close();
  }
});

// ── GET /api/user/:uid ────────────────────────────────────────────────
router.get('/:uid', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.executeRead(tx => 
      tx.run(`
        MATCH (u:User {uid: $uid}) 
        OPTIONAL MATCH (u)-[:TEACHES]->(ts:Skill)
        OPTIONAL MATCH (u)-[:LEARNS]->(ls:Skill)
        RETURN u, collect(DISTINCT ts.name) AS teaches, collect(DISTINCT ls.name) AS learns
      `, { uid: req.params.uid })
    );

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const u = result.records[0].get('u').properties;
    u.teaches = result.records[0].get('teaches');
    u.learns = result.records[0].get('learns');
    normalizeUserNumbers(u);

    res.json({ success: true, data: u });
  } catch (err) {
    next(err);
  } finally {
    await session.close();
  }
});

// ── PATCH /api/user/:uid ──────────────────────────────────────────────
router.patch('/:uid', verifyFirebaseToken, async (req, res, next) => {
  if (req.user.uid !== req.params.uid) {
    return res.status(403).json({ success: false, error: 'Cannot update another user\'s profile' });
  }

  const uid = req.params.uid;
  const allowedFields = [
    'name', 'college', 'collegeLocation', 'department', 'year', 'teaches', 'learns',
    'fcmToken', 'latitude', 'longitude', 'photoUrl', 'bannerUrl',
    'linkedinUsername', 'githubUsername', 'leetcodeUsername', 'codeforcesUsername', 'codechefUsername',
  ];

  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ success: false, error: 'No valid fields to update' });
  }

  const driver = getDriver();
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      // Basic fields
      const basicUpdates = { ...updates };
      delete basicUpdates.teaches;
      delete basicUpdates.learns;
      
      if (Object.keys(basicUpdates).length > 0) {
        await tx.run(
          `MATCH (u:User {uid: $uid}) SET u += $updates`,
          { uid, updates: basicUpdates }
        );
      }
      
      if (updates.college) {
        await tx.run(
          `MATCH (u:User {uid: $uid})-[r:BELONGS_TO]->() DELETE r`,
          { uid }
        );
        await tx.run(
          `MERGE (c:College { name: $college })
           WITH c MATCH (u:User {uid: $uid})
           MERGE (u)-[:BELONGS_TO]->(c)`,
          { college: updates.college, uid }
        );
      }

      if (updates.teaches) {
        await tx.run(`MATCH (u:User {uid: $uid})-[r:TEACHES]->() DELETE r`, { uid });
        if (updates.teaches.length > 0) {
          await tx.run(
            `MATCH (u:User {uid: $uid})
             UNWIND $skills AS skillName
             MERGE (s:Skill {name: skillName})
             MERGE (u)-[:TEACHES]->(s)`,
            { uid, skills: updates.teaches }
          );
        }
      }

      if (updates.learns) {
        await tx.run(`MATCH (u:User {uid: $uid})-[r:LEARNS]->() DELETE r`, { uid });
        if (updates.learns.length > 0) {
          await tx.run(
            `MATCH (u:User {uid: $uid})
             UNWIND $skills AS skillName
             MERGE (s:Skill {name: skillName})
             MERGE (u)-[:LEARNS]->(s)`,
            { uid, skills: updates.learns }
          );
        }
      }
    });

    res.json({
      success: true,
      message: 'Profile updated',
      updatedFields: Object.keys(updates),
      data: { uid, ...updates },
    });
  } catch (err) {
    next(err);
  } finally {
    await session.close();
  }
});

// ── GET /api/user/:uid/profile ────────────────────────────────────────
router.get('/:uid/profile', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const uid = req.params.uid;
    const result = await session.executeRead(tx => 
      tx.run(`
        MATCH (u:User {uid: $uid}) 
        OPTIONAL MATCH (u)-[:TEACHES]->(ts:Skill)
        OPTIONAL MATCH (u)-[:LEARNS]->(ls:Skill)
        RETURN u, collect(DISTINCT ts.name) AS teaches, collect(DISTINCT ls.name) AS learns
      `, { uid })
    );

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const u = result.records[0].get('u').properties;
    u.teaches = result.records[0].get('teaches');
    u.learns = result.records[0].get('learns');
    normalizeUserNumbers(u);

    const [tokenBalance, transactions, streak, skillGraph, sessionData] = await Promise.all([
      getBalance(uid).catch(() => 0),
      getTransactionHistory(uid, 10).catch(() => []),
      calculateStreak(uid).catch(() => ({
        currentStreak: 0,
        longestStreak: 0,
        activeDates: [],
        grid: [],
      })),
      getUserSkillGraph(uid).catch(() => ({ teaches: [], learns: [] })),
      getReviews(uid),
    ]);
    
    const { reviews, stats } = sessionData;

    res.json({
      success: true,
      data: {
        user:         u,
        tokenBalance,
        recentTransactions: transactions,
        streak,
        skillGraph,
        reviews,
        stats,
      },
    });
  } catch (err) {
    next(err);
  } finally {
    await session.close();
  }
});

/**
 * Fetches completed & rated session reviews for a user (as teacher),
 * plus aggregated stats for all completed sessions (as teacher or learner).
 */
async function getReviews(uid) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const [statsResult, reviewsResult] = await session.executeRead(async (tx) => {
      const stats = await tx.run(`
        MATCH (u:User {uid: $uid})-[r:HOSTS|ATTENDS]->(s:Session {status: $status})
        RETURN
          count(s) AS completedSessionsCount,
          coalesce(sum(coalesce(s.duration, 60)), 0) AS totalStudyMins,
          coalesce(avg(CASE WHEN type(r) = 'HOSTS' AND coalesce(s.rating, 0) > 0 THEN s.rating ELSE null END), 0) AS averageRating
      `, { uid, status: SESSION_COMPLETED });

      const reviewsRes = await tx.run(`
        MATCH (u:User {uid: $uid})-[:HOSTS]->(s:Session {status: $status})
        WHERE coalesce(s.rating, 0) > 0
        RETURN s
        ORDER BY s.scheduledAt DESC
        LIMIT 20
      `, { uid, status: SESSION_COMPLETED });

      return [stats, reviewsRes];
    });

    const statsRecord = statsResult.records[0];
    const completedSessionsCount = toNumber(statsRecord?.get('completedSessionsCount')) || 0;
    const totalStudyMins = toNumber(statsRecord?.get('totalStudyMins')) || 0;
    const totalStudyHours = +(totalStudyMins / 60).toFixed(1);
    const avgRating = +(toNumber(statsRecord?.get('averageRating')) || 0).toFixed(1);

    const reviews = reviewsResult.records.map((r) => {
      const s = r.get('s').properties;
      return {
        sessionId:     s.sessionId,
        skill:         s.skill,
        rating:        toNumber(s.rating) || 0,
        ratingComment: s.ratingComment || '',
        learnerUid:    s.learnerUid,
        scheduledAt:   toNumber(s.scheduledAt) || 0,
      };
    });

    return { 
      reviews, 
      stats: { completedSessionsCount, totalStudyHours, averageRating: avgRating }
    };
  } catch (err) {
    console.error('getReviews error', err);
    return { reviews: [], stats: { completedSessionsCount: 0, totalStudyHours: 0, averageRating: 0 } };
  } finally {
    await session.close();
  }
}

// ── POST /api/user/:uid/follow ────────────────────────────────────────
router.post('/:uid/follow', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const followerUid = req.user.uid;
    const targetUid = req.params.uid;

    if (followerUid === targetUid) {
      return res.status(400).json({ success: false, error: 'Cannot follow yourself' });
    }
    
    await session.executeWrite(tx => tx.run(
      `MATCH (u1:User {uid: $followerUid}), (u2:User {uid: $targetUid})
       MERGE (u1)-[:FOLLOWS]->(u2)`,
      { followerUid, targetUid }
    ));

    res.json({ success: true, message: 'Successfully followed user' });
  } catch (err) {
    next(err);
  } finally {
    await session.close();
  }
});

// ── GET /api/user/:uid/following ──────────────────────────────────────
router.get('/:uid/following', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const { limit, offset } = getPagination(req.query);
    const result = await session.executeRead(tx => tx.run(
      `MATCH (u:User {uid: $uid})-[:FOLLOWS]->(f:User)
       RETURN f
       ORDER BY f.name ASC
       SKIP toInteger($offset) LIMIT toInteger($limit)`,
      { uid: req.params.uid, limit, offset }
    ));
    
    const followedUsers = result.records.map(r => {
      const u = r.get('f').properties;
      return {
        uid: u.uid,
        name: u.name,
        photoUrl: u.photoUrl,
        college: u.college,
        department: u.department,
        averageRating: toNumber(u.averageRating) || 0
      };
    });

    res.json({ success: true, count: followedUsers.length, limit, offset, hasMore: followedUsers.length === limit, data: followedUsers });
  } catch (err) {
    next(err);
  } finally {
    await session.close();
  }
});

module.exports = router;
