/**
 * chatService.js — Real-Time WebSocket Chat Service
 *
 * Native WebSocket implementation for P2P chat between matched peers.
 * Messages are persisted to Neo4j AuraDB directly.
 */

const { WebSocketServer } = require('ws');
const url                  = require('url');
const { auth }             = require('../config/firebase');
const { getDriver }        = require('../config/neo4j');

const rooms = new Map();
const globalRooms = new Map();
const clients = new Map();

function initWebSocketServer(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path:   '/ws',
    maxPayload: 64 * 1024,
  });

  wss.on('connection', async (ws, req) => {
    const parsed = url.parse(req.url, true);
    const token  = parsed.query.token;

    if (!token) {
      ws.close(4001, 'Missing authentication token');
      return;
    }

    let user;
    try {
      const decoded = await auth.verifyIdToken(token);
      user = {
        uid:   decoded.uid,
        email: decoded.email || '',
        name:  decoded.name  || '',
      };
    } catch (_err) {
      ws.close(4003, 'Invalid authentication token');
      return;
    }

    clients.set(ws, user);
    
    if (!globalRooms.has(user.uid)) globalRooms.set(user.uid, new Set());
    globalRooms.get(user.uid).add(ws);

    console.log(`🔌 WS connected: ${user.name} (${user.uid})`);

    ws.on('message', async (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch (_e) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
        return;
      }

      switch (data.type) {
        case 'join':
          await handleJoin(ws, user, data.matchId);
          break;
        case 'message':
          await handleMessage(ws, user, data.matchId, data.text, data.localId);
          break;
        case 'typing':
          handleTyping(ws, user, data.matchId);
          break;
        case 'edit_message':
          await handleEditMessage(ws, user, data.matchId, data.messageId, data.text);
          break;
        case 'delete_message':
          await handleDeleteMessage(ws, user, data.matchId, data.messageId);
          break;
        case 'read':
          await handleRead(user, data.matchId);
          break;
        default:
          ws.send(JSON.stringify({ type: 'error', error: `Unknown type: ${data.type}` }));
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      if (globalRooms.has(user.uid)) {
        globalRooms.get(user.uid).delete(ws);
        if (globalRooms.get(user.uid).size === 0) {
          globalRooms.delete(user.uid);
        }
      }
      
      for (const [matchId, members] of rooms) {
        members.delete(ws);
        if (members.size === 0) rooms.delete(matchId);
        else broadcastToRoom(matchId, { type: 'presence', uid: user.uid, status: 'offline' }, ws);
      }
      console.log(`🔌 WS disconnected: ${user.name}`);
    });

    ws.on('error', (err) => {
      console.error(`WS error for ${user.uid}:`, err.message);
    });
  });

  console.log('✅ WebSocket server initialized on /ws');
  return wss;
}

async function handleJoin(ws, user, matchId) {
  if (!matchId) {
    ws.send(JSON.stringify({ type: 'error', error: 'matchId is required' }));
    return;
  }
  const isParticipant = await userCanAccessThread(user.uid, matchId);
  if (!isParticipant) {
    ws.send(JSON.stringify({ type: 'error', error: 'Not a participant in this chat thread' }));
    return;
  }
  if (!rooms.has(matchId)) rooms.set(matchId, new Set());
  rooms.get(matchId).add(ws);
  broadcastToRoom(matchId, { type: 'presence', uid: user.uid, status: 'online' }, ws);
  ws.send(JSON.stringify({ type: 'joined', matchId }));
}

async function handleMessage(ws, user, matchId, text, localId = null) {
  if (!matchId || !text) {
    ws.send(JSON.stringify({ type: 'error', error: 'matchId and text are required' }));
    return;
  }

  const timestamp = Date.now();
  const driver = getDriver();
  const session = driver.session();
  try {
    const res = await session.executeWrite(async (tx) => {
      const messageId = require('crypto').randomUUID();
      
      const writeRes = await tx.run(
        `MATCH (u:User {uid: $uid})-[:PARTICIPATES_IN]->(t:ChatThread {id: $matchId})
         CREATE (m:Message {
           messageId: $messageId,
           senderUid: $uid,
           text: $text,
           timestamp: $timestamp,
           read: false,
           isEdited: false
         })
         CREATE (u)-[:SENT]->(m)-[:IN_THREAD]->(t)
         SET t.lastMessage = $text,
             t.lastMessageTime = $timestamp,
             t.lastMessageSender = $uid,
             t.unread = true
         RETURN m.messageId AS msgId
        `,
        { matchId, uid: user.uid, text, timestamp, messageId }
      );
      if (writeRes.records.length === 0) {
        throw Object.assign(new Error('Not a participant in this chat thread'), { statusCode: 403 });
      }
      
      // Find the recipient (the other user in the thread)
      // Usually matching is handled in matches, we can look up participants
      const participantsRes = await tx.run(`
         MATCH (u:User)-[:PARTICIPATES_IN]->(t:ChatThread {id: $matchId})
         WHERE u.uid <> $uid
         RETURN u.uid AS recipientUid, u.fcmToken AS fcmToken
      `, { matchId, uid: user.uid });
      
      let recipientUid = null;
      let fcmToken = null;
      if (participantsRes.records.length > 0) {
        recipientUid = participantsRes.records[0].get('recipientUid');
        fcmToken = participantsRes.records[0].get('fcmToken');
      }
      
      return { messageId, recipientUid, fcmToken };
    });
    
    const { messageId, recipientUid, fcmToken } = res;

    const outgoing = {
      type: 'message',
      matchId,
      messageId,
      localId,
      senderUid: user.uid,
      senderName: user.name,
      text,
      timestamp,
    };

    broadcastToRoom(matchId, outgoing, ws);

    if (recipientUid) {
      broadcastToGlobal(recipientUid, {
        ...outgoing,
        type: 'global_new_message',
      });

      if (fcmToken) {
        try {
          const { admin } = require('../config/firebase');
          await admin.messaging().send({
            token: fcmToken,
            notification: { title: user.name, body: text },
            data: {
              type: 'chat',
              matchId,
              messageId,
              senderUid: user.uid,
              timestamp: String(timestamp),
              url: `/chat/${matchId}`,
            }
          });
          console.log(`✅ FCM push sent to ${recipientUid}`);
        } catch (err) {
          console.warn('⚠️  FCM push failed:', err.message);
        }
      }
    }

  } catch (err) {
    console.error('❌ Chat message persist error:', err.message);
    ws.send(JSON.stringify({ type: 'error', error: 'Failed to send message' }));
  } finally {
    await session.close();
  }
}

