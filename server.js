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
  getPendingSessionByIdentifier,
  getVerifiedSessionByIdentifier,
  markSessionVerified,
  deleteSession,
  stats,
  listActiveKeys,
} from "./db.js";

import {
  identifierFromFingerprint,
  newFingerprint,
  generateKyzenKey,
} from "./crypto.js";

/* ============================================================
   Kyzen NextGen — Backend server
   Fixed Link4m edition

   FLOW:

   GET /get-key
      ↓
   kz_fp → identifier
      ↓
   Create PENDING session (10 min)
      ↓
   Redirect → LINK4M_FIXED_URL
      ↓
   User completes Link4m
      ↓
   Link4m redirects → /claim-ok
      ↓
   kz_fp → identifier
      ↓
   Find PENDING session
      ↓
   PENDING → VERIFIED
      ↓
   Redirect → /claim
      ↓
   VERIFIED session
      ↓
   Create / return 24h key

   IMPORTANT:
   - No claim token in URL.
   - No Link4m API call per user.
   - One fixed Link4m short URL.
   - Link4m API token is NOT required by this server flow.
   ============================================================ */

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ============================================================
   CONFIG
   ============================================================ */

const PORT = Number(process.env.PORT) || 8080;

const PUBLIC_BASE_URL =
  (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "";

const LINK4M_FIXED_URL =
  (process.env.LINK4M_FIXED_URL || "").trim();

const KEY_DURATION_MS =
  24 * 60 * 60 * 1000; // 24h

const SESSION_TTL_MS =
  10 * 60 * 1000; // 10 minutes

const FP_COOKIE =
  "kz_fp";

const FP_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: true,
  maxAge: 365 * 24 * 60 * 60 * 1000,
};

/* ============================================================
   PUBLIC BASE URL
   ============================================================ */

function publicBase(req) {
  if (PUBLIC_BASE_URL) {
    return PUBLIC_BASE_URL;
  }

  const proto =
    req.headers["x-forwarded-proto"] ||
    req.protocol ||
    "http";

  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host ||
    "localhost";

  return `${proto}://${host}`;
}

/* ============================================================
   COOKIE / IDENTIFIER
   ============================================================ */

function resolveIdentifier(req, res) {
  const fp =
    req.cookies
      ? req.cookies[FP_COOKIE]
      : null;

  const id =
    identifierFromFingerprint(fp);

  if (id) {
    return {
      identifier: id,
      setCookie: false,
    };
  }

  const {
    cookie,
    identifier,
  } = newFingerprint();

  setCookieRaw(
    res,
    FP_COOKIE,
    cookie,
    FP_COOKIE_OPTS
  );

  return {
    identifier,
    setCookie: true,
  };
}

/* ============================================================
   SET COOKIE
   ============================================================ */

function setCookieRaw(
  res,
  name,
  value,
  opts
) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
  ];

  if (opts.maxAge) {
    parts.push(
      `Max-Age=${Math.floor(opts.maxAge / 1000)}`
    );
  }

  if (opts.httpOnly) {
    parts.push("HttpOnly");
  }

  if (opts.sameSite) {
    parts.push(`SameSite=${opts.sameSite}`);
  }

  if (opts.secure) {
    parts.push("Secure");
  }

  parts.push("Path=/");

  const prev =
    res.getHeader("Set-Cookie");

  const arr =
    Array.isArray(prev)
      ? prev
      : prev
        ? [prev]
        : [];

  arr.push(parts.join("; "));

  res.setHeader(
    "Set-Cookie",
    arr
  );
}

/* ============================================================
   COOKIE PARSER
   ============================================================ */

