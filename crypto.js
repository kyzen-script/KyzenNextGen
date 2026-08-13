import { createHmac, randomBytes, randomUUID } from "node:crypto";

/* ============================================================
   Kyzen NextGen — Crypto / identifier helpers
   - identifier: HMAC-SHA256 over a stable fingerprint, signed with KYZEN_API_SECRET
     so the server can recompute the same identifier for the same client across
     requests WITHOUT trusting a client-supplied cookie value. The signed cookie
     value itself is tamper-proof (HMAC). Deleting the cookie simply makes the
     server unable to recompute the SAME identifier -> it issues a NEW identifier,
     which (by design) has no active key -> a fresh key can be created. That is
     acceptable: there is no per-physical-human dedup without a real account.
     The spec's "no refresh spam" requirement is satisfied because refreshing
     the page keeps the same signed cookie -> same identifier -> same active key
     returned (NOT a new key).
   ============================================================ */

/** Secret is read LAZILY so the .env loader (imported first) can populate it
 *  before any signing happens. Reading it at module top-level would freeze it
 *  to the dev fallback when crypto.js is imported before .env-loader.js. */
function getSecret() {
  return process.env.KYZEN_API_SECRET || "dev-secret-change-me";
}

/** Sign a payload with HMAC-SHA256 -> hex. */
export function sign(payload) {
  return createHmac("sha256", getSecret()).update(String(payload)).digest("hex");
}

/**
 * Derive a stable, server-side identifier from a signed client fingerprint.
 * The fingerprint cookie is set by the server as: `fp = base + '.' + hmac(base)`.
 * We verify the hmac; if valid, identifier = hmac(base). If invalid/missing,
 * we mint a fresh fingerprint (and the route will set the new cookie).
 */
export function identifierFromFingerprint(fpCookie) {
  if (!fpCookie || typeof fpCookie !== "string") return null;
  const idx = fpCookie.lastIndexOf(".");
  if (idx < 1) return null;
  const base = fpCookie.slice(0, idx);
  const mac = fpCookie.slice(idx + 1);
  if (!base || !mac) return null;
  const expected = sign(base);
  if (mac.length !== expected.length) return null;
  // constant-time-ish compare
  if (!timingSafeEqual(mac, expected)) return null;
  return expected; // stable identifier bound to this browser
}

/** Create a brand-new signed fingerprint cookie value + its identifier. */
export function newFingerprint() {
  const base = randomUUID() + "." + randomBytes(8).toString("hex");
  const mac = sign(base);
  return {
    cookie: base + "." + mac,
    identifier: mac,
  };
}

/** Constant-time string compare. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Generate a Kyzen key: Kyzen_ + 24 hex chars. */
export function generateKyzenKey() {
  return "Kyzen_" + randomBytes(12).toString("hex");
}

/** Generate a claim session token (URL-safe). */
export function generateClaimToken() {
  return randomBytes(18).toString("base64url");
}

/** HMAC-sign a token (used for admin/signed responses if needed). */
export function signToken(payload) {
  return sign(payload);
}