function handleTyping(ws, user, matchId) {
  if (!matchId) return;
  broadcastToRoom(matchId, { type: 'typing', uid: user.uid, matchId }, ws);
}

async function handleRead(user, matchId) {
  if (!matchId) return;
  const isParticipant = await userCanAccessThread(user.uid, matchId);
  if (!isParticipant) return;
  const driver = getDriver();
  const session = driver.session();
  try {
    await session.executeWrite(tx => tx.run(`
      MATCH (m:Message)-[:IN_THREAD]->(t:ChatThread {id: $matchId})
      WHERE NOT (m)<-[:SENT]-(:User {uid: $uid}) AND m.read = false
      SET m.read = true
      WITH t
      SET t.unread = false
    `, { matchId, uid: user.uid }));
    broadcastToRoom(matchId, { type: 'read_receipt', matchId, readerUid: user.uid });
  } catch (err) {
    console.error('❌ Mark read error:', err.message);
  } finally {
    await session.close();
  }
}

async function userCanAccessThread(uid, matchId) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const res = await session.executeRead(tx => tx.run(`
      MATCH (:User {uid: $uid})-[:PARTICIPATES_IN]->(:ChatThread {id: $matchId})
      RETURN 1
    `, { uid, matchId }));
    return res.records.length > 0;
  } catch (err) {
    console.error('❌ Thread access check error:', err.message);
    return false;
  } finally {
    await session.close();
  }
}

function broadcastToRoom(matchId, payload, excludeWs = null) {
  const members = rooms.get(matchId);
  if (!members) return;
  const msgStr = JSON.stringify(payload);
  for (const client of members) {
    if (client !== excludeWs && client.readyState === 1) client.send(msgStr);
  }
}

function broadcastToGlobal(uid, payload) {
  const members = globalRooms.get(uid);
  if (!members) return;
  const msgStr = JSON.stringify(payload);
  for (const client of members) {
    if (client.readyState === 1) client.send(msgStr);
  }
}

async function handleEditMessage(ws, user, matchId, messageId, text) {
  if (!matchId || !messageId || !text) return;
  const driver = getDriver();
  const session = driver.session();
  try {
    const res = await session.executeWrite(tx => tx.run(`
      MATCH (u:User {uid: $uid})-[:SENT]->(m:Message {messageId: $messageId})-[:IN_THREAD]->(t:ChatThread {id: $matchId})
      SET m.text = $text, m.isEdited = true
      RETURN m
    `, { uid: user.uid, messageId, matchId, text }));
    
    if (res.records.length > 0) {
      broadcastToRoom(matchId, { type: 'message_edited', messageId, text, matchId });
    }
  } catch (err) {
    console.error('Error editing message:', err);
  } finally {
    await session.close();
  }
}

async function handleDeleteMessage(ws, user, matchId, messageId) {
  if (!matchId || !messageId) return;
  const driver = getDriver();
  const session = driver.session();
  try {
    const res = await session.executeWrite(tx => tx.run(`
      MATCH (u:User {uid: $uid})-[:SENT]->(m:Message {messageId: $messageId})-[:IN_THREAD]->(t:ChatThread {id: $matchId})
      DETACH DELETE m
      RETURN 1
    `, { uid: user.uid, messageId, matchId }));
    
    if (res.records.length > 0) {
      broadcastToRoom(matchId, { type: 'message_deleted', messageId, matchId });
    }
  } catch (err) {
    console.error('Error deleting message:', err);
  } finally {
    await session.close();
  }
}

module.exports = { initWebSocketServer, broadcastToGlobal };
