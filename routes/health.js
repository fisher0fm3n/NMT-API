const { Router } = require("express");

module.exports = function healthRoutes({ openai }) {
  const router = Router();

  router.get("/health", (req, res) => {
    res.json({ ok: true, message: "API is healthy", openaiKeyLoaded: !!openai });
  });

  router.get("/_openai_ping", async (req, res) => {
    try {
      const r = await openai.models.list();
      res.json({ ok: true, modelCount: r.data.length });
    } catch (e) {
      console.error("OpenAI ping failed:", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  return router;
};
