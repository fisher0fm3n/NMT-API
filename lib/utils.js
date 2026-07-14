const axios = require("axios");

const ESPEES_CONFIRM_URL = "https://api.espees.org/v2/payment/confirm/";
const CONFIRM_MAX_RETRIES = 3;
const CONFIRM_DELAY_MS = 2000;
const sleep = (ms)=> new Promise(r => setTimeout(r, ms));
const withJitter = (ms)=> Math.round(ms + (Math.random()*2-1)*ms*0.2);

function providerKey(s) {
  return String(s||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");
}

function trimDeep(v){
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(trimDeep);
  if (v && typeof v === "object") {
    const o = {}; for (const [k,val] of Object.entries(v)) o[k]=trimDeep(val);
    return o;
  }
  return v;
}

async function confirmEspeesWithRetry(paymentRef, apiKey) {
  for (let attempt = 1; attempt <= CONFIRM_MAX_RETRIES; attempt++) {
    try {
      const resp = await axios.post(
        ESPEES_CONFIRM_URL,
        { payment_ref: paymentRef },
        { headers: { "content-type":"application/json","x-api-key": apiKey }, timeout: 15000, validateStatus: () => true }
      );
      if (resp.status >= 200 && resp.status < 300) return resp;
      if (attempt < CONFIRM_MAX_RETRIES) { await sleep(withJitter(CONFIRM_DELAY_MS * attempt)); continue; }
      const err = new Error(`Provider responded with ${resp.status}`); err.response = resp; throw err;
    } catch (err) {
      const transient = !err.response || err.code === "ECONNABORTED";
      if (transient && attempt < CONFIRM_MAX_RETRIES) { await sleep(withJitter(CONFIRM_DELAY_MS * attempt)); continue; }
      throw err;
    }
  }
}

function asyncHandler(fn) {
  return (req,res,next)=> Promise.resolve(fn(req,res,next)).catch(next);
}

module.exports = { providerKey, trimDeep, confirmEspeesWithRetry, asyncHandler };
