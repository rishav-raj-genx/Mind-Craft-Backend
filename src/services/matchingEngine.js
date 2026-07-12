/**
 * matchingEngine.js — Graph-Based Tutor Matching via Neo4j
 *
 * Traverses the Neo4j graph to find the best tutor matches for a
 * student. Matches are ranked by:
 *   1. Same college (hard filter)
 *   2. Number of shared syllabus topics (skill overlap)
 *   3. Tutor activity score (total TEACHES relationships)
 *   4. Average rating (tiebreaker)
 *
 * This is the read-path that queries the graph built by neo4jSync.js.
 */

const { getDriver } = require('../config/neo4j');

/**
 * Finds the best tutor matches for a student within their own college.
 *
 * The Cypher query:
 *   1. Starts from the requesting student
 *   2. Traverses LEARNS|TEACHES to find tutors who complement the skills
 *   3. Filters to same college only
 *   4. Counts shared skills and tutor activity (total teaching edges)
 *   5. Sorts by activity score DESC, shared skills DESC, rating DESC
 *
 * @param {string} uid — The requesting student's Firebase UID
 * @param {object} [options]
 * @param {number} [options.limit=20]    — Max results to return
 * @param {number} [options.offset=0]    — Offset for paged results
 * @param {string} [options.skillFilter] — Optional: match only this skill
 * @returns {Promise<Array<object>>} Ranked list of tutor matches
 */
async function findMatches(uid, options = {}) {
  const { limit = 20, offset = 0, skillFilter = null } = options;
  const driver  = getDriver();
  const session = driver.session({ database: process.env.NEO4J_DATABASE || 'neo4j', defaultAccessMode: 'READ' });

  try {
    // Build the Cypher query with optional skill filter
    const skillClause = skillFilter
      ? 'AND skill.name = $skillFilter'
      : '';

    const result = await session.run(
      `MATCH (student:User { uid: $uid })-[r1:LEARNS|TEACHES]->(skill:Skill)<-[r2:TEACHES|LEARNS]-(tutor:User)
       WHERE tutor.college = student.college
         AND tutor.uid <> student.uid
         AND type(r1) <> type(r2)
         ${skillClause}
       WITH tutor,
            collect(DISTINCT skill.name) AS sharedSkills,
            SIZE([(tutor)-[:TEACHES]->(s:Skill) | s]) AS activityScore
       RETURN tutor {
         .uid, .name, .email, .photoUrl, .college, .department,
         .year, .averageRating, .totalSessions, .latitude, .longitude
       } AS tutorData,
       sharedSkills,
       activityScore
       ORDER BY activityScore DESC, SIZE(sharedSkills) DESC, tutor.averageRating DESC
       SKIP $offset
       LIMIT $limit`,
      {
        uid,
        limit: neo4jInt(limit),
        offset: neo4jInt(offset),
        ...(skillFilter ? { skillFilter } : {}),
      },
    );

    return result.records.map((record) => ({
      tutor:         record.get('tutorData'),
      sharedSkills:  record.get('sharedSkills'),
      activityScore: toNumber(record.get('activityScore')),
    }));
  } catch (err) {
    console.error('❌ Match query failed:', err.message);
    throw err;
  } finally {
    await session.close();
  }
}

/**
 * Finds matches across ALL colleges (broader search fallback).
 *
 * Used when same-college matching returns too few results.
 *
 * @param {string} uid
 * @param {number} [limit=20]
 * @returns {Promise<Array<object>>}
 */
