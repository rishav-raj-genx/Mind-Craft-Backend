require('dotenv').config();

const { task } = require('@renderinc/sdk/workflows');
const { getDriver, closeDriver } = require('../config/neo4j');

const WEEKLY_BADGE = {
  id: 'weekly_warrior',
  name: 'Weekly Warrior',
  level: 1,
  emoji: 'W',
  description: 'Maintained a perfect 7-day study streak this week',
};

const BONUS_TOKENS = 50;
const REASON = 'weekly_warrior_bonus';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const toNumber = (value) => (value && value.toNumber ? value.toNumber() : value);

function toIstDateString(date) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function getAuditWeekDates(now = new Date()) {
  const dates = [];
  for (let offset = 7; offset >= 1; offset -= 1) {
    dates.push(toIstDateString(addDays(now, -offset)));
  }
  return dates;
}

function getAuditWeekKey(weekDates) {
  return `${weekDates[0]}_${weekDates[weekDates.length - 1]}`;
}

async function fetchUsersImpl() {
  const driver = getDriver();
  const session = driver.session({ database: process.env.NEO4J_DATABASE || 'neo4j' });

  try {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (u:User)
        WHERE u.uid IS NOT NULL
        RETURN u.uid AS uid, coalesce(u.name, u.displayName, u.email, 'Student') AS name
        ORDER BY name ASC
      `),
    );

    return result.records.map((record) => ({
      uid: record.get('uid'),
      name: record.get('name'),
    }));
  } finally {
    await session.close();
  }
}

async function evaluateUserWeeklyStreakImpl(user, weekDates) {
  const driver = getDriver();
  const session = driver.session({ database: process.env.NEO4J_DATABASE || 'neo4j' });

  try {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (u:User {uid: $uid})
        OPTIONAL MATCH (u)-[:LOGGED_IN_ON]->(d:Date)
        WHERE d.date IN $weekDates
        RETURN collect(DISTINCT d.date) AS activeDates
      `, { uid: user.uid, weekDates }),
    );

    const activeDates = new Set(result.records[0]?.get('activeDates') || []);
    const missedDates = weekDates.filter((date) => !activeDates.has(date));

    return {
      ...user,
      activeDates: Array.from(activeDates).sort(),
      missedDates,
      perfect: missedDates.length === 0,
    };
  } finally {
    await session.close();
  }
}

async function awardWeeklyWarriorsImpl(winners, weekDates) {
  if (!winners.length) {
    return { processed: 0, newlyAwarded: 0, weekKey: getAuditWeekKey(weekDates) };
  }

  const driver = getDriver();
  const session = driver.session({ database: process.env.NEO4J_DATABASE || 'neo4j' });
  const now = Date.now();
  const weekKey = getAuditWeekKey(weekDates);
  const meta = {
    workflow: 'weeklyAudit',
    badgeId: WEEKLY_BADGE.id,
    weekStart: weekDates[0],
    weekEnd: weekDates[weekDates.length - 1],
  };

  try {
    const result = await session.executeWrite((tx) =>
      tx.run(`
        UNWIND $winners AS winner
        WITH winner.uid AS uid
        MATCH (u:User {uid: uid})
        MERGE (b:Badge {name: $badgeName})
          ON CREATE SET
            b.id = $badgeId,
            b.emoji = $badgeEmoji,
            b.description = $badgeDescription
        MERGE (u)-[earned:EARNED_BADGE {level: $badgeLevel, auditWeek: $weekKey}]->(b)
          ON CREATE SET
            earned.date = $now,
            earned.badgeId = $badgeId
        MERGE (u)-[:HAS_TRANSACTION]->(t:Transaction {
          reason: $reason,
          idempotencyKey: $weekKey + ':' + uid
        })
          ON CREATE SET
            t.id = randomUUID(),
            t.amount = $tokens,
            t.meta = $meta,
            t.type = 'credit',
            t.timestamp = $now,
            u.mind_tokens = coalesce(u.mind_tokens, 0) + $tokens
        RETURN
          count(uid) AS processed,
          sum(CASE WHEN t.timestamp = $now THEN 1 ELSE 0 END) AS newlyAwarded
      `, {
        winners,
        weekKey,
        now,
        reason: REASON,
        tokens: BONUS_TOKENS,
        meta: JSON.stringify(meta),
        badgeId: WEEKLY_BADGE.id,
        badgeName: WEEKLY_BADGE.name,
        badgeLevel: WEEKLY_BADGE.level,
        badgeEmoji: WEEKLY_BADGE.emoji,
        badgeDescription: WEEKLY_BADGE.description,
      }),
    );

    const record = result.records[0];
    return {
      processed: toNumber(record.get('processed')) || 0,
      newlyAwarded: toNumber(record.get('newlyAwarded')) || 0,
      weekKey,
    };
  } finally {
    await session.close();
  }
}

const fetchUsers = task(
  { name: 'weeklyAuditFetchUsers' },
  fetchUsersImpl,
);

const evaluateUserWeeklyStreak = task(
  { name: 'weeklyAuditEvaluateUserStreak' },
  evaluateUserWeeklyStreakImpl,
);

const awardWeeklyWarriors = task(
  { name: 'weeklyAuditAwardWarriors' },
  awardWeeklyWarriorsImpl,
);

async function runWeeklyAuditImpl(now = new Date()) {
  const weekDates = getAuditWeekDates(now);
  const weekKey = getAuditWeekKey(weekDates);

  console.log(`[weeklyAudit] Stage 1/Data Fetch: loading users for ${weekKey}`);
  const users = await fetchUsers();
  console.log(`[weeklyAudit] Stage 1 complete: ${users.length} users found`);

  console.log('[weeklyAudit] Stage 2/Parallel Execution: evaluating 7-day streaks');
  const evaluations = await Promise.allSettled(
    users.map((user) => evaluateUserWeeklyStreak(user, weekDates)),
  );

  const failures = evaluations
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason?.message || String(result.reason));

  const completed = evaluations
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);

  const winners = completed
    .filter((evaluation) => evaluation.perfect)
    .map(({ uid, name }) => ({ uid, name }));

  console.log(`[weeklyAudit] Stage 2 complete: ${winners.length} perfect streaks, ${failures.length} failures`);

  console.log('[weeklyAudit] Stage 3/Batch Update: awarding badge and bonus tokens');
  const awardSummary = await awardWeeklyWarriors(winners, weekDates);
  console.log(`[weeklyAudit] Stage 3 complete: ${awardSummary.newlyAwarded}/${awardSummary.processed} newly awarded`);

  return {
    workflow: 'weeklyAudit',
    weekKey,
    weekDates,
    usersScanned: users.length,
    usersEvaluated: completed.length,
    winners: winners.length,
    newlyAwarded: awardSummary.newlyAwarded,
    failures,
  };
}

const runWeeklyAudit = task(
  { name: 'weeklyAuditRun' },
  runWeeklyAuditImpl,
);

if (require.main === module) {
  runWeeklyAudit()
    .then((summary) => {
      console.log('[weeklyAudit] Complete:', JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error('[weeklyAudit] Failed:', error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDriver();
    });
}

module.exports = {
  fetchUsers,
  evaluateUserWeeklyStreak,
  awardWeeklyWarriors,
  runWeeklyAudit,
  getAuditWeekDates,
};
