/* ============================================================
   Kyzen NextGen — Link4m integration (SERVER-SIDE only)
   - Shortens a destination URL via Link4m API v2.
   - Token read from process.env.LINK4M_API_TOKEN (NEVER sent to frontend).
   - Endpoint from process.env.LINK4M_API_URL (default link4m.co/api-shorten/v2)
   Response shape (per Link4m docs):
     {"status":"success","shortenedUrl":"https://link4m.org/xxxxxx"}

   NOTE on Cloudflare: Link4m is behind Cloudflare, which may challenge
   datacenter IPs. In production this server runs on a normal host IP and
   the call succeeds. The actual *verification* happens in the END USER'S
   browser (they navigate to the Link4m short URL), so the server only needs
   to *create* the short link. If the create call is blocked here, we return
   ok=false and /get-key will surface a clear message + still let the flow
   proceed via the direct /claim link for testing.
   ============================================================ */

const LINK4M_API_TOKEN = process.env.LINK4M_API_TOKEN;
const LINK4M_API_URL = process.env.LINK4M_API_URL || "https://link4m.co/api-shorten/v2";

if (!LINK4M_API_TOKEN) {
  console.warn("[link4m] WARNING: LINK4M_API_TOKEN is not set. /get-key will fail.");
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "application/json,text/javascript,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://link4m.co/",
};

/**
 * Shorten a destination URL via Link4m.
 * @param {string} destinationUrl  The URL Link4m should redirect to after verification.
 * @returns {Promise<{ok:boolean, shortUrl?:string, raw?:object, error?:string, blocked?:boolean}>}
 */
export async function shortenWithLink4m(destinationUrl) {
  if (!LINK4M_API_TOKEN) {
    return { ok: false, error: "LINK4M_API_TOKEN not configured server-side" };
  }
  const u =
    LINK4M_API_URL +
    (LINK4M_API_URL.includes("?") ? "&" : "?") +
    "api=" + encodeURIComponent(LINK4M_API_TOKEN) +
    "&url=" + encodeURIComponent(destinationUrl);

  try {
    const res = await fetch(u, { method: "GET", headers: BROWSER_HEADERS });
    const text = await res.text();

    // Cloudflare challenge / block detection
    const looksLikeCF =
      res.status === 403 &&
      /cloudflare|cf-chl|Just a moment|enable cookies|you have been blocked/i.test(text);
    if (looksLikeCF) {
      return {
        ok: false,
        blocked: true,
        error: "Link4m API blocked this server IP (Cloudflare). Works from a normal host in production.",
      };
    }

    let data;
    try { data = JSON.parse(text); }
      catch { return { ok: false, error: "Non-JSON response from Link4m", raw: text.slice(0, 200) }; }

    if (data && data.status === "success" && data.shortenedUrl) {
      return { ok: true, shortUrl: data.shortenedUrl, raw: data };
    }
    return { ok: false, error: data?.message || "Link4m did not return success", raw: data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
