const { admin }  = require('../config/firebase');
const { getDriver } = require('../config/neo4j');
const { SESSION_COMPLETED, SESSION_CANCELLED } = require('../utils/constants');

async function completeSession(sessionId) {
  const driver = getDriver();
  const session = driver.session();
  let learnerUid, sessionData;
  try {
    const res = await session.executeWrite(tx => tx.run(`
      MATCH (s:Session {sessionId: $sessionId})
      WITH s, s.status AS previousStatus
      SET s.status = $status, s.completedAt = timestamp()
      WITH s MATCH (u:User)-[:ATTENDS]->(s)
      RETURN u.uid AS learnerUid, s, previousStatus
    `, { sessionId, status: SESSION_COMPLETED }));
    if(res.records.length === 0) throw Object.assign(new Error('Session not found'), { statusCode: 404 });
    
    learnerUid = res.records[0].get('learnerUid');
    sessionData = res.records[0].get('s').properties;
    sessionData.alreadyCompleted = res.records[0].get('previousStatus') === SESSION_COMPLETED;
  } finally { await session.close(); }
  
  let notificationSent = false;
  if (!sessionData.alreadyCompleted) {
    try { notificationSent = await sendRatingNotification(learnerUid, sessionData); } catch(err) {}
  }
  return { success: true, notificationSent, alreadyCompleted: sessionData.alreadyCompleted };
}

async function cancelSession(sessionId) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const res = await session.executeWrite(tx => tx.run(`
      MATCH (s:Session {sessionId: $sessionId})
      SET s.status = $status, s.cancelledAt = timestamp()
      RETURN s
    `, { sessionId, status: SESSION_CANCELLED }));
    if(res.records.length === 0) throw Object.assign(new Error('Session not found'), { statusCode: 404 });
  } finally { await session.close(); }
  return { success: true };
}

async function sendRatingNotification(learnerUid, sessionData) {
  const driver = getDriver();
  const session = driver.session();
  let fcmToken, teacherName = 'your tutor';
  try {
    const res = await session.executeRead(tx => tx.run(`MATCH (u:User {uid: $learnerUid}) RETURN u.fcmToken AS token`, { learnerUid }));
    if(res.records.length > 0) fcmToken = res.records[0].get('token');
    
    if(sessionData.teacherUid) {
      const tRes = await session.executeRead(tx => tx.run(`MATCH (u:User {uid: $tUid}) RETURN u.name AS name`, { tUid: sessionData.teacherUid }));
      if(tRes.records.length > 0) teacherName = tRes.records[0].get('name') || teacherName;
    }
  } finally { await session.close(); }
  if(!fcmToken) return false;
  
  const message = {
    token: fcmToken,
    notification: { title: '⭐ Rate Your Session', body: `How was your ${sessionData.skill || ''} session with ${teacherName}? Tap to leave a rating.` },
    data: { type: 'rate_session', sessionId: sessionData.sessionId || '', matchId: sessionData.matchId || '' },
    android: { priority: 'high', notification: { channelId: 'mindcraft_sessions', clickAction: 'OPEN_SESSION', defaultSound: true, defaultVibrateTimings: true } }
  };
  try { await admin.messaging().send(message); return true; } catch(err) { return false; }
}

async function sendNotification(uid, title, body, data = {}) {
  const driver = getDriver();
  const session = driver.session();
  let fcmToken;
  try {
    const res = await session.executeRead(tx => tx.run(`MATCH (u:User {uid: $uid}) RETURN u.fcmToken AS token`, { uid }));
    if(res.records.length > 0) fcmToken = res.records[0].get('token');
  } finally { await session.close(); }
  if(!fcmToken) return false;
  try { await admin.messaging().send({ token: fcmToken, notification: { title, body }, data, android: { priority: 'high' } }); return true; } catch(err) { return false; }
}

module.exports = { completeSession, cancelSession, sendRatingNotification, sendNotification };
