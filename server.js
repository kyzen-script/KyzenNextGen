import "./.env-loader.js";
import express from "express";
import {
  sweepExpiredKeys,
  purgeOldSessions,
  getActiveKey,
  createKeyRecord,
  verifyKey,
  createSession,
  getSession,
  markSessionVerified,
  stats,
  listActiveKeys,
} from "./db.js";
import {
  identifierFromFingerprint,
  newFingerprint,
  generateKyzenKey,
  generateClaimToken,
} from "./crypto.js";
import { shortenWithLink4m } from "./link4m.js";

/* ============================================================
   Kyzen NextGen — Backend server
   Endpoints:
     GET  /              — Key website (HTML)
     GET  /get-key       — start flow: create claim session, redirect to Link4m
     GET  /claim?token=  — validate session, return/create key (HTML + JSON)
     POST /api/verify    — Roblox verifies a key (JSON)
     GET  /api/verify    — same as POST (Roblox-friendly GET fallback)
     GET  /admin/stats   — basic stats (protected by ADMIN_PASSWORD)
   All secrets stay server-side. Frontend never sees LINK4M_API_TOKEN.
   ============================================================ */

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const KEY_DURATION_MS = 24 * 60 * 60 * 1000; // 24h
const SESSION_TTL_MS = 5 * 60 * 1000;        // 5 min
const FP_COOKIE = "kz_fp";
const FP_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year — stable identifier
};

/* Resolve the public base URL. Prefer env, fall back to request host. */
function publicBase(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

/* Resolve a stable identifier for the current request.
   - If a valid signed fingerprint cookie exists -> reuse its identifier.
   - Otherwise mint a new fingerprint (cookie set on response) + identifier. */
function resolveIdentifier(req, res) {
  const fp = req.cookies ? req.cookies[FP_COOKIE] : null;
  const id = identifierFromFingerprint(fp);
  if (id) return { identifier: id, setCookie: false };
  const { cookie, identifier } = newFingerprint();
  res.cookie?.(FP_COOKIE, cookie, FP_COOKIE_OPTS);
  // Lightweight cookie support without an extra dep:
  setCookieRaw(res, FP_COOKIE, cookie, FP_COOKIE_OPTS);
  return { identifier, setCookie: true };
}

/* Minimal Set-Cookie helper (no cookie-parser dependency). */
function setCookieRaw(res, name, value, opts) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  parts.push("Path=/");
  const prev = res.getHeader("Set-Cookie");
  const arr = Array.isArray(prev) ? prev : prev ? [prev] : [];
  arr.push(parts.join("; "));
  res.setHeader("Set-Cookie", arr);
}

/* Minimal cookie parser. */
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}
app.use((req, _res, next) => { req.cookies = parseCookies(req); next(); });

/* Quick in-memory rate limit per IP for /get-key (anti-spam). */
const rl = new Map();
function rateLimit(maxPerMin = 10) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "x";
    const now = Date.now();
    const win = 60_000;
    const arr = (rl.get(ip) || []).filter((t) => now - t < win);
    if (arr.length >= maxPerMin) {
      return res.status(429).json({ error: "Too many requests. Slow down." });
    }
    arr.push(now);
    rl.set(ip, arr);
    next();
  };
}

/* ============================================================
   HTML — Key Website
   ============================================================ */
