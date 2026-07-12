const express = require('express');
const { body } = require('express-validator');
const router  = express.Router();

const { verifyFirebaseToken } = require('../middleware/auth');
const { formatValidationErrors } = require('../middleware/errorHandler');
const { findMatches, findBroadMatches, findAnyMatches } = require('../services/matchingEngine');
const { getDriver } = require('../config/neo4j');
const { v4: uuidv4 } = require('uuid');
const { getPagination } = require('../utils/pagination');

const { STATUS_PENDING, STATUS_ACCEPTED, STATUS_DECLINED } = require('../utils/constants');
const toNumber = (val) => (val && val.toNumber ? val.toNumber() : val);

router.get('/:uid', verifyFirebaseToken, async (req, res, next) => {
  try {
    const uid   = req.params.uid;
    if (uid !== req.user.uid) return res.status(403).json({ success: false, error: 'Cannot fetch matches for another user' });
    const { limit, offset } = getPagination(req.query);
    const skill = req.query.skill || null;
    const matches = await findMatches(uid, { limit, offset, skillFilter: skill });
    res.json({ success: true, count: matches.length, limit, offset, hasMore: matches.length === limit, data: matches });
  } catch (err) { next(err); }
});

router.get('/:uid/broad', verifyFirebaseToken, async (req, res, next) => {
  try {
    const uid   = req.params.uid;
    if (uid !== req.user.uid) return res.status(403).json({ success: false, error: 'Cannot fetch matches for another user' });
    const { limit, offset } = getPagination(req.query);
    let matches = await findBroadMatches(uid, limit, offset);
    if (matches.length === 0) matches = await findAnyMatches(uid, limit, offset);
    res.json({ success: true, count: matches.length, limit, offset, hasMore: matches.length === limit, data: matches });
  } catch (err) { next(err); }
});

router.post('/request', verifyFirebaseToken, [
  body('toUid').trim().notEmpty(), body('sharedSkill').trim().notEmpty(),
], async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const errors = formatValidationErrors(req);
    if (errors) return res.status(400).json(errors);
    const fromUid = req.user.uid;
    const { toUid, sharedSkill } = req.body;
    if (fromUid === toUid) return res.status(400).json({ success: false, error: 'Cannot match with yourself' });
    
    const existing = await session.executeRead(tx => tx.run(`
      MATCH (u1:User {uid: $fromUid})-[r:REQUESTS_MATCH {status: $status}]->(u2:User {uid: $toUid}) RETURN r
    `, { fromUid, toUid, status: STATUS_PENDING }));
    if(existing.records.length > 0) return res.status(409).json({ success: false, error: 'Match request already pending' });
    
    const matchCheck = await session.executeRead(tx => tx.run(`
      MATCH (u1:User {uid: $fromUid})-[:PARTICIPATES_IN]->(t:ChatThread)<-[:PARTICIPATES_IN]-(u2:User {uid: $toUid}) RETURN t
    `, { fromUid, toUid }));
    if(matchCheck.records.length > 0) return res.status(409).json({ success: false, error: 'Already matched with this user' });
    
    const requestId = uuidv4();
    await session.executeWrite(tx => tx.run(`
      MATCH (u1:User {uid: $fromUid}), (u2:User {uid: $toUid})
      CREATE (u1)-[r:REQUESTS_MATCH {requestId: $requestId, sharedSkill: $sharedSkill, status: $status, createdAt: timestamp()}]->(u2)
    `, { fromUid, toUid, requestId, sharedSkill, status: STATUS_PENDING }));
    
    res.status(201).json({ success: true, data: { requestId, fromUid, toUid, sharedSkill, status: STATUS_PENDING } });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.post('/accept', verifyFirebaseToken, [body('requestId').trim().notEmpty()], async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const errors = formatValidationErrors(req);
    if (errors) return res.status(400).json(errors);
    const { requestId } = req.body;
    
    const reqRes = await session.executeRead(tx => tx.run(`
      MATCH (u1:User)-[r:REQUESTS_MATCH {requestId: $requestId}]->(u2:User {uid: $uid})
      RETURN r, u1.uid AS fromUid
    `, { requestId, uid: req.user.uid }));
    if(reqRes.records.length === 0) return res.status(404).json({ success: false, error: 'Request not found or unauthorized' });
    
    const reqData = reqRes.records[0].get('r').properties;
    const fromUid = reqRes.records[0].get('fromUid');
    if(reqData.status !== STATUS_PENDING) return res.status(400).json({ success: false, error: 'Request not pending' });
    
    const matchId = uuidv4();
    await session.executeWrite(tx => tx.run(`
      MATCH (u1:User {uid: $fromUid})-[r:REQUESTS_MATCH {requestId: $requestId}]->(u2:User {uid: $toUid})
      SET r.status = $status
      WITH u1, u2
      CREATE (t:ChatThread {id: $matchId, createdAt: timestamp(), lastMessage: '', lastMessageTime: 0, sharedSkills: [$sharedSkill]})
      CREATE (u1)-[:PARTICIPATES_IN]->(t)
      CREATE (u2)-[:PARTICIPATES_IN]->(t)
    `, { fromUid, toUid: req.user.uid, requestId, status: STATUS_ACCEPTED, matchId, sharedSkill: reqData.sharedSkill || '' }));
    
    res.json({ success: true, data: { matchId } });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.post('/decline', verifyFirebaseToken, [body('requestId').trim().notEmpty()], async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    const errors = formatValidationErrors(req);
    if (errors) return res.status(400).json(errors);
    const { requestId } = req.body;
    
    const reqRes = await session.executeWrite(tx => tx.run(`
      MATCH (u1:User)-[r:REQUESTS_MATCH {requestId: $requestId}]->(u2:User {uid: $uid})
      SET r.status = $status RETURN r
    `, { requestId, uid: req.user.uid, status: STATUS_DECLINED }));
    if(reqRes.records.length === 0) return res.status(404).json({ success: false, error: 'Request not found or unauthorized' });
    
    res.json({ success: true, message: 'Match request declined' });
  } catch (err) { next(err); } finally { await session.close(); }
});

router.get('/requests/:uid', verifyFirebaseToken, async (req, res, next) => {
  const driver = getDriver();
  const session = driver.session();
  try {
    if (req.params.uid !== req.user.uid) return res.status(403).json({ success: false, error: 'Cannot fetch another user\'s requests' });
    const { limit, offset } = getPagination(req.query);
    const result = await session.executeRead(tx => tx.run(`
      MATCH (u1:User)-[r:REQUESTS_MATCH {status: $status}]->(u2:User {uid: $uid})
      RETURN r, u1.uid AS fromUid
      ORDER BY r.createdAt DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
    `, { uid: req.params.uid, status: STATUS_PENDING, limit, offset }));
    const requests = result.records.map(r => {
      const p = r.get('r').properties;
      p.fromUid = r.get('fromUid');
      p.toUid = req.params.uid;
      p.createdAt = toNumber(p.createdAt);
      return p;
    });
    res.json({ success: true, count: requests.length, limit, offset, hasMore: requests.length === limit, data: requests });
  } catch (err) { next(err); } finally { await session.close(); }
});

module.exports = router;
