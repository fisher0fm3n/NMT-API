const { Router } = require("express");
const healthRoutes = require("./health");
const askPcoRoutes = require("./askPco");
const espeesRoutes = require("./espees");
const pcdlRoutes = require("./pcdl");
const pcdlGamificationRoutes = require("./pcdl_gamification");
const kingsspaceRoutes = require("./kingsspace");
const ceflixRoutes = require("./ceflix");
const nmtRoutes = require("./nmt");
const pcdlAffiliateRoutes = require("./pcdl_affiliate");

module.exports = function buildRoutes(deps) {
  const router = Router();

  // Global auth/header/CORS middleware can also live in server.js
  router.use(healthRoutes(deps));
  router.use(askPcoRoutes(deps));
  router.use(espeesRoutes(deps));
  router.use(pcdlRoutes(deps));
  router.use(pcdlGamificationRoutes(deps));
  router.use(kingsspaceRoutes(deps));
  router.use(ceflixRoutes(deps));
  router.use(nmtRoutes(deps));
  router.use(pcdlAffiliateRoutes(deps));

  return router;
};