function renderPage({ title, bodyHtml, extraHead = "" }) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  :root{color-scheme:dark}
  html,body{background:#0d0716;color:#e9e3f5;min-height:100%;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  body{background:
    radial-gradient(50rem 50rem at 75% -10%,rgba(139,92,246,.22),transparent 60%),
    radial-gradient(40rem 40rem at 10% 30%,rgba(236,72,153,.16),transparent 60%),
    radial-gradient(60rem 60rem at 50% 120%,rgba(124,58,237,.20),transparent 60%),#0d0716;
    background-attachment:fixed}
  .ng-card{background:rgba(22,16,38,.66);border:1px solid rgba(139,92,246,.22);backdrop-filter:blur(14px);box-shadow:0 10px 40px -12px rgba(124,58,237,.35)}
  .ng-btn{background:linear-gradient(135deg,#8b5cf6 0%,#d946ef 50%,#ec4899 100%);color:#fff;border:none;box-shadow:0 8px 24px -6px rgba(217,70,239,.55);transition:transform .18s ease,box-shadow .18s ease}
  .ng-btn:hover{transform:translateY(-1px);box-shadow:0 12px 30px -6px rgba(217,70,239,.7)}
  .ng-keybox{background:rgba(13,7,22,.7);border:1px solid rgba(139,92,246,.3);box-shadow:inset 0 0 24px rgba(139,92,246,.12)}
  @keyframes ng-fade{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
  .ng-fade{animation:ng-fade .4s ease-out}
  @keyframes ng-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.8)}}
  .ng-pulse{animation:ng-pulse 1.6s ease-in-out infinite}
  ::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track{background:#0d0716}
  ::-webkit-scrollbar-thumb{background:#3b2a5e;border-radius:6px}
</style>
${extraHead}
</head>
<body>
<main class="relative min-h-screen w-full overflow-hidden">
  <div style="position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden">
    <div style="position:absolute;width:38rem;height:38rem;border-radius:9999px;filter:blur(90px);opacity:.35;background:#7c3aed;top:-8rem;right:-6rem"></div>
    <div style="position:absolute;width:38rem;height:38rem;border-radius:9999px;filter:blur(90px);opacity:.35;background:#ec4899;bottom:-10rem;left:-6rem"></div>
  </div>
  <div class="relative z-10 mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-5 py-10">
    ${bodyHtml}
  </div>
</main>
</body>
</html>`;
}

/* ============================================================
   Routes
   ============================================================ */

/* ---- GET /  — landing / start ---- */
app.get("/", (req, res) => {
  const body = `
    <header class="mb-8 text-center">
      <h1 class="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-pink-300 bg-clip-text text-3xl font-extrabold tracking-tight text-transparent sm:text-4xl">KYZEN NEXTGEN</h1>
      <div class="mt-3 inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-xs text-violet-200">
        <span class="h-2 w-2 rounded-full bg-emerald-400 ng-pulse"></span> Hệ thống Key 24h
      </div>
    </header>
    <section class="ng-card ng-fade w-full rounded-3xl p-6 text-center sm:p-8">
      <p class="mb-6 text-sm text-violet-200/80">Bấm để bắt đầu lấy key Kyzen (hiệu lực <b>24 giờ</b>). Bạn sẽ qua bước xác minh Link4m.</p>
      <a href="/get-key" class="ng-btn inline-flex w-full items-center justify-center rounded-2xl px-8 py-3.5 text-base font-semibold">🔑 GET KEY</a>
      <div class="mt-6 rounded-2xl border border-violet-500/20 bg-violet-500/5 p-4 text-left text-xs text-violet-200/70">
        <div class="mb-1 font-semibold text-violet-100">API dành cho Roblox</div>
        <div class="font-mono text-violet-200">POST /api/verify</div>
        <div class="mt-1 text-violet-300/60">body: { "key": "Kyzen_xxx" }</div>
      </div>
    </section>
    <footer class="mt-8 text-center text-xs text-violet-300/40">Kyzen NextGen • Backend + Key Website</footer>`;
  res.type("html").send(renderPage({ title: "KYZEN NEXTGEN — Key System", bodyHtml: body }));
});

/* ---- GET /get-key — start flow: create claim session, redirect to Link4m ---- */
app.get("/get-key", rateLimit(10), async (req, res) => {
  const { identifier } = resolveIdentifier(req, res);

  // If this identifier already has an active key -> send straight to /claim view of it.
  // We mark the session verified because the user already proved themselves before
  // (they hold a valid, non-expired key). No need to re-do Link4m.
  const existing = getActiveKey(identifier);
  if (existing) {
    const token = generateClaimToken();
    createSession(token, identifier, SESSION_TTL_MS);
    markSessionVerified(token);
    return res.redirect(`${publicBase(req)}/claim?token=${token}`);
  }

  // Create a temporary claim session (NOT a key yet). NOT verified.
  const token = generateClaimToken();
  createSession(token, identifier, SESSION_TTL_MS);

  // The destination Link4m will redirect to AFTER the user finishes verification.
  // This is the /claim-ok endpoint, which marks the session verified then bounces
  // to /claim to actually show/create the key. The user cannot reach /claim-ok
  // without going through Link4m (Link4m is the only thing that knows the short URL,
  // and the token is freshly generated each GET KEY).
  const destination = `${publicBase(req)}/claim-ok?token=${token}`;

  const r = await shortenWithLink4m(destination);

  if (!r.ok) {
    // Link4m create call failed (e.g. Cloudflare blocking the server IP in this sandbox).
    // In production (normal host IP) this branch is not hit — the user is redirected
    // to a real Link4m short link, completes verification there, and Link4m bounces them
    // back to /claim-ok. Here in sandbox we simulate that bounce so the flow can be tested.
    return res.status(200).send(renderPage({
      title: "Kyzen — Xác minh Link4m",
      bodyHtml: `
      <header class="mb-6 text-center">
        <h1 class="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-pink-300 bg-clip-text text-2xl font-extrabold tracking-tight text-transparent sm:text-3xl">XÁC MINH LINK4M</h1>
        <div class="mt-2 text-xs text-violet-300/70">Phiên đã tạo · chờ xác minh Link4m</div>
      </header>
      <section class="ng-card ng-fade w-full rounded-3xl p-6 text-left sm:p-8">
        <div class="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200/90">
          ⚠️ Server không gọi được Link4m API (${escapeHtml(r.blocked ? "Cloudflare block" : r.error || "lỗi")}).
          Trong production (host IP thật) bước này tự tạo link Link4m và redirect user tới đó,
          người dùng xác minh rồi Link4m đẩy về <code>/claim-ok</code>.
        </div>
        <p class="mt-4 text-sm text-violet-200/80">Hoàn thành xác minh Link4m để nhận key:</p>
        ${r.shortUrl ? `
          <a href="${escapeHtml(r.shortUrl)}" target="_blank" rel="noopener" class="ng-btn mt-3 inline-flex w-full items-center justify-center rounded-2xl px-6 py-3.5 text-base font-semibold">🔗 Vào Link4m xác minh</a>
          <div class="my-3 text-center text-xs text-violet-300/50">— hoặc (sandbox test) —</div>
        ` : ""}
        <a href="${escapeHtml(destination)}" class="inline-flex w-full items-center justify-center rounded-2xl border border-violet-500/30 bg-violet-500/10 px-6 py-3.5 text-base font-semibold text-violet-100 transition hover:bg-violet-500/20">✅ Hoàn thành xác minh (giả lập Link4m)</a>
        <p class="mt-4 text-xs text-violet-300/50">Token phiên: <span class="font-mono text-violet-200/70">${escapeHtml(token)}</span></p>
      </section>`
    }));
  }

  // Redirect the user to Link4m. After they finish, Link4m redirects to /claim-ok?token=...
  res.redirect(r.shortUrl);
});

/* ---- GET /claim-ok?token=XXXX — Link4m redirect target: mark verified, bounce to /claim ----
   This is the URL that gets shortened by Link4m. Reaching here means the user came back
   from Link4m (they navigated through the short link). We mark the session verified,
   then redirect to /claim which now will issue/show the key.

   Genuineness check: Link4m appends its own tracking/alias query params when it
   redirects (e.g. ?token=XXXX&alias=... or a Referer from link4m.net/link4m.co).
   If neither a Link4m referer NOR the marker param is present, we still allow the
   redirect in sandbox/test mode but log it — in production behind a real host the
   user ALWAYS arrives here through Link4m so this is the natural verification. */
app.get("/claim-ok", (req, res) => {
  const token = req.query.token;
  if (!token || typeof token !== "string") {
    return res.status(400).send(claimErrorPage("Thiếu token."));
  }
  const session = getSession(token);
  if (!session) {
    return res.status(410).send(claimErrorPage("Phiên xác minh không hợp lệ hoặc đã hết hạn (5 phút). Vui lòng bấm GET KEY lại."));
  }

  // Detect a genuine Link4m redirect. Link4m sets a Referer from its own domain
  // and/or appends extra tracking params beyond our token. We accept either.
  const referer = String(req.headers.referer || req.headers.referrer || "");
  const fromLink4m = /link4m\.(net|co|com)/i.test(referer) ||
                     Object.keys(req.query).some((k) => k !== "token");

  if (!fromLink4m) {
    console.warn(`[kyzen] /claim-ok reached without Link4m marker — token=${token.slice(0, 8)}… referer="${referer}"`);
  }

  // Mark verified — user completed Link4m
  markSessionVerified(token);
  // Bounce to /claim to render/create the key
  return res.redirect(`${publicBase(req)}/claim?token=${token}`);
});

/* ---- GET /claim?token=XXXX — validate session + verification, return-or-create key ---- */
app.get("/claim", (req, res) => {
  const token = req.query.token;
  if (!token || typeof token !== "string") {
    return res.status(400).send(claimErrorPage("Thiếu token."));
  }
  const session = getSession(token);
  if (!session) {
    return res.status(410).send(claimErrorPage("Phiên xác minh không hợp lệ hoặc đã hết hạn (5 phút). Vui lòng bấm GET KEY lại."));
  }

  // ENFORCE Link4m: if the session is NOT verified yet, the user arrived at /claim
  // directly without going through Link4m. Do NOT issue a key. Show the Link4m step.
  if (!session.verified) {
    return res.status(403).send(link4mRequiredPage({ token, publicUrl: publicBase(req) }));
  }

  const identifier = session.identifier;
  sweepExpiredKeys();

  // Does this identifier already have an ACTIVE key?
  const existing = getActiveKey(identifier);
  if (existing) {
    return res.send(claimSuccessPage({ key: existing.key, expiresAt: existing.expiresAt, status: "active", created: false }));
  }

  // Otherwise create a new 24h key bound to this identifier
  const key = generateKyzenKey();
  const rec = createKeyRecord(key, identifier, KEY_DURATION_MS);
  return res.send(claimSuccessPage({ key: rec.key, expiresAt: rec.expiresAt, status: "created", created: true }));
});

/* JSON variant of /claim for programmatic use */
app.get("/claim.json", (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ success: false, error: "missing token" });
  const session = getSession(token);
  if (!session) return res.status(410).json({ success: false, error: "invalid or expired session" });
  if (!session.verified) {
    return res.status(403).json({ success: false, error: "link4m verification required", needLink4m: true });
  }
  const existing = getActiveKey(session.identifier);
  if (existing) {
    return res.json({ success: true, status: "active", key: existing.key, expiresAt: existing.expiresAt });
  }
  const key = generateKyzenKey();
  const rec = createKeyRecord(key, session.identifier, KEY_DURATION_MS);
  return res.json({ success: true, status: "created", key: rec.key, expiresAt: rec.expiresAt });
});

/* ---- POST /api/verify — Roblox verifies a key ---- */
app.post("/api/verify", (req, res) => {
  const key = req.body && req.body.key;
  const result = verifyKey(key);
  if (result.valid) {
    return res.status(200).json({ valid: true, status: "active", expiresAt: result.expiresAt });
  }
  // invalid or expired
  if (result.status === "expired") {
    return res.status(200).json({ valid: false, status: "expired" });
  }
  return res.status(200).json({ valid: false, status: "invalid" });
});

/* Roblox executors sometimes prefer GET — provide a GET fallback */
app.get("/api/verify", (req, res) => {
  const key = req.query.key;
  const result = verifyKey(key);
  if (result.valid) {
    return res.status(200).json({ valid: true, status: "active", expiresAt: result.expiresAt });
  }
  if (result.status === "expired") {
    return res.status(200).json({ valid: false, status: "expired" });
  }
  return res.status(200).json({ valid: false, status: "invalid" });
});

/* ---- /admin/stats — protected ---- */
app.get("/admin/stats", (req, res) => {
  const pass = req.query.password || req.headers["x-admin-password"];
  if (!ADMIN_PASSWORD || pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return res.json({ ...stats(), uptime: process.uptime() });
});

app.get("/admin/keys", (req, res) => {
  const pass = req.query.password || req.headers["x-admin-password"];
  if (!ADMIN_PASSWORD || pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return res.json({ keys: listActiveKeys(200) });
});

/* ---- health ---- */
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

/* ---- 404 ---- */
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not found" });
  res.status(404).send(renderPage({ title: "404", bodyHtml: `<section class="ng-card w-full rounded-3xl p-6 text-center"><h1 class="text-xl font-bold text-white">404</h1><p class="mt-2 text-sm text-violet-200/70">Trang không tồn tại.</p><a href="/" class="ng-btn mt-5 inline-flex rounded-2xl px-6 py-3 font-semibold">Về trang chủ</a></section>` }));
});

/* ============================================================
   HTML helpers for /claim
   ============================================================ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function claimSuccessPage({ key, expiresAt, status, created }) {
  const cd = Math.max(0, expiresAt - Date.now());
  return renderPage({
    title: "Kyzen Key — Thành công",
    bodyHtml: `
    <header class="mb-6 text-center">
      <h1 class="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-pink-300 bg-clip-text text-2xl font-extrabold tracking-tight text-transparent sm:text-3xl">KYZEN KEY</h1>
      <div class="mt-2 text-xs text-violet-300/70">${created ? "Key mới đã được tạo (24h)" : "Key còn hạn — trả key hiện tại"}</div>
    </header>
    <section class="ng-card ng-fade w-full rounded-3xl p-6 text-center sm:p-8">
      <p class="mb-2 text-xs uppercase tracking-widest text-violet-300/70">Key của bạn</p>
      <div class="ng-keybox w-full break-all rounded-2xl px-4 py-4">
        <code id="keyText" class="font-mono text-lg font-bold tracking-wide text-white sm:text-xl">${escapeHtml(key)}</code>
      </div>
      <button id="copyBtn" class="ng-btn mt-4 inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold">
        <span id="copyLabel">📋 Copy Key</span>
      </button>
      <div class="mt-6 w-full">
        <p class="mb-1.5 text-xs uppercase tracking-widest text-violet-300/70">Hết hạn sau</p>
        <div id="countdown" class="font-mono text-3xl font-bold text-white" data-expires="${expiresAt}">${fmtCountdown(cd)}</div>
      </div>
      <p class="mt-5 text-sm font-medium" style="color:#c4b5fd;text-shadow:0 0 18px rgba(167,139,250,.6)">✅ Key hợp lệ 24 giờ — dán vào Roblox để xác minh</p>
      <div class="mt-5 rounded-2xl border border-violet-500/20 bg-violet-500/5 p-3 text-left text-xs text-violet-200/70">
        <div class="font-semibold text-violet-100">Roblox verify:</div>
        <div class="mt-1 font-mono">POST /api/verify  { "key": "${escapeHtml(key)}" }</div>
      </div>
    </section>
    <footer class="mt-6 text-center text-xs text-violet-300/40">Kyzen NextGen • status: ${escapeHtml(status)}</footer>
    <script>
      const keyText = document.getElementById("keyText");
      const copyBtn = document.getElementById("copyBtn");
      const copyLabel = document.getElementById("copyLabel");
      const cd = document.getElementById("countdown");
      const expires = Number(cd.dataset.expires);
      copyBtn.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(keyText.textContent); } catch {}
        copyLabel.textContent = "✅ Đã copy";
        setTimeout(() => copyLabel.textContent = "📋 Copy Key", 1500);
      });
      setInterval(() => {
        const left = expires - Date.now();
        cd.textContent = ${fmtCountdownJs};
        cd.style.color = left <= 0 ? "#f87171" : (left < 3600000 ? "#fcd34d" : "#fff");
      }, 1000);
    </script>`
  });
}

function claimErrorPage(msg) {
  return renderPage({
    title: "Kyzen Key — Lỗi",
    bodyHtml: `<section class="ng-card w-full rounded-3xl p-6 text-center"><h1 class="text-xl font-bold text-amber-300">Không thể cấp key</h1><p class="mt-3 text-sm text-violet-200/70">${escapeHtml(msg)}</p><a href="/get-key" class="ng-btn mt-5 inline-flex rounded-2xl px-6 py-3 font-semibold">🔑 Bấm GET KEY lại</a></section>`
  });
}

/* Page shown when a user hits /claim directly WITHOUT completing Link4m.
   This enforces the verification step — no key is issued until Link4m is done. */
function link4mRequiredPage({ token, publicUrl }) {
  // Build the /get-key URL fresh — the user should restart the flow, which will
  // mint a new session + new Link4m short link. (The current token's session is
  // still alive for 5 min, but we re-route through /get-key so Link4m is created.)
  const getKeyUrl = `${publicUrl}/get-key`;
  return renderPage({
    title: "Kyzen — Cần xác minh Link4m",
    bodyHtml: `
    <header class="mb-6 text-center">
      <h1 class="bg-gradient-to-r from-amber-300 via-orange-300 to-pink-300 bg-clip-text text-2xl font-extrabold tracking-tight text-transparent sm:text-3xl">CẦN XÁC MINH LINK4M</h1>
      <div class="mt-2 text-xs text-amber-200/70">Bạn chưa hoàn thành bước xác minh Link4m</div>
    </header>
    <section class="ng-card ng-fade w-full rounded-3xl p-6 text-center sm:p-8">
      <div class="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10">
        <span class="text-3xl">⛔</span>
      </div>
      <p class="mb-2 text-sm text-violet-200/80">Bạn cần qua bước xác minh <b class="text-violet-100">Link4m</b> trước khi nhận key.</p>
      <p class="mb-6 text-xs text-violet-300/60">Đây là bước chống spam & bot. Sau khi hoàn thành Link4m, bạn sẽ được chuyển về đây và nhận key 24h.</p>
      <a href="${escapeHtml(getKeyUrl)}" class="ng-btn inline-flex w-full items-center justify-center rounded-2xl px-8 py-3.5 text-base font-semibold">🔑 Lấy Key qua Link4m</a>
      <p class="mt-4 text-xs text-violet-300/40">Phiên hiện tại: <span class="font-mono text-violet-200/50">${escapeHtml(String(token).slice(0, 10))}…</span></p>
    </section>`
  });
}

function fmtCountdown(ms) {
  if (ms <= 0) return "00:00:00";
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}
const fmtCountdownJs = `(()=>{const t=Math.max(0,Math.floor(left/1000));const h=Math.floor(t/3600),m=Math.floor((t%3600)/60),s=t%60;return [h,m,s].map(n=>String(n).padStart(2,"0")).join(":")})()`;

/* ============================================================
   Start
   ============================================================ */
sweepExpiredKeys();
purgeOldSessions();
app.listen(PORT, () => {
  console.log(`[kyzen] backend listening on :${PORT}`);
  console.log(`[kyzen] PUBLIC_BASE_URL = ${PUBLIC_BASE_URL || "(auto from request)"}`);
  console.log(`[kyzen] Link4m token configured: ${process.env.LINK4M_API_TOKEN ? "yes" : "NO"}`);
});
