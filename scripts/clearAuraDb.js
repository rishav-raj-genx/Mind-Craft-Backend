require('dotenv').config();

const { getDriver, closeDriver } = require('../src/config/neo4j');

async function clearAuraDb() {
  if (process.env.CONFIRM_CLEAR_AURADB !== 'YES') {
    throw new Error('Refusing to clear AuraDB. Re-run with CONFIRM_CLEAR_AURADB=YES.');
  }

  const driver = getDriver();
  const session = driver.session();
  try {
    await session.executeWrite(tx => tx.run('MATCH (n) DETACH DELETE n'));
    console.log('AuraDB cleared: all nodes and relationships deleted.');
  } finally {
    await session.close();
    await closeDriver();
  }
}

clearAuraDb().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
