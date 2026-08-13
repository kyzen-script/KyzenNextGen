// End-to-end test of the Kyzen backend flow with enforced Link4m verification.
// Simulates a persistent browser (cookie jar) going through:
//   /get-key  ->  (Link4m simulated)  ->  /claim-ok?token=XXXX  ->  /claim  ->  key
import "./.env-loader.js";
import Database from "better-sqlite3";
import { identifierFromFingerprint } from "./crypto.js";

const PORT = Number(process.env.PORT) || 8799;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}

async function main() {
  let cookieHeader = "";

  function parseSetCookie(setCookie) {
    if (!setCookie) return "";
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    const pairs = [];
    for (const c of arr) {
      const m = c.match(/^([^=;]+)=([^;]*)/);
      if (m) pairs.push(`${m[1]}=${m[2]}`);
    }
    return pairs.join("; ");
  }
  function mergeCookie(prev, setCookie) {
    const got = parseSetCookie(setCookie);
    if (!got) return prev;
    const map = new Map();
    for (const part of (prev + ";" + got).split(";")) {
      const p = part.trim(); if (!p) continue;
      const i = p.indexOf("="); if (i > 0) map.set(p.slice(0, i), p.slice(i + 1));
    }
    return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  const log = (...a) => console.log(...a);

  // ----------------------------------------------------------------
  // STEP 1: GET /get-key — creates an UNVERIFIED session + cookie.
  // In sandbox Link4m API is blocked, so we get the fallback HTML page
  // (status 200) instead of a 302 redirect. Extract the token from DB.
  // ----------------------------------------------------------------
  log("\n=== STEP 1: GET /get-key (persistent browser, no prior key) ===");
  let res = await fetch(BASE + "/get-key", { redirect: "manual", headers: { cookie: cookieHeader } });
  cookieHeader = mergeCookie(cookieHeader, res.headers.get("set-cookie"));
  const fpCookie = (cookieHeader.match(/kz_fp=([^;]+)/) || [])[1] || "";
  const identifier = identifierFromFingerprint(fpCookie);
  log("  status:", res.status, "| identifier:", identifier, "| has cookie:", !!fpCookie);
  check(res.status === 200 || res.status === 302, "/get-key returns 200 (sandbox fallback) or 302 (prod redirect)");
  check(!!identifier, "fingerprint cookie resolves to an identifier");

  const db = new Database("./data/kyzen.db");
  let sess = db.prepare("SELECT id, verified FROM claim_sessions WHERE identifier=? ORDER BY createdAt DESC LIMIT 1").get(identifier);
  const token1 = sess?.id;
  log("  claim token:", token1, "| verified (should be 0):", sess?.verified);
  check(!!token1, "claim session created in DB");
  check(sess?.verified === 0, "session is NOT verified yet (Link4m pending)");

  // ----------------------------------------------------------------
  // STEP 2: Hit /claim.json DIRECTLY without Link4m -> must be BLOCKED (403)
  // ----------------------------------------------------------------
  log("\n=== STEP 2: GET /claim.json WITHOUT Link4m -> expect 403 blocked ===");
  res = await fetch(`${BASE}/claim.json?token=${token1}`, { headers: { cookie: cookieHeader } });
  const blockedJson = await res.json();
  log("  status:", res.status, "| body:", JSON.stringify(blockedJson));
  check(res.status === 403, "direct /claim.json without Link4m returns 403");
  check(blockedJson.needLink4m === true, "response indicates link4m verification required");

  // ----------------------------------------------------------------
  // STEP 2b: Hit /claim (HTML) directly without Link4m -> must be BLOCKED (403)
  // ----------------------------------------------------------------
  log("\n=== STEP 2b: GET /claim (HTML) WITHOUT Link4m -> expect 403 link4mRequiredPage ===");
  res = await fetch(`${BASE}/claim?token=${token1}`, { headers: { cookie: cookieHeader } });
  const blockedHtml = await res.text();
  log("  status:", res.status, "| html contains 'XÁC MINH LINK4M':", blockedHtml.includes("XÁC MINH LINK4M"));
  check(res.status === 403, "direct /claim (HTML) without Link4m returns 403");
  check(blockedHtml.includes("XÁC MINH LINK4M") || blockedHtml.includes("Lấy Key qua Link4m"), "HTML shows the link4m-required page");

  // ----------------------------------------------------------------
  // STEP 3: Simulate Link4m redirect -> GET /claim-ok?token=XXXX
  // This marks the session verified, then 302 -> /claim
  // ----------------------------------------------------------------
  log("\n=== STEP 3: GET /claim-ok?token=XXXX (simulating Link4m redirect) ===");
  res = await fetch(`${BASE}/claim-ok?token=${token1}`, { redirect: "manual", headers: { cookie: cookieHeader, referer: "https://link4m.net/abc" } });
  log("  status:", res.status, "| location:", res.headers.get("location"));
  check(res.status === 302 || res.status === 301, "/claim-ok redirects (302) to /claim");
  check((res.headers.get("location") || "").includes("/claim?token="), "redirect location points to /claim?token=");

  // verify DB now shows verified
  sess = db.prepare("SELECT verified FROM claim_sessions WHERE id=?").get(token1);
  log("  session verified now:", sess?.verified);
  check(sess?.verified === 1, "session marked verified after /claim-ok");

  // ----------------------------------------------------------------
  // STEP 4: Now /claim.json works -> CREATE key
  // ----------------------------------------------------------------
  log("\n=== STEP 4: GET /claim.json AFTER Link4m -> CREATE key ===");
  res = await fetch(`${BASE}/claim.json?token=${token1}`, { headers: { cookie: cookieHeader } });
  const claim1 = await res.json();
  log("  response:", JSON.stringify(claim1));
  const key1 = claim1.key;
  check(res.status === 200, "/claim.json returns 200 after verification");
  check(claim1.success === true, "claim success=true");
  check(claim1.status === "created", "status=created (first key)");
  check(/^Kyzen_[0-9a-f]{24}$/.test(key1), "key format Kyzen_ + 24 hex");

  // ----------------------------------------------------------------
  // STEP 5: /claim.json AGAIN (same session+identifier) -> ACTIVE, SAME key
  // ----------------------------------------------------------------
  log("\n=== STEP 5: GET /claim.json AGAIN -> ACTIVE, SAME key ===");
  res = await fetch(`${BASE}/claim.json?token=${token1}`, { headers: { cookie: cookieHeader } });
  const claim2 = await res.json();
  log("  response:", JSON.stringify(claim2));
  check(claim2.key === key1, "returns SAME key (not a new one)");
  check(claim2.status === "active", "status=active (existing key)");

  // ----------------------------------------------------------------
  // STEP 6: Roblox POST /api/verify with real key -> valid
  // ----------------------------------------------------------------
  log("\n=== STEP 6: POST /api/verify with real key ===");
  res = await fetch(`${BASE}/api/verify`, {
    method: "POST", headers: { "content-type": "application/json", cookie: cookieHeader },
    body: JSON.stringify({ key: key1 }),
  });
  const verify1 = await res.json();
  log("  body:", JSON.stringify(verify1));
  check(verify1.valid === true && verify1.status === "active", "verify valid+active");

  // ----------------------------------------------------------------
  // STEP 7: POST /api/verify with FAKE key -> invalid
  // ----------------------------------------------------------------
  log("\n=== STEP 7: POST /api/verify with FAKE key ===");
  res = await fetch(`${BASE}/api/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "Kyzen_deadbeefdeadbeefdeadbeef" }),
  });
  const verify2 = await res.json();
  log("  body:", JSON.stringify(verify2));
  check(verify2.valid === false && verify2.status === "invalid", "fake key -> invalid");

  // ----------------------------------------------------------------
  // STEP 8: GET /api/verify?key= fallback
  // ----------------------------------------------------------------
  log("\n=== STEP 8: GET /api/verify?key= fallback ===");
  res = await fetch(`${BASE}/api/verify?key=${key1}`);
  const verify3 = await res.json();
  log("  body:", JSON.stringify(verify3));
  check(verify3.valid === true, "GET fallback verify works");

  // ----------------------------------------------------------------
  // STEP 9: Expired key -> expired
  // ----------------------------------------------------------------
  log("\n=== STEP 9: Expired key -> expired ===");
  const fakeKey = "Kyzen_expiredtest0001";
  db.prepare("INSERT OR REPLACE INTO keys (key,identifier,createdAt,expiresAt,status) VALUES (?,?,?,?,?)")
    .run(fakeKey, identifier, Date.now() - 100000, Date.now() - 50000, "active");
  res = await fetch(`${BASE}/api/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: fakeKey }),
  });
  const verify4 = await res.json();
  log("  body:", JSON.stringify(verify4));
  check(verify4.valid === false && verify4.status === "expired", "expired key -> expired");

  // ----------------------------------------------------------------
  // STEP 10: New browser (no cookie) -> must go through Link4m too, DIFFERENT key
  // ----------------------------------------------------------------
  log("\n=== STEP 10: New browser -> /get-key -> /claim-ok -> /claim -> DIFFERENT key ===");
  let cookie2 = "";
  res = await fetch(BASE + "/get-key", { redirect: "manual" });
  cookie2 = mergeCookie(cookie2, res.headers.get("set-cookie"));
  const fp2 = (cookie2.match(/kz_fp=([^;]+)/) || [])[1] || "";
  const id2 = identifierFromFingerprint(fp2);
  const sess3 = db.prepare("SELECT id, verified FROM claim_sessions WHERE identifier=? ORDER BY createdAt DESC LIMIT 1").get(id2);
  log("  id2:", id2, "| token:", sess3.id, "| verified:", sess3.verified);
  check(sess3.verified === 0, "new browser session also starts unverified");

  // new browser tries /claim directly -> blocked
  res = await fetch(`${BASE}/claim.json?token=${sess3.id}`, { headers: { cookie: cookie2 } });
  check(res.status === 403, "new browser direct /claim.json blocked too");

  // go through claim-ok
  res = await fetch(`${BASE}/claim-ok?token=${sess3.id}`, { redirect: "manual", headers: { cookie: cookie2, referer: "https://link4m.co/x" } });
  check(res.status === 302, "new browser /claim-ok redirects");

  res = await fetch(`${BASE}/claim.json?token=${sess3.id}`, { headers: { cookie: cookie2 } });
  const claim3 = await res.json();
  log("  new key:", claim3.key);
  check(claim3.success === true && /^Kyzen_/.test(claim3.key), "new browser gets a key after Link4m");
  check(claim3.key !== key1, "new browser key DIFFERS from first browser");

  // ----------------------------------------------------------------
  // STEP 11: Stats (admin)
  // ----------------------------------------------------------------
  log("\n=== STEP 11: Admin stats ===");
  res = await fetch(`${BASE}/admin/stats?password=${process.env.ADMIN_PASSWORD}`);
  const st = await res.json();
  log("  body:", JSON.stringify(st));
  check(res.status === 200 && typeof st.keys_active === "number", "admin stats accessible");

  // ----------------------------------------------------------------
  // STEP 12: HTML /claim page renders the key
  // ----------------------------------------------------------------
  log("\n=== STEP 12: HTML /claim page renders key + countdown ===");
  res = await fetch(`${BASE}/claim?token=${sess3.id}`, { headers: { cookie: cookie2 } });
  const html = await res.text();
  log("  contains key in HTML?", html.includes(claim3.key), "| countdown?", html.includes("countdown"));
  check(html.includes(claim3.key), "HTML /claim shows the key");
  check(html.includes("countdown"), "HTML /claim shows countdown timer");

  // ----------------------------------------------------------------
  log(`\n========================================`);
  log(`RESULTS: ${pass} passed, ${fail} failed`);
  log(`========================================\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error("TEST ERROR:", e); process.exit(1); });
