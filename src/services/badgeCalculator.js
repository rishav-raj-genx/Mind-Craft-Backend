const { getDriver } = require('../config/neo4j');
const { calculateStreak } = require('./streakCalculator');
const { SESSION_COMPLETED } = require('../utils/constants');

const BADGE_DEFINITIONS = [
  { id: 'streak_champion', name: 'Streak Champion', emoji: '🔥', description: 'Maintain a daily streak', metric: 'longestStreak', thresholds: [3, 7, 14, 30], color: 'from-orange-500/20 to-orange-400/10', borderColor: 'border-orange-400/30', iconColor: 'text-orange-500' },
  { id: 'session_pro', name: 'Session Pro', emoji: '📚', description: 'Complete tutoring sessions', metric: 'totalSessions', thresholds: [5, 15, 50], color: 'from-green-500/20 to-success-lime/10', borderColor: 'border-success-lime/30', iconColor: 'text-success-lime' },
  { id: 'dsa_master', name: 'DSA Master', emoji: '💻', description: 'DSA-related sessions', metric: 'dsaSessions', thresholds: [3, 10, 25], color: 'from-green-500/20 to-success-lime/10', borderColor: 'border-success-lime/30', iconColor: 'text-green-600' },
  { id: 'late_night_learner', name: 'Late Night Learner', emoji: '🌙', description: 'Sessions after midnight', metric: 'lateNightSessions', thresholds: [1, 5, 15], color: 'from-purple-500/20 to-focus-purple/10', borderColor: 'border-focus-purple/30', iconColor: 'text-focus-purple' },
  { id: 'problem_solver', name: 'Problem Solver', emoji: '🐛', description: 'Answer doubts in the forum', metric: 'doubtsAnswered', thresholds: [3, 10, 25], color: 'from-orange-500/20 to-orange-400/10', borderColor: 'border-orange-400/30', iconColor: 'text-orange-500' },
  { id: 'mentor', name: 'Mentor', emoji: '🎓', description: 'Teach sessions as a tutor', metric: 'sessionsTaught', thresholds: [3, 10, 30], color: 'from-blue-500/20 to-blue-400/10', borderColor: 'border-blue-400/30', iconColor: 'text-blue-600' },
  { id: 'top_rated', name: 'Top Rated', emoji: '⭐', description: 'Earn high ratings (avg ≥ 4.0)', metric: 'ratedSessions', thresholds: [5, 15, 30], color: 'from-yellow-500/20 to-yellow-400/10', borderColor: 'border-yellow-400/30', iconColor: 'text-yellow-500' },
  { id: 'social_butterfly', name: 'Social Butterfly', emoji: '🤝', description: 'Study with unique mates', metric: 'uniqueMates', thresholds: [3, 10, 25], color: 'from-pink-500/20 to-pink-400/10', borderColor: 'border-pink-400/30', iconColor: 'text-pink-500' }
];

async function calculateBadges(uid) {
  const [sessionMetrics, forumMetrics, streakData] = await Promise.all([ getSessionMetrics(uid), getForumMetrics(uid), calculateStreak(uid) ]);
  const metrics = {
    currentStreak: streakData.currentStreak, longestStreak: streakData.longestStreak,
    totalSessions: sessionMetrics.totalSessions, dsaSessions: sessionMetrics.dsaSessions,
    lateNightSessions: sessionMetrics.lateNightSessions, sessionsTaught: sessionMetrics.sessionsTaught,
    ratedSessions: sessionMetrics.ratedSessions, averageRating: sessionMetrics.averageRating,
    uniqueMates: sessionMetrics.uniqueMates, doubtsAnswered: forumMetrics.doubtsAnswered,
  };
  const badges = BADGE_DEFINITIONS.map(def => computeBadge(def, metrics));
  const totalEarned = badges.filter(b => b.level > 0).length;
  const badgeHistory = await getBadgeHistory(uid);
  return { badges, totalEarned, totalSessions: metrics.totalSessions, sessionHistory: sessionMetrics.recentSessions, badgeHistory, metrics };
}

function computeBadge(definition, metrics) {
  const { id, name, emoji, description, metric, thresholds, color, borderColor, iconColor } = definition;
  const currentValue = metrics[metric] || 0;
  let level = 0;
  for (let i = 0; i < thresholds.length; i++) if (currentValue >= thresholds[i]) level = i + 1;
  const maxLevel = thresholds.length;
  const isMaxed = level >= maxLevel;
  const nextThreshold = isMaxed ? thresholds[maxLevel - 1] : thresholds[level];
  const prevThreshold = level > 0 ? thresholds[level - 1] : 0;
  let progress = isMaxed ? 100 : (nextThreshold - prevThreshold > 0 ? Math.max(0, Math.min(100, Math.round(((currentValue - prevThreshold) / (nextThreshold - prevThreshold)) * 100))) : 0);
  return { id, name, emoji, description, level, maxLevel, isMaxed, currentValue, nextThreshold, prevThreshold, progress, color, borderColor, iconColor, progressLabel: `${currentValue}/${nextThreshold}` };
}

