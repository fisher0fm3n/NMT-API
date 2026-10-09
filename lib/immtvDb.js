// lib/immtvDb.js
//
// One MySQL pool for the KingsSpace/CeFlix database (db_immtv), shared by
// everything in this service that reads videos, channels or user interests.
// Environment variables override the defaults, which match what
// routes/kingsspace.js used before this module existed.
const mysql = require("mysql2/promise");

let pool = null;

function getImmtvPool() {
  if (pool) return pool;

  pool = mysql.createPool({
    host:
      process.env.IMMTV_DB_HOST ||
      process.env.DB_HOST ||
      "myinstance-cluster.cluster-cuisll1bhvo4.us-east-1.rds.amazonaws.com",
    port: Number(process.env.IMMTV_DB_PORT || process.env.DB_PORT || 3306),
    user: process.env.IMMTV_DB_USER || process.env.DB_USERNAME || "usr_immtv_web",
    password:
      process.env.IMMTV_DB_PASSWORD ||
      process.env.DB_PASSWORD ||
      "094ru394utjg3jt3SJDJJD",
    database: process.env.IMMTV_DB_NAME || process.env.DB_DATABASE || "db_immtv",
    waitForConnections: true,
    connectionLimit: Number(process.env.IMMTV_DB_POOL_SIZE || 10),
    queueLimit: 0,
    charset: "utf8mb4",
    connectTimeout: 10000,
    ssl:
      String(process.env.IMMTV_DB_SSL || "").toLowerCase() === "false"
        ? undefined
        : { rejectUnauthorized: false },
  });

  return pool;
}

module.exports = { getImmtvPool };
