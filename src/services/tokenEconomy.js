/**
 * tokenEconomy.js — Mind Tokens Transactional Gamification System
 *
 * Manages the "Mind Token" virtual currency using Neo4j Cypher transactions.
 *
 * Token awards:
 *   - Forum answer:        +10 tokens
 *   - Session completed:   +25 tokens
 *   - 5-day streak bonus:  +15 tokens
 *   - 10-day streak bonus: +30 tokens
 *   - 30-day streak bonus: +100 tokens
 */

const { getDriver } = require('../config/neo4j');
const {
  TOKENS_FORUM_ANSWER,
  TOKENS_SESSION_COMPLETE,
  TOKENS_STREAK_5,
  TOKENS_STREAK_10,
  TOKENS_STREAK_30,
} = require('../utils/constants');

const toNumber = (val) => (val && val.toNumber ? val.toNumber() : val);
const toDateString = (date) => {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().split('T')[0];
};

/**
 * Awards tokens to a user using a Neo4j transaction.
 */
async function awardTokens(uid, amount, reason, meta = {}) {
  if (!uid || typeof amount !== 'number' || amount <= 0) {
    throw Object.assign(
      new Error('Invalid token award: uid and positive amount are required'),
      { statusCode: 400 },
    );
  }

  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.executeWrite(async (tx) => {
      const idempotencyKey = meta.sessionId || meta.questionId || null;
      if (idempotencyKey) {
        const existing = await tx.run(
          `MATCH (u:User {uid: $uid})-[:HAS_TRANSACTION]->(t:Transaction {reason: $reason, idempotencyKey: $idempotencyKey})
           RETURN u.mind_tokens AS balance, t.id AS transactionId`,
          { uid, reason, idempotencyKey }
        );

        if (existing.records.length > 0) {
          return {
            newBalance: toNumber(existing.records[0].get('balance')) || 0,
            transactionId: existing.records[0].get('transactionId'),
            alreadyAwarded: true,
          };
        }
      }

      // 1. Update Balance & Create Ledger Entry
      const txRes = await tx.run(
        `MATCH (u:User {uid: $uid})
         CREATE (t:Transaction {
            id: randomUUID(),
            amount: $amount,
            reason: $reason,
            meta: $metaStr,
            idempotencyKey: $idempotencyKey,
            type: 'credit',
            timestamp: timestamp()
         })
         CREATE (u)-[:HAS_TRANSACTION]->(t)
         SET u.mind_tokens = coalesce(u.mind_tokens, 0) + $amount
         RETURN u.mind_tokens AS newBalance, t.id AS transactionId`,
        { uid, amount, reason, metaStr: JSON.stringify(meta), idempotencyKey }
      );
      
      if (txRes.records.length === 0) {
        throw Object.assign(new Error(`User ${uid} not found`), { statusCode: 404 });
      }

      // 2. Activity Log for Streak Calculation
      const dateStr = toDateString(new Date());
      await tx.run(
        `MATCH (u:User {uid: $uid})
         MERGE (d:Date {date: $dateStr})
         MERGE (u)-[r:LOGGED_IN_ON]->(d)
         ON CREATE SET r.types = [$reason]
         ON MATCH SET r.types = CASE
           WHEN $reason IN coalesce(r.types, []) THEN r.types
           ELSE coalesce(r.types, []) + $reason
         END`,
        { uid, dateStr, reason }
      );

      return { 
        newBalance: toNumber(txRes.records[0].get('newBalance')), 
        transactionId: txRes.records[0].get('transactionId'),
        alreadyAwarded: false,
      };
    });

    if (!result.alreadyAwarded) {
      console.log(`🪙 Awarded ${amount} tokens to ${uid} (${reason})`);
    }
    return result;
  } finally {
    await session.close();
  }
}

async function awardForumAnswer(uid, questionId = '') {
  return awardTokens(uid, TOKENS_FORUM_ANSWER, 'forum_answer', { questionId });
}

async function awardSessionComplete(teacherUid, learnerUid, sessionId) {
  const [teacherResult, learnerResult] = await Promise.all([
    awardTokens(teacherUid, TOKENS_SESSION_COMPLETE, 'session_complete_teacher', { sessionId }),
    awardTokens(learnerUid, TOKENS_SESSION_COMPLETE, 'session_complete_learner', { sessionId }),
  ]);
  return { teacherResult, learnerResult };
}

async function awardStreakBonus(uid, streakDays) {
  const milestones = [
    { days: 30, tokens: TOKENS_STREAK_30, label: '30_day_streak' },
    { days: 10, tokens: TOKENS_STREAK_10, label: '10_day_streak' },
    { days: 5,  tokens: TOKENS_STREAK_5,  label: '5_day_streak' },
  ];

  for (const m of milestones) {
    if (streakDays === m.days) {
      return awardTokens(uid, m.tokens, m.label, { streakDays });
    }
  }
  return null;
}

async function getBalance(uid) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const res = await session.executeRead(tx => 
      tx.run(`MATCH (u:User {uid: $uid}) RETURN u.mind_tokens AS balance`, { uid })
    );
    if (res.records.length === 0) {
      throw Object.assign(new Error(`User ${uid} not found`), { statusCode: 404 });
    }
    return toNumber(res.records[0].get('balance')) || 0;
  } finally {
    await session.close();
  }
}

async function getTransactionHistory(uid, limit = 20, startAfterTimestamp = null) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const tsFilter = startAfterTimestamp ? new Date(startAfterTimestamp).getTime() : null;
    
    const query = `
      MATCH (u:User {uid: $uid})-[:HAS_TRANSACTION]->(t:Transaction)
      WHERE $tsFilter IS NULL OR t.timestamp < $tsFilter
      RETURN t
      ORDER BY t.timestamp DESC
      LIMIT toInteger($limit)
    `;
    
    const res = await session.executeRead(tx => tx.run(query, { uid, tsFilter, limit }));
    
    return res.records.map(r => {
       const t = r.get('t').properties;
       return {
         id: t.id,
         amount: toNumber(t.amount),
         reason: t.reason,
         type: t.type,
         timestamp: new Date(toNumber(t.timestamp)).toISOString(),
         meta: t.meta ? JSON.parse(t.meta) : {}
       };
    });
  } finally {
    await session.close();
  }
}

module.exports = {
  awardTokens,
  awardForumAnswer,
  awardSessionComplete,
  awardStreakBonus,
  getBalance,
  getTransactionHistory,
};
