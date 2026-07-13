const express  = require('express');
const { body } = require('express-validator');
const router   = express.Router();
const { verifyFirebaseToken }   = require('../middleware/auth');
const { formatValidationErrors } = require('../middleware/errorHandler');
const { completeSession, cancelSession } = require('../services/sessionRouter');
const { awardSessionComplete }  = require('../services/tokenEconomy');
const { exportSessionToCalendar, getAuthUrl } = require('../services/calendarExport');
const { getDriver } = require('../config/neo4j');
const { v4: uuidv4 } = require('uuid');
const { getPagination } = require('../utils/pagination');

const { SESSION_PENDING, SESSION_UPCOMING, SESSION_COMPLETED, SESSION_REJECTED } = require('../utils/constants');

const toNumber = (val) => (val && val.toNumber ? val.toNumber() : val);

router.get('/auth/google', (_req, res) => {
  try { res.json({ success: true, data: { authUrl: getAuthUrl() } }); } catch (err) { res.status(503).json({ success: false, error: 'Google Calendar API not configured.' }); }
});

router.post('/book', verifyFirebaseToken, [
  body('matchId').trim().notEmpty(), body('teacherUid').trim().notEmpty(),
  body('learnerUid').trim().notEmpty(), body('skill').trim().notEmpty(),
  body('scheduledAt').isNumeric(), body('mode').isIn(['Online', 'In-Person']),
], async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const errors = formatValidationErrors(req);
    if (errors) return res.status(400).json(errors);
    if (![req.body.teacherUid, req.body.learnerUid].includes(req.user.uid)) {
      return res.status(403).json({ success: false, error: 'Cannot book a session for unrelated users' });
    }

    const sessionId = uuidv4();
    const meetLink = req.body.meetLink || `https://meet.jit.si/MindCraft-${sessionId}`;
    const sessObj = {
      sessionId, matchId: req.body.matchId, teacherUid: req.body.teacherUid, learnerUid: req.body.learnerUid,
      skill: req.body.skill, scheduledAt: req.body.scheduledAt, duration: req.body.duration || 60,
      endTime: req.body.scheduledAt + (req.body.duration || 60) * 60000,
      mode: req.body.mode, meetLink, location: req.body.location || '',
      notes: req.body.notes || '', status: SESSION_UPCOMING, rating: 0, ratingComment: '', createdAt: Date.now(),
    };

    const createRes = await session.executeWrite(tx => tx.run(`
      MATCH (t:User {uid: $teacherUid})
      MATCH (l:User {uid: $learnerUid})
      MATCH (t)-[:PARTICIPATES_IN]->(:ChatThread {id: $matchId})<-[:PARTICIPATES_IN]-(l)
      CREATE (s:Session) SET s = $sessObj
      CREATE (l)-[:ATTENDS]->(s)<-[:HOSTS]-(t)
      RETURN s, l.name AS learnerName, t.name AS teacherName
    `, { teacherUid: sessObj.teacherUid, learnerUid: sessObj.learnerUid, matchId: sessObj.matchId, sessObj }));

    if (createRes.records.length === 0) {
      return res.status(404).json({ success: false, error: 'Matched users or chat thread not found' });
    }

    const learnerName = createRes.records[0].get('learnerName') || 'a user';
    const teacherName = createRes.records[0].get('teacherName') || 'a tutor';

    const { broadcastToGlobal } = require('../services/chatService');
    
    // Notify Teacher
    broadcastToGlobal(req.body.teacherUid, {
      type: 'global_notification', subType: 'session_booked',
      data: { message: `New session automatically booked for ${req.body.skill}`, partnerName: learnerName },
      sessionId, timestamp: Date.now()
    });

    // Notify Learner
    broadcastToGlobal(req.body.learnerUid, {
      type: 'global_notification', subType: 'session_booked',
      data: { message: `Your session for ${req.body.skill} is confirmed!`, partnerName: teacherName },
      sessionId, timestamp: Date.now()
    });

    res.status(201).json({ success: true, data: sessObj });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.get('/:uid', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const { uid } = req.params;
    const { status } = req.query;
    const { limit, offset } = getPagination(req.query);
    
    if (uid !== req.user.uid) {
      return res.status(403).json({ success: false, error: 'Cannot fetch another user\'s sessions' });
    }

    const query = `
      MATCH (me:User {uid: $uid})-[role:HOSTS|ATTENDS]->(s:Session)
      WHERE ($status IS NULL OR s.status = $status)
      OPTIONAL MATCH (peer:User)-[:HOSTS|ATTENDS]->(s)
      WHERE peer.uid <> $uid
      RETURN s, peer.name AS peerName
      ORDER BY s.scheduledAt ASC
      SKIP toInteger($offset) LIMIT toInteger($limit)
    `;
    let result = await session.executeRead(tx => tx.run(query, { uid, status: status || null, limit, offset }));
    
    const now = Date.now();
    let sessions = [];
    
    for(const r of result.records) {
      let s = r.get('s').properties;
      s.scheduledAt = toNumber(s.scheduledAt);
      s.endTime = toNumber(s.endTime);
      s.duration = toNumber(s.duration);
      s.createdAt = toNumber(s.createdAt);
      s.rating = toNumber(s.rating);
      
      const sEndTime = s.endTime || (s.scheduledAt + (s.duration || 60) * 60000);
      if (s.status === SESSION_UPCOMING && sEndTime < now) {
        s.status = SESSION_COMPLETED;
        await session.executeWrite(tx => tx.run(`MATCH (s:Session {sessionId: $id}) SET s.status = $status`, { id: s.sessionId, status: SESSION_COMPLETED }));
        try { await awardSessionComplete(s.teacherUid, s.learnerUid, s.sessionId); } catch(e){}
      }
      
      s.peerName = r.get('peerName') || 'Unknown User';
      sessions.push(s);
    }
    
    res.json({ success: true, count: sessions.length, limit, offset, hasMore: sessions.length === limit, data: sessions });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.patch('/:sessionId/accept', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const { sessionId } = req.params;
    const { googleTokens } = req.body;
    const result = await session.executeRead(tx => tx.run(`MATCH (s:Session {sessionId: $id}) RETURN s`, { id: sessionId }));
    if(result.records.length === 0) return res.status(404).json({ success: false, error: 'Session not found' });
    
    let sessionData = result.records[0].get('s').properties;
    
    if (googleTokens) {
      try {
        const pRes = await session.executeRead(tx => tx.run(`MATCH (u:User {uid: $p}) RETURN u`, { p: sessionData.learnerUid }));
        const peerData = pRes.records.length > 0 ? pRes.records[0].get('u').properties : {};
        const calendarRes = await exportSessionToCalendar(sessionData, googleTokens, peerData.name || 'Peer', peerData.email);
        if (calendarRes && calendarRes.meetLink) sessionData.meetLink = calendarRes.meetLink;
      } catch (calErr) {}
    }

    if (sessionData.mode === 'Online' && !sessionData.meetLink) {
      sessionData.meetLink = `https://meet.jit.si/MindCraft-${sessionId}`;
    }

    const acceptRes = await session.executeWrite(tx => tx.run(`
      MATCH (teacher:User {uid: $uid})-[:HOSTS]->(s:Session {sessionId: $id})
      SET s.status = $status, s.meetLink = $meetLink
      RETURN s
    `, { id: sessionId, uid: req.user.uid, status: SESSION_UPCOMING, meetLink: sessionData.meetLink || '' }));
    if (acceptRes.records.length === 0) return res.status(403).json({ success: false, error: 'Only the teacher can accept this session' });

    if (sessionData.meetLink && sessionData.matchId) {
      const messageId = uuidv4();
      const timestamp = Date.now();
      const text = `I've accepted the session! Here is the meeting link: ${sessionData.meetLink}`;
      await session.executeWrite(tx => tx.run(`
        MATCH (t:ChatThread {id: $matchId})
        MATCH (u:User {uid: $uid})
        CREATE (m:Message { messageId: $messageId, text: $text, timestamp: $timestamp, read: false })
        CREATE (u)-[:SENT]->(m)-[:IN_THREAD]->(t)
        SET t.lastMessage = $text, t.lastMessageTime = $timestamp, t.lastMessageSender = $uid, t.unread = true
      `, { matchId: sessionData.matchId, uid: req.user.uid, messageId, text, timestamp }));
    }

    const { broadcastToGlobal } = require('../services/chatService');
    broadcastToGlobal(sessionData.learnerUid, {
      type: 'global_new_message',
      notification: { title: 'Session Accepted! ✅', body: `Your session request for ${sessionData.skill || 'tutoring'} was accepted.` },
      data: { type: 'session_booked', id: `session-${sessionId}-accept`, route: '/sessions', matchId: '' }
    });

    res.json({ success: true, message: 'Session accepted', meetLink: sessionData.meetLink });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.patch('/:sessionId/reject', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.executeWrite(tx => tx.run(`
      MATCH (:User {uid: $uid})-[:HOSTS]->(s:Session {sessionId: $id})
      SET s.status = $status
      RETURN s
    `, { id: req.params.sessionId, uid: req.user.uid, status: SESSION_REJECTED }));
    if(result.records.length === 0) return res.status(403).json({ success: false, error: 'Only the teacher can reject this session' });
    res.json({ success: true, message: 'Session rejected' });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.patch('/:sessionId/complete', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const authRes = await session.executeRead(tx => tx.run(`
      MATCH (:User {uid: $uid})-[:HOSTS|ATTENDS]->(:Session {sessionId: $id})
      RETURN 1
    `, { uid: req.user.uid, id: req.params.sessionId }));
    if(authRes.records.length === 0) return res.status(403).json({ success: false, error: 'Not a participant in this session' });

    const result = await completeSession(req.params.sessionId);
    const sRes = await session.executeRead(tx => tx.run(`MATCH (s:Session {sessionId: $id}) RETURN s`, { id: req.params.sessionId }));
    if(sRes.records.length > 0) {
      const sess = sRes.records[0].get('s').properties;
      if (!result.alreadyCompleted) {
        try { await awardSessionComplete(sess.teacherUid, sess.learnerUid, sess.sessionId); } catch(e){}
      }
    }
    res.json({ success: true, ...result });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.post('/:sessionId/rate', verifyFirebaseToken, [
  body('rating').isFloat({ min: 1, max: 5 })
], async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const errors = formatValidationErrors(req);
    if(errors) return res.status(400).json(errors);
    const { sessionId } = req.params;
    const { rating, comment } = req.body;
    
    const sRes = await session.executeRead(tx => tx.run(`MATCH (s:Session {sessionId: $id}) RETURN s`, { id: sessionId }));
    if(sRes.records.length === 0) return res.status(404).json({ success: false, error: 'Session not found' });
    const sess = sRes.records[0].get('s').properties;
    
    const rateRes = await session.executeWrite(tx => tx.run(`
      MATCH (:User {uid: $uid})-[:ATTENDS]->(s:Session {sessionId: $id})
      SET s.rating = $rating, s.ratingComment = $comment, s.status = $status
      RETURN s
    `, { id: sessionId, uid: req.user.uid, rating: parseFloat(rating), comment: comment||'', status: SESSION_COMPLETED }));
    if(rateRes.records.length === 0) return res.status(403).json({ success: false, error: 'Only the learner can rate this session' });
    
    const allRes = await session.executeRead(tx => tx.run(`MATCH (s:Session) WHERE s.teacherUid = $tuid AND s.status = $status RETURN s`, { tuid: sess.teacherUid, status: SESSION_COMPLETED }));
    const rated = allRes.records.map(r => r.get('s').properties).filter(s => toNumber(s.rating) > 0);
    if(rated.length > 0) {
      const avg = rated.reduce((sum, s) => sum + toNumber(s.rating), 0) / rated.length;
      await session.executeWrite(tx => tx.run(`MATCH (u:User {uid: $tuid}) SET u.averageRating = $avg, u.totalSessions = $total`, { tuid: sess.teacherUid, avg: parseFloat(avg.toFixed(2)), total: rated.length }));
    }
    
    const { broadcastToGlobal } = require('../services/chatService');
    broadcastToGlobal(sess.teacherUid, {
      type: 'global_new_message',
      notification: { title: 'New Review Received! ⭐', body: `You received a ${rating}-star rating.` },
      data: { type: 'new_review', id: `review-${sessionId}`, route: '/profile', matchId: '' }
    });
    res.json({ success: true, message: 'Rating submitted' });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.post('/:sessionId/cancel', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const authRes = await session.executeRead(tx => tx.run(`
      MATCH (:User {uid: $uid})-[:HOSTS|ATTENDS]->(:Session {sessionId: $id})
      RETURN 1
    `, { uid: req.user.uid, id: req.params.sessionId }));
    if(authRes.records.length === 0) return res.status(403).json({ success: false, error: 'Not a participant in this session' });

    const result = await cancelSession(req.params.sessionId);
    res.json({ success: true, ...result });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.post('/:sessionId/export-calendar', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const { sessionId } = req.params;
    const sRes = await session.executeRead(tx => tx.run(`MATCH (s:Session {sessionId: $id}) RETURN s`, { id: sessionId }));
    if(sRes.records.length === 0) return res.status(404).json({ success: false, error: 'Session not found' });
    const sess = sRes.records[0].get('s').properties;
    if (![sess.teacherUid, sess.learnerUid].includes(req.user.uid)) {
      return res.status(403).json({ success: false, error: 'Not a participant in this session' });
    }
    
    const peerUid = sess.learnerUid === req.user.uid ? sess.teacherUid : sess.learnerUid;
    const pRes = await session.executeRead(tx => tx.run(`MATCH (u:User {uid: $p}) RETURN u`, { p: peerUid }));
    const peerData = pRes.records.length > 0 ? pRes.records[0].get('u').properties : {};
    const peerName = peerData.name || 'Peer';
    const peerEmail = peerData.email || '';
    
    const start = new Date(toNumber(sess.scheduledAt));
    const durationMins = toNumber(sess.duration) || 60;
    const end = new Date(start.getTime() + durationMins * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
    
    const params = new URLSearchParams({
      action: 'TEMPLATE', text: `MindCraft Session: ${sess.skill || 'Tutoring'}`, dates: `${fmt(start)}/${fmt(end)}`,
      details: `MindCraft P2P Tutoring Session with ${peerName}\nSkill: ${sess.skill || 'General'}\nMode: ${sess.mode || 'Online'}${sess.meetLink ? `\nJoin: ${sess.meetLink}` : ''}`,
      location: sess.meetLink || sess.location || 'MindCraft App',
    });
    if (peerEmail) params.append('add', peerEmail);
    const url = `https://calendar.google.com/calendar/render?${params.toString()}`;
    res.json({ success: true, data: { htmlLink: url } });
  } catch (err) { next(err); } finally { await session.close(); }
});

module.exports = router;
