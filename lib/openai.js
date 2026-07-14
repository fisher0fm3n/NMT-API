const OpenAI = require("openai");

// pass fetch from undici (Node 16)
function makeOpenAI({ apiKey, fetch }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey, fetch });
}

async function embedTexts(openai, model, texts) {
  const resp = await openai.embeddings.create({ model, input: texts });
  return resp.data.map(d => d.embedding);
}

module.exports = { makeOpenAI, embedTexts };
