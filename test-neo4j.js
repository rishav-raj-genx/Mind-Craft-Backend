require('dotenv').config();
const neo4j = require('neo4j-driver');
const uri = process.env.NEO4J_URI;
const user = process.env.NEO4J_USER;
const password = process.env.NEO4J_PASSWORD;

console.log(`Testing connection to ${uri} with user ${user}...`);
const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

async function run() {
  try {
    const serverInfo = await driver.getServerInfo();
    console.log('✅ Connected to Neo4j:', serverInfo);
  } catch (err) {
    console.error('❌ Connection failed:', err);
  } finally {
    await driver.close();
  }
}
run();
