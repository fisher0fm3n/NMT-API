// /var/www/myapi/db.js
// Kept so anything that still requires ./db keeps working. The connection,
// and the MONGO_URL setting it reads from .env, live in lib/db.js.
module.exports = require("./lib/db");
