// lib/config.js
//
// Secrets this service needs, read only from the environment (.env on the
// server). Nothing secret has a default here: if a variable is missing, the
// code that needs it fails with a message naming the variable, instead of
// falling back to a password baked into the source.

// Postgres on the main server (pcdl, pcdl_affiliate, ceflix, pco_fn). Every
// route that connects there passes its own database name; the server, user
// and password are shared and come from the PCO_FN_DB_* variables, the same
// ones routes/nmm.js, routes/kingspresenter.js and routes/loveworld_expo.js
// already fall back to.
function pgConfig(database) {
  return {
    user: process.env.PCO_FN_DB_USER || "postgres",
    host: process.env.PCO_FN_DB_HOST || "102.219.189.166",
    database,
    password: required("PCO_FN_DB_PASSWORD"),
    port: Number(process.env.PCO_FN_DB_PORT || 5432),
  };
}

// MongoDB connection string, e.g.
// mongodb://siteAdmin:<password>@127.0.0.1:27017/myapi_db?authSource=admin
function mongoUrl() {
  return required("MONGO_URL");
}

// Key sent with requests to the external fetchUserToken API.
function fetchUserTokenKey() {
  return required("FETCH_USER_TOKEN_KEY");
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; add it to .env`);
  return value;
}

// The variables above that are missing, so startup can warn about them
// before the first request fails.
function missingSecrets() {
  return ["PCO_FN_DB_PASSWORD", "MONGO_URL", "FETCH_USER_TOKEN_KEY"].filter(
    (name) => !process.env[name],
  );
}

module.exports = { pgConfig, mongoUrl, fetchUserTokenKey, missingSecrets };