async function findBroadMatches(uid, limit = 20, offset = 0) {
  const driver  = getDriver();
  const session = driver.session({ database: process.env.NEO4J_DATABASE || 'neo4j', defaultAccessMode: 'READ' });

  try {
    const result = await session.run(
      `MATCH (student:User { uid: $uid })-[r1:LEARNS|TEACHES]->(skill:Skill)<-[r2:TEACHES|LEARNS]-(tutor:User)
       WHERE tutor.uid <> student.uid
         AND type(r1) <> type(r2)
       WITH tutor,
            collect(DISTINCT skill.name) AS sharedSkills,
            SIZE([(tutor)-[:TEACHES]->(s:Skill) | s]) AS activityScore,
            CASE WHEN tutor.college = student.college THEN 1 ELSE 0 END AS sameCollege
       RETURN tutor {
         .uid, .name, .email, .photoUrl, .college, .department,
         .year, .averageRating, .totalSessions, .latitude, .longitude
       } AS tutorData,
       sharedSkills,
       activityScore,
       sameCollege
       ORDER BY sameCollege DESC, activityScore DESC, SIZE(sharedSkills) DESC
       SKIP $offset
       LIMIT $limit`,
      { uid, limit: neo4jInt(limit), offset: neo4jInt(offset) },
    );

    return result.records.map((record) => ({
      tutor:         record.get('tutorData'),
      sharedSkills:  record.get('sharedSkills'),
      activityScore: toNumber(record.get('activityScore')),
      sameCollege:   toNumber(record.get('sameCollege')) === 1,
    }));
  } catch (err) {
    console.error('❌ Broad match query failed:', err.message);
    throw err;
  } finally {
    await session.close();
  }
}

/**
 * Final fallback: any active users (highest rated)
 * Used when broad matches are also empty.
 */
async function findAnyMatches(uid, limit = 20, offset = 0) {
  const driver  = getDriver();
  const session = driver.session({ database: process.env.NEO4J_DATABASE || 'neo4j', defaultAccessMode: 'READ' });

  try {
    const result = await session.run(
      `MATCH (tutor:User)
       WHERE tutor.uid <> $uid
       RETURN tutor {
         .uid, .name, .email, .photoUrl, .college, .department,
         .year, .averageRating, .totalSessions, .latitude, .longitude
       } AS tutorData
       ORDER BY tutor.averageRating DESC, tutor.totalSessions DESC
       SKIP $offset
       LIMIT $limit`,
      { uid, limit: neo4jInt(limit), offset: neo4jInt(offset) },
    );

    return result.records.map((record) => ({
      tutor:         record.get('tutorData'),
      sharedSkills:  [],
      activityScore: 0,
      sameCollege:   false,
    }));
  } catch (err) {
    console.error('❌ Any match query failed:', err.message);
    throw err;
  } finally {
    await session.close();
  }
}

/**
 * Retrieves the skill graph for a single user (what they teach + learn).
 * Useful for the profile page.
 *
 * @param {string} uid
 * @returns {Promise<{ teaches: string[], learns: string[] }>}
 */
async function getUserSkillGraph(uid) {
  const driver  = getDriver();
  const session = driver.session({ database: process.env.NEO4J_DATABASE || 'neo4j', defaultAccessMode: 'READ' });

  try {
    const result = await session.run(
      `MATCH (u:User { uid: $uid })
       OPTIONAL MATCH (u)-[:TEACHES]->(ts:Skill)
       OPTIONAL MATCH (u)-[:LEARNS]->(ls:Skill)
       RETURN collect(DISTINCT ts.name) AS teaches,
              collect(DISTINCT ls.name) AS learns`,
      { uid },
    );

    const record = result.records[0];
    return {
      teaches: record ? record.get('teaches').filter(Boolean) : [],
      learns:  record ? record.get('learns').filter(Boolean)  : [],
    };
  } finally {
    await session.close();
  }
}

// ── Neo4j integer helpers ─────────────────────────────────────────────
const neo4j = require('neo4j-driver');

function neo4jInt(value) {
  return neo4j.int(value);
}

function toNumber(value) {
  if (neo4j.isInt(value)) return value.toNumber();
  return typeof value === 'number' ? value : Number(value);
}

module.exports = {
  findMatches,
  findBroadMatches,
  findAnyMatches,
  getUserSkillGraph,
};
