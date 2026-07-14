const { MongoClient } = require("mongodb");

const MONGO_URL = "mongodb://siteAdmin:77uhu6tsf38hhl8ly0rl0@127.0.0.1:27017/myapi_db?authSource=admin";
const MONGO_DBNAME = "NMT";

let _client, _db;
async function getDb() {
  if (_db) return _db;
  if (!_client) _client = new MongoClient(MONGO_URL, { maxPoolSize: 10 });
  if (!_client.topology || !_client.topology.isConnected()) await _client.connect();
  _db = _client.db(MONGO_DBNAME);
  return _db;
}
async function closeDb() {
  try { if (_client) await _client.close(); } catch {}
  _client = null; _db = null;
}

module.exports = { getDb, closeDb };
