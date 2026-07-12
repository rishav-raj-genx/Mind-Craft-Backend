const express = require('express');
const { body } = require('express-validator');
const router  = express.Router();

const { verifyFirebaseToken } = require('../middleware/auth');
const { formatValidationErrors } = require('../middleware/errorHandler');
const { getDriver } = require('../config/neo4j');
const { v4: uuidv4 } = require('uuid');
const { getPagination } = require('../utils/pagination');
const toNumber = (val) => (val && val.toNumber ? val.toNumber() : val);

router.get('/:matchId/history', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const { matchId } = req.params;
    const { limit, offset } = getPagination(req.query);
    const before = req.query.before ? parseInt(req.query.before, 10) : null;
    
    let query = `
      MATCH (:User {uid: $uid})-[:PARTICIPATES_IN]->(t:ChatThread {id: $matchId})
      MATCH (m:Message)-[:IN_THREAD]->(t)
    `;
    let params = { matchId, uid: req.user.uid };
    if (before) { query += ` WHERE m.timestamp < $before`; params.before = before; }
    query += ` RETURN m ORDER BY m.timestamp DESC SKIP toInteger($offset) LIMIT toInteger($limit)`;
    params.limit = limit;
    params.offset = offset;
    
    const result = await session.executeRead(tx => tx.run(query, params));
    if (result.records.length === 0) {
      const access = await session.executeRead(tx => tx.run(`
        MATCH (:User {uid: $uid})-[:PARTICIPATES_IN]->(:ChatThread {id: $matchId})
        RETURN 1
      `, { uid: req.user.uid, matchId }));
      if (access.records.length === 0) return res.status(403).json({ success: false, error: 'Not a participant in this chat thread' });
    }
    const messages = result.records.map(r => {
      const m = r.get('m').properties;
      m.timestamp = toNumber(m.timestamp);
      return m;
    }).reverse();
    
    res.json({ success: true, count: messages.length, limit, offset, hasMore: messages.length === limit, data: messages });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.post('/:matchId/send', verifyFirebaseToken, [body('text').trim().notEmpty()], async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const errors = formatValidationErrors(req);
    if(errors) return res.status(400).json(errors);
    const { matchId } = req.params;
    const { text } = req.body;
    const senderUid = req.user.uid;
    const messageId = uuidv4();
    const timestamp = Date.now();
    
    const sendResult = await session.executeWrite(tx => tx.run(`
      MATCH (u:User {uid: $uid})-[:PARTICIPATES_IN]->(t:ChatThread {id: $matchId})
      CREATE (m:Message {messageId: $messageId, senderUid: $uid, text: $text, timestamp: $timestamp, read: false, isEdited: false})
      CREATE (u)-[:SENT]->(m)-[:IN_THREAD]->(t)
      SET t.lastMessage = $text, t.lastMessageTime = $timestamp, t.lastMessageSender = $uid, t.unread = true
      WITH m, t, u
      OPTIONAL MATCH (p:User)-[:PARTICIPATES_IN]->(t)
      WHERE p.uid <> $uid
      RETURN m, p.uid AS recipientUid, p.fcmToken AS fcmToken, coalesce(u.name, u.email, 'Study Partner') AS senderName
    `, { matchId, uid: senderUid, text, messageId, timestamp }));
    if (sendResult.records.length === 0) return res.status(403).json({ success: false, error: 'Not a participant in this chat thread' });

    const recipientUid = sendResult.records[0].get('recipientUid');
    const fcmToken = sendResult.records[0].get('fcmToken');
    const senderName = sendResult.records[0].get('senderName');
    if (recipientUid) {
      const { broadcastToGlobal } = require('../services/chatService');
      broadcastToGlobal(recipientUid, {
        type: 'global_new_message',
        matchId,
        messageId,
        senderUid,
        senderName,
        text,
        timestamp,
      });

      if (fcmToken) {
        try {
          const { admin } = require('../config/firebase');
          await admin.messaging().send({
            token: fcmToken,
            notification: { title: senderName, body: text },
            data: {
              type: 'chat',
              matchId,
              messageId,
              senderUid,
              timestamp: String(timestamp),
              url: `/chat/${matchId}`,
            },
          });
        } catch (pushErr) {
          console.warn('Chat REST FCM push skipped:', pushErr.message);
        }
      }
    }
    
    res.status(201).json({ success: true, data: { messageId, senderUid, text, timestamp, read: false } });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.patch('/:matchId/read', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const { matchId } = req.params;
    const uid = req.user.uid;

    const result = await session.executeWrite(tx => tx.run(`
      MATCH (:User {uid: $uid})-[:PARTICIPATES_IN]->(t:ChatThread {id: $matchId})
      OPTIONAL MATCH (m:Message)-[:IN_THREAD]->(t)
      WHERE NOT (m)<-[:SENT]-(:User {uid: $uid}) AND coalesce(m.read, false) = false
      SET m.read = true
      WITH t
      SET t.unread = false
      RETURN t.id AS matchId
    `, { matchId, uid }));

    if (result.records.length === 0) {
      return res.status(403).json({ success: false, error: 'Not a participant in this chat thread' });
    }

    res.json({ success: true });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.patch('/:matchId/message/:messageId', verifyFirebaseToken, [body('text').trim().notEmpty()], async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const errors = formatValidationErrors(req);
    if(errors) return res.status(400).json(errors);
    const { matchId, messageId } = req.params;
    const { text } = req.body;
    const senderUid = req.user.uid;
    
    const result = await session.executeWrite(tx => tx.run(`
      MATCH (u:User {uid: $uid})-[:SENT]->(m:Message {messageId: $messageId})-[:IN_THREAD]->(t:ChatThread {id: $matchId})
      SET m.text = $text, m.isEdited = true
      RETURN m, t
    `, { uid: senderUid, messageId, matchId, text }));
    if(result.records.length === 0) return res.status(403).json({ success: false, error: 'Unauthorized or not found' });
    
    const msg = result.records[0].get('m').properties;
    const thread = result.records[0].get('t').properties;
    
    if(thread.lastMessageSender === senderUid && Math.abs(toNumber(thread.lastMessageTime) - toNumber(msg.timestamp)) < 5000) {
      await session.executeWrite(tx => tx.run(`MATCH (t:ChatThread {id: $matchId}) SET t.lastMessage = $text`, { matchId, text }));
    }
    res.json({ success: true });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.delete('/:matchId/message/:messageId', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.executeWrite(tx => tx.run(`
      MATCH (u:User {uid: $uid})-[:SENT]->(m:Message {messageId: $messageId})-[:IN_THREAD]->(t:ChatThread {id: $matchId})
      DETACH DELETE m RETURN m
    `, { uid: req.user.uid, messageId: req.params.messageId, matchId: req.params.matchId }));
    if(result.records.length === 0) return res.status(403).json({ success: false, error: 'Unauthorized or not found' });
    res.json({ success: true });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.get('/threads/:uid', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    if (req.params.uid !== req.user.uid) {
      return res.status(403).json({ success: false, error: 'Cannot fetch another user\'s chat threads' });
    }
    const { limit, offset } = getPagination(req.query);
    const result = await session.executeRead(tx => tx.run(`
      MATCH (u:User {uid: $uid})-[:PARTICIPATES_IN]->(t:ChatThread)<-[:PARTICIPATES_IN]-(p:User)
      RETURN t, p ORDER BY t.lastMessageTime DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
    `, { uid: req.params.uid, limit, offset }));
    const threads = result.records.map(r => {
      const t = r.get('t').properties;
      const p = r.get('p').properties;
      return {
        matchId: t.id,
        partner: p,
        lastMessage: t.lastMessage || '',
        lastMessageTime: toNumber(t.lastMessageTime) || 0,
        lastMessageSender: t.lastMessageSender || '',
        unread: t.unread || false,
      };
    });
    res.json({ success: true, count: threads.length, limit, offset, hasMore: threads.length === limit, data: threads });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.get('/:matchId/detail', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const result = await session.executeRead(tx => tx.run(`
      MATCH (:User {uid: $uid})-[:PARTICIPATES_IN]->(t:ChatThread {id: $matchId})
      MATCH (t)<-[:PARTICIPATES_IN]-(p:User)
      WHERE p.uid <> $uid
      RETURN t, p LIMIT 1
    `, { matchId: req.params.matchId, uid: req.user.uid }));
    
    if(result.records.length === 0) {
      // Fallback if thread exists but no partner or not fetched
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }
    const t = result.records[0].get('t').properties;
    const p = result.records[0].get('p').properties;
    res.json({ success: true, data: { matchId: t.id, partner: p, lastMessage: t.lastMessage || '', lastMessageTime: toNumber(t.lastMessageTime) || 0 } });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.post('/thread', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const fromUid = req.user.uid;
    const { partnerUid } = req.body;
    if(!partnerUid) return res.status(400).json({ success: false, error: 'partnerUid is required' });
    
    const checkRes = await session.executeRead(tx => tx.run(`
      MATCH (u1:User {uid: $fromUid})-[:PARTICIPATES_IN]->(t:ChatThread)<-[:PARTICIPATES_IN]-(u2:User {uid: $partnerUid})
      RETURN t LIMIT 1
    `, { fromUid, partnerUid }));
    
    if(checkRes.records.length > 0) {
      const t = checkRes.records[0].get('t').properties;
      const pRes = await session.executeRead(tx => tx.run(`MATCH (u:User {uid: $p}) RETURN u`, { p: partnerUid }));
      const p = pRes.records.length > 0 ? pRes.records[0].get('u').properties : { uid: partnerUid, name: 'Study Partner' };
      return res.json({ success: true, matchId: t.id, data: { match: { matchId: t.id, ...t }, partner: p } });
    }
    
    const matchId = uuidv4();
    const createRes = await session.executeWrite(tx => tx.run(`
      MATCH (u1:User {uid: $fromUid}), (u2:User {uid: $partnerUid})
      CREATE (t:ChatThread {id: $matchId, createdAt: timestamp(), lastMessage: '', lastMessageTime: 0})
      CREATE (u1)-[:PARTICIPATES_IN]->(t)
      CREATE (u2)-[:PARTICIPATES_IN]->(t)
      RETURN t
    `, { fromUid, partnerUid, matchId }));
    if (createRes.records.length === 0) return res.status(404).json({ success: false, error: 'Partner not found' });
    
    const pRes = await session.executeRead(tx => tx.run(`MATCH (u:User {uid: $p}) RETURN u`, { p: partnerUid }));
    const p = pRes.records.length > 0 ? pRes.records[0].get('u').properties : { uid: partnerUid, name: 'Study Partner' };
    res.json({ success: true, matchId, data: { match: { matchId }, partner: p } });
  } catch (err) { next(err); } finally { await session.close(); }
});

module.exports = router;
