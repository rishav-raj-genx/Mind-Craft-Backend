/**
 * streakCalculator.js — Daily Consistency Streak Calculator
 *
 * Queries a user's activity log from Neo4j AuraDB to compute streaks.
 */

const { getDriver } = require('../config/neo4j');

const BADGE_MILESTONES = [
  { days: 3,   name: 'Spark Starter',    emoji: '🌱', icon: 'Sprout',    level: 1, freezeReward: 1 },
  { days: 7,   name: 'Week Warrior',     emoji: '⚡', icon: 'Zap',       level: 2, freezeReward: 1 },
  { days: 14,  name: 'Fortnight Focus',  emoji: '🔥', icon: 'Flame',     level: 3, freezeReward: 1 },
  { days: 30,  name: 'Monthly Master',   emoji: '🏆', icon: 'Trophy',    level: 4, freezeReward: 1 },
  { days: 60,  name: 'Discipline King',  emoji: '💎', icon: 'Diamond',   level: 5, freezeReward: 1 },
  { days: 100, name: 'Century Legend',   emoji: '👑', icon: 'Crown',     level: 6, freezeReward: 2 },
];

async function recordCheckIn(uid) {
  const todayStr = toDateString(new Date());
  const now = Date.now();
  const driver = getDriver();
  const session = driver.session();
  try {
    const res = await session.executeWrite(tx => tx.run(`
      MATCH (u:User {uid: $uid})
      MERGE (d:Date {date: $todayStr})
      MERGE (u)-[r:LOGGED_IN_ON]->(d)
      ON CREATE SET r.types = ['app_open'], r.createdAt = $now
      ON MATCH SET r.types = CASE
        WHEN 'app_open' IN coalesce(r.types, []) THEN r.types
        ELSE coalesce(r.types, []) + 'app_open'
      END
      RETURN r.createdAt = $now AS created
    `, { uid, todayStr, now }));
    const created = res.records.length > 0 && res.records[0].get('created') === true;
    return { alreadyCheckedIn: !created };
  } finally {
    await session.close();
  }
}

async function calculateStreak(uid) {
  const now       = new Date();
  const ninetyAgo = new Date(now);
  ninetyAgo.setDate(ninetyAgo.getDate() - 90);
  const cutoffStr = toDateString(ninetyAgo);

  const driver = getDriver();
  const session = driver.session();
  let activeDates = [];
  try {
    const res = await session.executeRead(tx => tx.run(`
      MATCH (u:User {uid: $uid})-[:LOGGED_IN_ON]->(d:Date)
      WHERE d.date >= $cutoffStr
      RETURN d.date AS date
      ORDER BY date ASC
    `, { uid, cutoffStr }));
    activeDates = res.records.map(r => r.get('date'));
  } finally {
    await session.close();
  }

  const activeDateSet = new Set(activeDates);
  const currentStreak = computeCurrentStreak(activeDateSet, now);
  const longestStreak = computeLongestStreak(activeDates);
  const grid = buildConsistencyGrid(activeDateSet, now);
  const totalActiveDays = activeDates.length;

  const badges = computeBadges(currentStreak, longestStreak, totalActiveDays);
  const streakFreezes = computeStreakFreezes(longestStreak);

  return {
    currentStreak,
    longestStreak,
    activeDates: getLast35ActiveDates(activeDateSet, now),
    grid,
    badges,
    streakFreezes,
    totalActiveDays,
  };
}

function computeBadges(currentStreak, longestStreak, totalActiveDays) {
  const bestStreak = Math.max(currentStreak, longestStreak);
  const earned = BADGE_MILESTONES.filter(b => bestStreak >= b.days);
  const remaining = BADGE_MILESTONES.filter(b => bestStreak < b.days);
  const next = remaining.length > 0 ? remaining[0] : null;
  const daysToNext = next ? next.days - currentStreak : 0;
  
  let progress = 0;
  if (next) {
    const prevMilestoneDays = earned.length > 0 ? earned[earned.length - 1].days : 0;
    const range = next.days - prevMilestoneDays;
    const completed = currentStreak - prevMilestoneDays;
    progress = range > 0 ? Math.max(0, Math.min(100, Math.round((completed / range) * 100))) : 0;
  } else {
    progress = 100;
  }

  return { earned, next, daysToNext: Math.max(0, daysToNext), progress, totalActiveDays };
}

function computeStreakFreezes(longestStreak) {
  let freezes = 2;
  for (const milestone of BADGE_MILESTONES) {
    if (longestStreak >= milestone.days) {
      freezes += milestone.freezeReward;
    }
  }
  return freezes;
}

function computeCurrentStreak(activeDateSet, now) {
  const today     = toDateString(now);
  const yesterday = toDateString(new Date(now.getTime() - 86400000));

  let startDate;
  if (activeDateSet.has(today)) {
    startDate = today;
  } else if (activeDateSet.has(yesterday)) {
    startDate = yesterday;
  } else {
    return 0;
  }

  let streak  = 0;
  let current = new Date(startDate + 'T00:00:00Z');
  while (activeDateSet.has(toDateString(current))) {
    streak++;
    current.setDate(current.getDate() - 1);
  }
  return streak;
}

function computeLongestStreak(sortedDates) {
  if (sortedDates.length === 0) return 0;
  let longest = 1, current = 1;
  for (let i = 1; i < sortedDates.length; i++) {
    const prev = new Date(sortedDates[i - 1] + 'T00:00:00Z');
    const curr = new Date(sortedDates[i] + 'T00:00:00Z');
    const diffDays = (curr - prev) / 86400000;
    if (diffDays === 1) {
      current++;
      longest = Math.max(longest, current);
    } else if (diffDays > 1) {
      current = 1;
    }
  }
  return longest;
}

function buildConsistencyGrid(activeDateSet, now) {
  const grid = [];
  const totalCells = 35; 
  for (let i = totalCells - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr   = toDateString(d);
    const dayOfWeek = d.getDay(); 
    const weekIndex = Math.floor((totalCells - 1 - i) / 7);
    grid.push({ date: dateStr, active: activeDateSet.has(dateStr), dayOfWeek, weekIndex });
  }
  return grid;
}

function getLast35ActiveDates(activeDateSet, now) {
  const result = [];
  for (let i = 34; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = toDateString(d);
    if (activeDateSet.has(dateStr)) {
      result.push(dateStr);
    }
  }
  return result;
}

function toDateString(date) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  return istDate.toISOString().split('T')[0];
}

module.exports = { calculateStreak, recordCheckIn, BADGE_MILESTONES };