async function getSessionMetrics(uid) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const res = await session.executeRead(tx => tx.run(`
      MATCH (s:Session {status: $status})
      WHERE s.teacherUid = $uid OR s.learnerUid = $uid
      RETURN s ORDER BY s.scheduledAt DESC
    `, { status: SESSION_COMPLETED, uid }));
    
    const uniqueSessions = [];
    const seen = new Set();
    res.records.forEach(r => {
      const s = r.get('s').properties;
      if(!seen.has(s.sessionId)) { seen.add(s.sessionId); uniqueSessions.push(s); }
    });
    
    const teacherSessions = uniqueSessions.filter(s => s.teacherUid === uid);
    const learnerSessions = uniqueSessions.filter(s => s.learnerUid === uid);
    const toNumber = (val) => (val && val.toNumber ? val.toNumber() : val);
    
    const dsaKeywords = ['dsa', 'data structure', 'algorithm', 'data structures'];
    const dsaSessions = uniqueSessions.filter(s => s.skill && dsaKeywords.some(k => s.skill.toLowerCase().includes(k))).length;
    
    const lateNightSessions = uniqueSessions.filter(s => {
      if (!s.scheduledAt) return false;
      const hour = new Date(toNumber(s.scheduledAt)).getHours();
      return hour >= 0 && hour < 5;
    }).length;
    
    const ratedSessions = uniqueSessions.filter(s => toNumber(s.rating) >= 4.0).length;
    const ratingsArr = uniqueSessions.filter(s => toNumber(s.rating) > 0).map(s => toNumber(s.rating));
    const averageRating = ratingsArr.length > 0 ? ratingsArr.reduce((a, b) => a + b, 0) / ratingsArr.length : 0;
    
    const mateSet = new Set();
    teacherSessions.forEach(s => mateSet.add(s.learnerUid));
    learnerSessions.forEach(s => mateSet.add(s.teacherUid));
    
    const recentSessions = uniqueSessions.slice(0, 20).map(s => ({
      sessionId: s.sessionId, skill: s.skill, scheduledAt: toNumber(s.scheduledAt),
      mode: s.mode, rating: toNumber(s.rating) || 0, role: s.teacherUid === uid ? 'teacher' : 'learner',
    }));
    
    return { totalSessions: uniqueSessions.length, sessionsTaught: teacherSessions.length, dsaSessions, lateNightSessions, ratedSessions, averageRating: Math.round(averageRating * 10) / 10, uniqueMates: mateSet.size, recentSessions };
  } finally { await session.close(); }
}

async function getForumMetrics(uid) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const res = await session.executeRead(tx => tx.run(`MATCH (u:User {uid: $uid})-[:ANSWERED]->(d:Doubt) RETURN count(d) AS c`, { uid }));
    return { doubtsAnswered: res.records.length > 0 ? res.records[0].get('c').toNumber() : 0 };
  } finally { await session.close(); }
}

async function getBadgeHistory(uid) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const res = await session.executeRead(tx => tx.run(`
      MATCH (u:User {uid: $uid})-[r:EARNED_BADGE]->(b:Badge)
      RETURN b.name AS badgeId, b.name AS badgeName, r.level AS level, r.date AS earnedAt
      ORDER BY r.date DESC LIMIT 20
    `, { uid }));
    return res.records.map(r => ({
      id: `${r.get('badgeId')}_level${r.get('level')}`,
      badgeId: r.get('badgeId'), badgeName: r.get('badgeName'), level: r.get('level'),
      earnedAt: new Date(r.get('earnedAt').toNumber()).toISOString()
    }));
  } finally { await session.close(); }
}

async function recordBadgeEarned(uid, badgeId, badgeName, level) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const exist = await session.executeRead(tx => tx.run(`
      MATCH (u:User {uid: $uid})-[r:EARNED_BADGE {level: $level}]->(b:Badge {name: $badgeName}) RETURN r
    `, { uid, level, badgeName }));
    if(exist.records.length > 0) return false;
    
    await session.executeWrite(tx => tx.run(`
      MATCH (u:User {uid: $uid})
      MERGE (b:Badge {name: $badgeName})
      MERGE (u)-[:EARNED_BADGE {date: timestamp(), level: $level}]->(b)
    `, { uid, badgeName, level }));
    return true;
  } catch(err) { return false; } finally { await session.close(); }
}

module.exports = { calculateBadges, recordBadgeEarned, BADGE_DEFINITIONS };
