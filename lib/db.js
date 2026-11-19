const { MongoClient } = require("mongodb");
const { mongoUrl } = require("./config");

const MONGO_DBNAME = "NMT";

let _client, _db;
async function getDb() {
  if (_db) return _db;
  if (!_client) _client = new MongoClient(mongoUrl(),{ maxPoolSize: 10 });
  if (!_client.topology || !_client.topology.isConnected()) await _client.connect();
  _db = _client.db(MONGO_DBNAME);
  return _db;
}
async function closeDb() {
  try { if (_client) await _client.close(); } catch {}
  _client = null; _db = null;
}

module.exports = { getDb, closeDb };