function parseCookies(req) {
  const header =
    req.headers.cookie;

  const out = {};

  if (!header) {
    return out;
  }

  for (const part of header.split(";")) {
    const idx =
      part.indexOf("=");

    if (idx < 0) {
      continue;
    }

    const key =
      part.slice(0, idx).trim();

    const value =
      part.slice(idx + 1).trim();

    try {
      out[key] =
        decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }

  return out;
}

app.use((req, _res, next) => {
  req.cookies =
    parseCookies(req);

  next();
});

/* ============================================================
   RATE LIMIT
   ============================================================ */

const rl = new Map();

function rateLimit(
  maxPerMin = 10
) {
  return (req, res, next) => {
    const ip =
      req.ip ||
      req.socket.remoteAddress ||
      "x";

    const now =
      Date.now();

    const win =
      60_000;

    const arr =
      (rl.get(ip) || [])
        .filter(
          (t) =>
            now - t < win
        );

    if (
      arr.length >= maxPerMin
    ) {
      return res
        .status(429)
        .json({
          error:
            "Too many requests. Slow down.",
        });
    }

    arr.push(now);

    rl.set(ip, arr);

    next();
  };
}

/* ============================================================
   HTML PAGE
   ============================================================ */

function renderPage({
  title,
  bodyHtml,
  extraHead = "",
}) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>

<script src="https://cdn.tailwindcss.com"></script>

<style>
  :root{color-scheme:dark}

  html,body{
    background:#0d0716;
    color:#e9e3f5;
    min-height:100%;
    font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif
  }

  body{
    background:
      radial-gradient(
        50rem 50rem at 75% -10%,
        rgba(139,92,246,.22),
        transparent 60%
      ),
      radial-gradient(
        40rem 40rem at 10% 30%,
        rgba(236,72,153,.16),
        transparent 60%
      ),
      radial-gradient(
        60rem 60rem at 50% 120%,
        rgba(124,58,237,.20),
        transparent 60%
      ),
      #0d0716;

    background-attachment:fixed
  }

  .ng-card{
    background:rgba(22,16,38,.66);
    border:1px solid rgba(139,92,246,.22);
    backdrop-filter:blur(14px);
    box-shadow:
      0 10px 40px -12px
      rgba(124,58,237,.35)
  }

  .ng-btn{
    background:
      linear-gradient(
        135deg,
        #8b5cf6 0%,
        #d946ef 50%,
        #ec4899 100%
      );

    color:#fff;
    border:none;

    box-shadow:
      0 8px 24px -6px
      rgba(217,70,239,.55);

    transition:
      transform .18s ease,
      box-shadow .18s ease
  }

  .ng-btn:hover{
    transform:translateY(-1px);

    box-shadow:
      0 12px 30px -6px
      rgba(217,70,239,.7)
  }

  .ng-keybox{
    background:rgba(13,7,22,.7);
    border:1px solid rgba(139,92,246,.3);

    box-shadow:
      inset 0 0 24px
      rgba(139,92,246,.12)
  }

  @keyframes ng-fade{
    from{
      opacity:0;
      transform:translateY(10px)
    }

    to{
      opacity:1;
      transform:translateY(0)
    }
  }

  .ng-fade{
    animation:ng-fade .4s ease-out
  }

  @keyframes ng-pulse{
    0%,100%{
      opacity:1;
      transform:scale(1)
    }

    50%{
      opacity:.45;
      transform:scale(.8)
    }
  }

  .ng-pulse{
    animation:ng-pulse 1.6s ease-in-out infinite
  }

  ::-webkit-scrollbar{
    width:10px;
    height:10px
  }

  ::-webkit-scrollbar-track{
    background:#0d0716
  }

  ::-webkit-scrollbar-thumb{
    background:#3b2a5e;
    border-radius:6px
  }
</style>

${extraHead}

</head>

<body>

<main class="relative min-h-screen w-full overflow-hidden">

  <div
    style="
      position:fixed;
      inset:0;
      z-index:0;
      pointer-events:none;
      overflow:hidden
    "
  >

    <div
      style="
        position:absolute;
        width:38rem;
        height:38rem;
        border-radius:9999px;
        filter:blur(90px);
        opacity:.35;
        background:#7c3aed;
        top:-8rem;
        right:-6rem
      "
    ></div>

    <div
      style="
        position:absolute;
        width:38rem;
        height:38rem;
        border-radius:9999px;
        filter:blur(90px);
        opacity:.35;
        background:#ec4899;
        bottom:-10rem;
        left:-6rem
      "
    ></div>

  </div>

  <div
    class="relative z-10 mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-5 py-10"
  >
    ${bodyHtml}
  </div>

</main>

</body>
</html>`;
}

/* ============================================================
   GET /
   ============================================================ */

app.get("/", (req, res) => {
  const body = `
    <header class="mb-8 text-center">

      <h1
        class="
          bg-gradient-to-r
          from-violet-300
          via-fuchsia-300
          to-pink-300
          bg-clip-text
          text-3xl
          font-extrabold
          tracking-tight
          text-transparent
          sm:text-4xl
        "
      >
        KYZEN NEXTGEN
      </h1>

      <div
        class="
          mt-3
          inline-flex
          items-center
          gap-2
          rounded-full
          border
          border-violet-500/30
          bg-violet-500/10
          px-3
          py-1
          text-xs
          text-violet-200
        "
      >
        <span
          class="h-2 w-2 rounded-full bg-emerald-400 ng-pulse"
        ></span>

        Hệ thống Key 24h
      </div>

    </header>

    <section
      class="
        ng-card
        ng-fade
        w-full
        rounded-3xl
        p-6
        text-center
        sm:p-8
      "
    >

      <p
        class="
          mb-6
          text-sm
          text-violet-200/80
        "
      >
        Bấm để bắt đầu lấy key Kyzen
        (hiệu lực <b>24 giờ</b>).
        Bạn sẽ qua bước xác minh Link4m.
      </p>

      <a
        href="/get-key"
        class="
          ng-btn
          inline-flex
          w-full
          items-center
          justify-center
          rounded-2xl
          px-8
          py-3.5
          text-base
          font-semibold
        "
      >
        🔑 GET KEY
      </a>

      <div
        class="
          mt-6
          rounded-2xl
          border
          border-violet-500/20
          bg-violet-500/5
          p-4
          text-left
          text-xs
          text-violet-200/70
        "
      >
        <div
          class="mb-1 font-semibold text-violet-100"
        >
          API dành cho Roblox
        </div>

        <div
          class="font-mono text-violet-200"
        >
          POST /api/verify
        </div>

        <div
          class="mt-1 text-violet-300/60"
        >
          body:
          { "key": "Kyzen_xxx" }
        </div>
      </div>

    </section>

    <footer
      class="
        mt-8
        text-center
        text-xs
        text-violet-300/40
      "
    >
      Kyzen NextGen • Backend + Key Website
    </footer>
  `;

  res
    .type("html")
    .send(
      renderPage({
        title:
          "KYZEN NEXTGEN — Key System",
        bodyHtml: body,
      })
    );
});

/* ============================================================
   GET /get-key

   NEW FIXED LINK4M FLOW

   User
     ↓
   kz_fp
     ↓
   identifier
     ↓
   PENDING 10 minutes
     ↓
   fixed Link4m URL
   ============================================================ */

app.get(
  "/get-key",
  rateLimit(10),
  (req, res) => {
    const { identifier } = resolveIdentifier(req, res);

    purgeOldSessions();

    const existing = getActiveKey(identifier);

    if (existing) {
      return res.redirect(
        `${publicBase(req)}/claim`
      );
    }

    if (!LINK4M_FIXED_URL) {
      console.error(
        "[kyzen] LINK4M_FIXED_URL is not configured."
      );

      return res
        .status(500)
        .send(
          claimErrorPage(
            "LINK4M_FIXED_URL chưa được cấu hình trên Railway."
          )
        );
    }

    const pending =
      getPendingSessionByIdentifier(identifier);

    if (!pending) {
      const sessionId = generateClaimToken();

      createSession(
        sessionId,
        identifier,
        SESSION_TTL_MS
      );

      console.log(
        `[kyzen] PENDING created identifier=${identifier.slice(0, 8)}…`
      );
    }

    return res.redirect(LINK4M_FIXED_URL);
  }
);
/* ============================================================
   Generate session ID locally.

   We don't expose this ID in the URL.
   ============================================================ */

function cryptoRandomSessionId() {
  const bytes =
    new Uint8Array(24);

  /*
   * Node crypto is already used by
   * crypto.js, but we intentionally
   * avoid changing crypto.js.
   *
   * Use randomUUID-style timestamp
   * + random process data.
   */
  return (
    `${Date.now().toString(36)}-` +
    Math.random()
      .toString(36)
      .slice(2) +
    "-" +
    Math.random()
      .toString(36)
      .slice(2) +
    "-" +
    Array.from(bytes)
      .map(() =>
        Math.floor(
          Math.random() * 16
        ).toString(16)
      )
      .join("")
  );
}

/* ============================================================
   GET /claim-ok

   Link4m fixed destination:
   https://kyzennextgen-production.up.railway.app/claim-ok

   Browser sends kz_fp automatically.

   identifier
       ↓
   pending session
       ↓
   verified
       ↓
   /claim

   NOTE:
   This endpoint relies on the Link4m
   fixed redirect flow. If Link4m provides
   a signed callback in the future, that
   can be added here for stronger proof.
   ============================================================ */

app.get(
  "/claim-ok",
  (req, res) => {
    const {
      identifier,
    } = resolveIdentifier(
      req,
      res
    );

    const pending =
      getPendingSessionByIdentifier(
        identifier
      );

    if (!pending) {
      console.warn(
        `[kyzen] /claim-ok without pending session identifier=${identifier.slice(0, 8)}…`
      );

      return res
        .status(403)
        .send(
          claimErrorPage(
            "Chưa có phiên GET KEY hợp lệ hoặc phiên đã hết hạn. Vui lòng bấm GET KEY lại."
          )
        );
    }

    /*
     * Mark the pending session
     * as completed.
     */
    markSessionVerified(
      pending.id
    );

    console.log(
      `[kyzen] VERIFIED identifier=${identifier.slice(0, 8)}…`
    );

    return res.redirect(
      `${publicBase(req)}/claim`
    );
  }
);

/* ============================================================
   GET /claim

   NO TOKEN.

   Browser identity = kz_fp
   ============================================================ */

app.get(
  "/claim",
  (req, res) => {
    const {
      identifier,
    } = resolveIdentifier(
      req,
      res
    );

    sweepExpiredKeys();
    purgeOldSessions();

    /*
     * If this browser already has
     * an active key, simply return it.
     *
     * This preserves the original
     * "refresh doesn't generate new key"
     * behavior.
     */
    const existing =
      getActiveKey(identifier);

    if (existing) {
      return res.send(
        claimSuccessPage({
          key: existing.key,
          expiresAt:
            existing.expiresAt,
          status: "active",
          created: false,
        })
      );
    }

    /*
     * New key requires a VERIFIED
     * Link4m session.
     */
    const verified =
      getVerifiedSessionByIdentifier(
        identifier
      );

    if (!verified) {
      return res
        .status(403)
        .send(
          link4mRequiredPage({
            publicUrl:
              publicBase(req),
          })
        );
    }

    /*
     * Create new 24h key.
     */
    const key =
      generateKyzenKey();

    const rec =
      createKeyRecord(
        key,
        identifier,
        KEY_DURATION_MS
      );

    /*
     * Consume the verification
     * session after successful claim.
     */
    deleteSession(
      verified.id
    );

    console.log(
      `[kyzen] KEY CREATED identifier=${identifier.slice(0, 8)}…`
    );

    return res.send(
      claimSuccessPage({
        key: rec.key,
        expiresAt:
          rec.expiresAt,
        status: "created",
        created: true,
      })
    );
  }
);

/* ============================================================
   GET /claim.json
   ============================================================ */

app.get(
  "/claim.json",
  (req, res) => {
    const {
      identifier,
    } = resolveIdentifier(
      req,
      res
    );

    sweepExpiredKeys();
    purgeOldSessions();

    /*
     * Existing active key.
     */
    const existing =
      getActiveKey(identifier);

    if (existing) {
      return res.json({
        success: true,
        status: "active",
        key: existing.key,
        expiresAt:
          existing.expiresAt,
      });
    }

    /*
     * New key requires verification.
     */
    const verified =
      getVerifiedSessionByIdentifier(
        identifier
      );

    if (!verified) {
      return res
        .status(403)
        .json({
          success: false,
          error:
            "link4m verification required",
          needLink4m: true,
        });
    }

    const key =
      generateKyzenKey();

    const rec =
      createKeyRecord(
        key,
        identifier,
        KEY_DURATION_MS
      );

    deleteSession(
      verified.id
    );

    return res.json({
      success: true,
      status: "created",
      key: rec.key,
      expiresAt:
        rec.expiresAt,
    });
  }
);

/* ============================================================
   POST /api/verify
   ============================================================ */

app.post(
  "/api/verify",
  (req, res) => {
    const key =
      req.body &&
      req.body.key;

    const result =
      verifyKey(key);

    if (result.valid) {
      return res
        .status(200)
        .json({
          valid: true,
          status: "active",
          expiresAt:
            result.expiresAt,
        });
    }

    if (
      result.status ===
      "expired"
    ) {
      return res
        .status(200)
        .json({
          valid: false,
          status: "expired",
        });
    }

    return res
      .status(200)
      .json({
        valid: false,
        status: "invalid",
      });
  }
);

/* ============================================================
   GET /api/verify
   ============================================================ */

app.get(
  "/api/verify",
  (req, res) => {
    const key =
      req.query.key;

    const result =
      verifyKey(key);

    if (result.valid) {
      return res
        .status(200)
        .json({
          valid: true,
          status: "active",
          expiresAt:
            result.expiresAt,
        });
    }

    if (
      result.status ===
      "expired"
    ) {
      return res
        .status(200)
        .json({
          valid: false,
          status: "expired",
        });
    }

    return res
      .status(200)
      .json({
        valid: false,
        status: "invalid",
      });
  }
);

/* ============================================================
   ADMIN STATS
   ============================================================ */

app.get(
  "/admin/stats",
  (req, res) => {
    const pass =
      req.query.password ||
      req.headers[
        "x-admin-password"
      ];

    if (
      !ADMIN_PASSWORD ||
      pass !== ADMIN_PASSWORD
    ) {
      return res
        .status(401)
        .json({
          error:
            "unauthorized",
        });
    }

    return res.json({
      ...stats(),
      uptime:
        process.uptime(),
    });
  }
);

/* ============================================================
   ADMIN KEYS
   ============================================================ */

app.get(
  "/admin/keys",
  (req, res) => {
    const pass =
      req.query.password ||
      req.headers[
        "x-admin-password"
      ];

    if (
      !ADMIN_PASSWORD ||
      pass !== ADMIN_PASSWORD
    ) {
      return res
        .status(401)
        .json({
          error:
            "unauthorized",
        });
    }

    return res.json({
      keys:
        listActiveKeys(200),
    });
  }
);

/* ============================================================
   HEALTH
   ============================================================ */

app.get(
  "/health",
  (_req, res) =>
    res.json({
      ok: true,
      time: Date.now(),
    })
);

/* ============================================================
   404
   ============================================================ */

app.use(
  (req, res) => {
    if (
      req.path.startsWith(
        "/api/"
      )
    ) {
      return res
        .status(404)
        .json({
          error:
            "not found",
        });
    }

    res
      .status(404)
      .send(
        renderPage({
          title: "404",
          bodyHtml: `
            <section
              class="
                ng-card
                w-full
                rounded-3xl
                p-6
                text-center
              "
            >
              <h1
                class="
                  text-xl
                  font-bold
                  text-white
                "
              >
                404
              </h1>

              <p
                class="
                  mt-2
                  text-sm
                  text-violet-200/70
                "
              >
                Trang không tồn tại.
              </p>

              <a
                href="/"
                class="
                  ng-btn
                  mt-5
                  inline-flex
                  rounded-2xl
                  px-6
                  py-3
                  font-semibold
                "
              >
                Về trang chủ
              </a>
            </section>
          `,
        })
      );
  }
);

/* ============================================================
   HTML HELPERS
   ============================================================ */

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]
  );
}

/* ============================================================
   SUCCESS PAGE
   ============================================================ */

function claimSuccessPage({
  key,
  expiresAt,
  status,
  created,
}) {
  const cd =
    Math.max(
      0,
      expiresAt -
        Date.now()
    );

  return renderPage({
    title:
      "Kyzen Key — Thành công",

    bodyHtml: `
      <header
        class="mb-6 text-center"
      >
        <h1
          class="
            bg-gradient-to-r
            from-violet-300
            via-fuchsia-300
            to-pink-300
            bg-clip-text
            text-2xl
            font-extrabold
            tracking-tight
            text-transparent
            sm:text-3xl
          "
        >
          KYZEN KEY
        </h1>

        <div
          class="
            mt-2
            text-xs
            text-violet-300/70
          "
        >
          ${
            created
              ? "Key mới đã được tạo (24h)"
              : "Key còn hạn — trả key hiện tại"
          }
        </div>
      </header>

      <section
        class="
          ng-card
          ng-fade
          w-full
          rounded-3xl
          p-6
          text-center
          sm:p-8
        "
      >

        <p
          class="
            mb-2
            text-xs
            uppercase
            tracking-widest
            text-violet-300/70
          "
        >
          Key của bạn
        </p>

        <div
          class="
            ng-keybox
            w-full
            break-all
            rounded-2xl
            px-4
            py-4
          "
        >
          <code
            id="keyText"
            class="
              font-mono
              text-lg
              font-bold
              tracking-wide
              text-white
              sm:text-xl
            "
          >
            ${escapeHtml(key)}
          </code>
        </div>

        <button
          id="copyBtn"
          class="
            ng-btn
            mt-4
            inline-flex
            items-center
            justify-center
            gap-2
            rounded-xl
            px-5
            py-2.5
            text-sm
            font-semibold
          "
        >
          <span id="copyLabel">
            📋 Copy Key
          </span>
        </button>

        <div
          class="mt-6 w-full"
        >
          <p
            class="
              mb-1.5
              text-xs
              uppercase
              tracking-widest
              text-violet-300/70
            "
          >
            Hết hạn sau
          </p>

          <div
            id="countdown"
            class="
              font-mono
              text-3xl
              font-bold
              text-white
            "
            data-expires="${expiresAt}"
          >
            ${fmtCountdown(cd)}
          </div>
        </div>

        <p
          class="
            mt-5
            text-sm
            font-medium
          "
          style="
            color:#c4b5fd;
            text-shadow:
              0 0 18px
              rgba(167,139,250,.6)
          "
        >
          ✅ Key hợp lệ 24 giờ —
          dán vào Roblox để xác minh
        </p>

        <div
          class="
            mt-5
            rounded-2xl
            border
            border-violet-500/20
            bg-violet-500/5
            p-3
            text-left
            text-xs
            text-violet-200/70
          "
        >
          <div
            class="
              font-semibold
              text-violet-100
            "
          >
            Roblox verify:
          </div>

          <div
            class="
              mt-1
              font-mono
            "
          >
            POST /api/verify
            { "key": "${escapeHtml(key)}" }
          </div>
        </div>

      </section>

      <footer
        class="
          mt-6
          text-center
          text-xs
          text-violet-300/40
        "
      >
        Kyzen NextGen • status:
        ${escapeHtml(status)}
      </footer>

      <script>
        const keyText =
          document.getElementById("keyText");

        const copyBtn =
          document.getElementById("copyBtn");

        const copyLabel =
          document.getElementById("copyLabel");

        const cd =
          document.getElementById("countdown");

        const expires =
          Number(cd.dataset.expires);

        copyBtn.addEventListener(
          "click",
          async () => {
            try {
              await navigator.clipboard.writeText(
                keyText.textContent
              );
            } catch {}

            copyLabel.textContent =
              "✅ Đã copy";

            setTimeout(
              () =>
                copyLabel.textContent =
                  "📋 Copy Key",
              1500
            );
          }
        );

        setInterval(() => {
          const left =
            expires -
            Date.now();

          cd.textContent =
            (() => {
              const t =
                Math.max(
                  0,
                  Math.floor(
                    left / 1000
                  )
                );

              const h =
                Math.floor(
                  t / 3600
                );

              const m =
                Math.floor(
                  (t % 3600) / 60
                );

              const s =
                t % 60;

              return [
                h,
                m,
                s,
              ]
                .map(
                  n =>
                    String(n)
                      .padStart(
                        2,
                        "0"
                      )
                )
                .join(":");
            })();

          cd.style.color =
            left <= 0
              ? "#f87171"
              : left < 3600000
                ? "#fcd34d"
                : "#fff";
        }, 1000);
      </script>
    `,
  });
}

/* ============================================================
   ERROR PAGE
   ============================================================ */

function claimErrorPage(msg) {
  return renderPage({
    title:
      "Kyzen Key — Lỗi",

    bodyHtml: `
      <section
        class="
          ng-card
          w-full
          rounded-3xl
          p-6
          text-center
        "
      >

        <h1
          class="
            text-xl
            font-bold
            text-amber-300
          "
        >
          Không thể cấp key
        </h1>

        <p
          class="
            mt-3
            text-sm
            text-violet-200/70
          "
        >
          ${escapeHtml(msg)}
        </p>

        <a
          href="/get-key"
          class="
            ng-btn
            mt-5
            inline-flex
            rounded-2xl
            px-6
            py-3
            font-semibold
          "
        >
          🔑 Bấm GET KEY lại
        </a>

      </section>
    `,
  });
}

/* ============================================================
   LINK4M REQUIRED PAGE
   ============================================================ */

function link4mRequiredPage({
  publicUrl,
}) {
  const getKeyUrl =
    `${publicUrl}/get-key`;

  return renderPage({
    title:
      "Kyzen — Cần xác minh Link4m",

    bodyHtml: `
      <header
        class="
          mb-6
          text-center
        "
      >

        <h1
          class="
            bg-gradient-to-r
            from-amber-300
            via-orange-300
            to-pink-300
            bg-clip-text
            text-2xl
            font-extrabold
            tracking-tight
            text-transparent
            sm:text-3xl
          "
        >
          CẦN XÁC MINH LINK4M
        </h1>

        <div
          class="
            mt-2
            text-xs
            text-amber-200/70
          "
        >
          Bạn chưa hoàn thành
          bước xác minh Link4m
        </div>

      </header>

      <section
        class="
          ng-card
          ng-fade
          w-full
          rounded-3xl
          p-6
          text-center
          sm:p-8
        "
      >

        <div
          class="
            mx-auto
            mb-5
            flex
            h-16
            w-16
            items-center
            justify-center
            rounded-2xl
            border
            border-amber-500/30
            bg-amber-500/10
          "
        >
          <span
            class="text-3xl"
          >
            ⛔
          </span>
        </div>

        <p
          class="
            mb-2
            text-sm
            text-violet-200/80
          "
        >
          Bạn cần qua bước xác minh
          <b class="text-violet-100">
            Link4m
          </b>
          trước khi nhận key.
        </p>

        <p
          class="
            mb-6
            text-xs
            text-violet-300/60
          "
        >
          Sau khi hoàn thành Link4m,
          bạn sẽ được chuyển về đây
          và nhận key 24h.
        </p>

        <a
          href="${escapeHtml(getKeyUrl)}"
          class="
            ng-btn
            inline-flex
            w-full
            items-center
            justify-center
            rounded-2xl
            px-8
            py-3.5
            text-base
            font-semibold
          "
        >
          🔑 Lấy Key qua Link4m
        </a>

      </section>
    `,
  });
}

/* ============================================================
   COUNTDOWN
   ============================================================ */

function fmtCountdown(ms) {
  if (ms <= 0) {
    return "00:00:00";
  }

  const t =
    Math.floor(
      ms / 1000
    );

  const h =
    Math.floor(
      t / 3600
    );

  const m =
    Math.floor(
      (t % 3600) / 60
    );

  const s =
    t % 60;

  return [
    h,
    m,
    s,
  ]
    .map(
      n =>
        String(n)
          .padStart(2, "0")
    )
    .join(":");
}

/* ============================================================
   START
   ============================================================ */

sweepExpiredKeys();
purgeOldSessions();

app.listen(
  PORT,
  () => {
    console.log(
      `[kyzen] backend listening on :${PORT}`
    );

    console.log(
      `[kyzen] PUBLIC_BASE_URL = ${
        PUBLIC_BASE_URL ||
        "(auto from request)"
      }`
    );

    console.log(
      `[kyzen] LINK4M_FIXED_URL = ${
        LINK4M_FIXED_URL
          ? "configured"
          : "NOT CONFIGURED"
      }`
    );
  }
);
