// /var/www/myapi/db.js
const { MongoClient } = require('mongodb');

const uri = 'mongodb://siteAdmin:77uhu6tsf38hhl8ly0rl0@127.0.0.1:27017/myapi_db?authSource=admin';
let client;
let db;

async function getDb() {
  if (db) return db;
  if (!client) {
    client = new MongoClient(uri, { maxPoolSize: 10 });
  }
  if (!client.topology || !client.topology.isConnected()) {
    await client.connect();
  }
  db = client.db('NMT');
  return db;
}

async function closeDb() {
  if (client) await client.close();
  client = null; db = null;
}

module.exports = { getDb, closeDb };
