const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

let initialized = false;

function getFirebaseAdmin() {
  if (initialized) return admin;

  const filePath = path.join(__dirname, "./firebase-service-account.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const json = JSON.parse(raw);

  if (!json.project_id || !json.client_email || !json.private_key) {
    throw new Error("firebase-service-account.json is missing required fields");
  }

  const privateKey = String(json.private_key).replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: json.project_id,
      clientEmail: json.client_email,
      privateKey,
    }),
  });

  initialized = true;
  return admin;
}

module.exports = { getFirebaseAdmin };