# KYZEN NEXTGEN — Backend / Key Website

Hệ thống **Key Website + Backend API + Database** cho Kyzen Hub (Roblox).
Không bao gồm Roblox UI/loader — bạn tự tích hợp qua `POST /api/verify`.

---

## 1. Website URL

```
https://01qe5.app.super.myninja.ai
```

> Lưu ý: URL public này được tạo bởi `expose-port` trong sandbox Ninja.
> Khi deploy lên host thật (VPS / Railway / Render / Fly.io), thay bằng domain của bạn
> và cập nhật `PUBLIC_BASE_URL` trong `.env`.

Endpoints công khai:

| Path | Method | Mục đích |
|---|---|---|
| `/` | GET | Trang chủ (nút GET KEY + thông tin API) |
| `/get-key` | GET | Bắt đầu flow → tạo claim session (chưa verified) → shorten `/claim-ok?token=XXXX` qua Link4m → redirect user sang Link4m |
| `/claim-ok?token=XXXX` | GET | Link4m redirect target — mark session `verified=1` → 302 sang `/claim` |
| `/claim?token=XXXX` | GET | Kiểm tra `verified` → trả/tạo key (HTML). **Yêu cầu đã qua Link4m**, nếu chưa → 403 |
| `/claim.json?token=XXXX` | GET | Tương tự `/claim` nhưng trả JSON. Chưa verified → 403 `{needLink4m:true}` |
| `/api/verify` | POST | **Roblox verify key** (JSON) |
| `/api/verify?key=` | GET | GET fallback cho executor |
| `/health` | GET | Health check |
| `/admin/stats?password=` | GET | Stats (bảo vệ bằng ADMIN_PASSWORD) |
| `/admin/keys?password=` | GET | List active keys (admin) |

---

## 2. GET KEY URL

```
GET /get-key
```

- Tạo **claim session** (5 phút, lưu DB, `verified = 0`, KHÔNG tạo key ở bước này).
- Gọi Link4m API (server-side) rút gọn URL đích `https://<PUBLIC_BASE_URL>/claim-ok?token=XXXX`.
  → **Lưu ý**: đích là `/claim-ok`, KHÔNG phải `/claim`. Đây là chốt chặn Link4m.
- Redirect (302) user sang link Link4m ngắn.
- Nếu identifier đã có key active → tạo session đã `verified=1` → redirect thẳng `/claim` (trả key cũ, khỏi qua Link4m).
- Rate limit: 10 req/phút/IP (anti-spam).

**Trong sandbox** (Link4m API bị Cloudflare block từ IP datacenter): `/get-key` render trang
HTML cho cả link Link4m (nếu tạo được) lẫn nút "Hoàn thành xác minh (giả lập Link4m)" trỏ
tới `/claim-ok` — mô phỏng redirect của Link4m để test flow end-to-end. Trong production
(host IP thật) thì luôn 302 sang Link4m, user xác minh ở đó rồi Link4m đẩy về `/claim-ok`.

---

## 3. Claim URL

```
GET /claim?token=XXXX
```

Backend:
1. Validate claim session (token tồn tại + chưa hết hạn 5 phút).
2. **Kiểm tra `session.verified`** — nếu `0` (chưa qua Link4m) → trả **403** + trang "Cần xác minh Link4m" (HTML) hoặc `{success:false,error:"link4m verification required",needLink4m:true}` (JSON). **KHÔNG cấp key.**
3. Nếu `verified = 1` → xác định `identifier` từ session.
4. Tìm key active của identifier.
5. Kiểm tra `expiresAt`.

**Key còn hạn → trả key hiện tại (KHÔNG tạo mới):**
```json
{ "success": true, "status": "active", "key": "Kyzen_xxxxx", "expiresAt": 1234567890000 }
```

**Key hết hạn / chưa có → tạo key mới 24h:**
```json
{ "success": true, "status": "created", "key": "Kyzen_xxxxx", "expiresAt": 1234567890000 }
```

`/claim` trả HTML (hiện key + countdown + nút Copy).
`/claim.json` trả JSON (cho test / tích hợp).

### `/claim-ok?token=XXXX` — Link4m redirect target

Đây là URL được Link4m rút gọn. Khi user hoàn thành verification trên Link4m, Link4m
redirect họ về `https://<PUBLIC>/claim-ok?token=XXXX`. Endpoint này:
1. Validate session.
2. `markSessionVerified(token)` — set `verified = 1`.
3. 302 redirect → `/claim?token=XXXX` (lúc này verified, sẽ cấp key).

> **Tại sao tách `/claim-ok` khỏi `/claim`?** Nếu gộp, user có thể bấm `/claim?token=XXXX`
> trực tiếp (bypass Link4m) và vẫn nhận key. Tách ra: Link4m là bên duy nhất biết short URL
> → user phải đi qua Link4m để tới `/claim-ok` → mới được `verified` → `/claim` mới cấp key.
> Truy cập `/claim` trực tiếp (không qua Link4m) = 403, không key.

---

## 4. Verify API (Roblox)

```
POST /api/verify
Content-Type: application/json
```

**Request:**
```json
{ "key": "Kyzen_xxxxxxxxxxxxxxxx" }
```

**Response — key đúng & còn hạn (200):**
```json
{ "valid": true, "status": "active", "expiresAt": 1234567890000 }
```

**Response — key hết hạn (200):**
```json
{ "valid": false, "status": "expired" }
```

**Response — key không tồn tại (200):**
```json
{ "valid": false, "status": "invalid" }
```

> `expiresAt` là Unix timestamp **milliseconds**.
> GET fallback: `GET /api/verify?key=Kyzen_xxx` (cho executor không hỗ trợ POST body).

### Ví dụ Roblox Lua
```lua
local HttpService = game:GetService("HttpService")
local SERVER = "https://01qe5.app.super.myninja.ai"

local function verifyKey(key)
    local ok, res = pcall(function()
        return HttpService:PostAsync(
            SERVER .. "/api/verify",
            HttpService:JSONEncode({ key = key }),
            Enum.HttpContentType.ApplicationJson
        )
    end)
    if not ok then return false, "http_error" end
    local data = HttpService:JSONDecode(res)
    return data.valid == true, data.status, data.expiresAt
end

-- dùng:
local valid, status, exp = verifyKey("Kyzen_xxxxx")
if valid then
    print("Key hợp lệ đến", os.date("%c", exp/1000))
else
    warn("Key không hợp lệ:", status)
end
```

---

## 5. Database Schema (SQLite)

```sql
-- Key records (tồn tại đến khi hết hạn, KHÔNG xoá khi xoá session)
CREATE TABLE keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL UNIQUE,        -- Kyzen_ + 24 hex
  identifier  TEXT    NOT NULL,               -- HMAC-SHA256 fingerprint
  createdAt   INTEGER NOT NULL,               -- ms
  expiresAt   INTEGER NOT NULL,               -- ms (createdAt + 24h)
  status      TEXT    NOT NULL DEFAULT 'active' -- active | expired
);
CREATE INDEX idx_keys_identifier ON keys(identifier);
CREATE INDEX idx_keys_key         ON keys(key);

-- Claim sessions (5 phút, tự xoá)
CREATE TABLE claim_sessions (
  id          TEXT    PRIMARY KEY,            -- claim token (URL-safe)
  identifier  TEXT    NOT NULL,
  createdAt   INTEGER NOT NULL,
  expiresAt   INTEGER NOT NULL,               -- createdAt + 5 min
  verified    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_identifier ON claim_sessions(identifier);
```

File DB: `data/kyzen.db` (đổi qua `DATABASE_URL`).

---

## 6. Environment Variables (server-side ONLY)

```env
LINK4M_API_TOKEN=6a7aefcdd8cb7165cf3eb9b7
LINK4M_API_URL=https://link4m.co/api-shorten/v2
KYZEN_API_SECRET=<random-long-string>     # HMAC sign identifier
ADMIN_PASSWORD=<your-admin-password>       # /admin endpoints
DATABASE_URL=./data/kyzen.db               # SQLite path
PORT=8799
PUBLIC_BASE_URL=https://01qe5.app.super.myninja.ai   # base cho Link4m redirect
```

> **Bảo mật:** Tất cả secret chỉ nằm server-side. Không bao giờ xuất hiện trong HTML,
> JS client, Roblox Lua, hay API response. `LINK4M_API_TOKEN` chỉ server gọi Link4m.

---

## 7. Link4m Redirect Flow

```
User bấm GET KEY
   │
   ▼  GET /get-key
Backend: tạo claim session (token=XXXX, identifier=H, verified=0)
   │
   ▼  shortenWithLink4m("https://<PUBLIC>/claim-ok?token=XXXX")
Link4m API: trả short URL (vd https://link4m.net/abc)
   │
   ▼  302 redirect → link4m short URL
User hoàn thành verification trên Link4m
   │
   ▼  Link4m redirect → https://<PUBLIC>/claim-ok?token=XXXX
Backend: GET /claim-ok?token=XXXX
   │  1. validate session (token hợp lệ + chưa 5 phút)
   │  2. mark verified=1
   │  3. 302 redirect → /claim?token=XXXX
   ▼
Backend: GET /claim?token=XXXX
   │  1. validate session
   │  2. CHECK verified — nếu 0 → 403 "Cần xác minh Link4m" (KHÔNG cấp key)
   │  3. identifier = session.identifier
   │  4. find active key for identifier
   │
   ├─ có key active → trả key cũ (status: active)
   └─ hết hạn/chưa có → tạo key 24h (status: created)
   │
   ▼  Hiện key + countdown + Copy
```

### Bypass attempt (không qua Link4m)

```
User bấm /claim?token=XXXX trực tiếp (KHÔNG qua Link4m)
   │
   ▼  GET /claim?token=XXXX
Backend: session.verified == 0
   │
   ▼  403 — "Cần xác minh Link4m" (HTML) / {needLink4m:true} (JSON)
   ❌ KHÔNG cấp key
```

---

## 8. Cách xác định identifier / user session

- Server set **cookie `kz_fp`** (HttpOnly, 1 năm) giá trị = `base + "." + HMAC(base)`.
  `base = UUID + "." + random hex`, HMAC ký bằng `KYZEN_API_SECRET`.
- `identifier = HMAC(base)` — **stable per browser**, server-computed, KHÔNG tin giá trị client gửi.
- Mỗi request, server verify HMAC cookie. Hợp lệ → dùng lại identifier cũ.
  Không hợp lệ/thiếu → mint fingerprint mới (set cookie mới) → identifier mới.

### Chống spam cấp key
- **Refresh page**: cookie giữ nguyên → cùng identifier → cùng key active → **không tạo key mới**. ✅
- **Xoá cookie**: mất identifier cũ → identifier mới (không key active) → có thể tạo key mới.
  Đây là giới hạn cố hữu khi không có account thật; không có cách nào chống 100% mà không yêu cầu login.
- **Mở incognito**: tương tự xoá cookie — identifier mới.
- **Cùng 1 trình duyệt (không xoá cookie)**: cùng identifier → cùng key, refresh bao nhiêu lần cũng không spam.

> Nếu sau này cần chống spam tuyệt đối: thêm bước đăng nhập (Discord OAuth, Google) hoặc
> whitelist HWID từ Roblox gửi lên `/api/verify` (HWID làm identifier thay vì cookie).

---

## 9. Cách key hết hạn sau 24h

- Khi tạo key: `expiresAt = Date.now() + 24*60*60*1000`.
- **Lazy expiry**: mỗi lần `/api/verify` hoặc `/claim`, nếu `expiresAt <= now` → mark `status='expired'`.
- **Sweep định kỳ**: mỗi 60s, `UPDATE keys SET status='expired' WHERE status='active' AND expiresAt<=now`.
- Key record **KHÔNG bị xoá** khi hết hạn (giữ lại để verify trả `expired` thay vì `invalid`).
- Claim session tự xoá sau 5 phút (`DELETE WHERE expiresAt<=now`), **không xoá key record**.

---

## 10. HTTP Status Codes

| Endpoint | Status | Ý nghĩa |
|---|---|---|
| `GET /` | 200 | Trang chủ |
| `GET /get-key` | 302 | Redirect → Link4m (hoặc `/claim` nếu đã có key active) |
| `GET /get-key` | 200 | Sandbox: Link4m API block → render trang xác minh (có nút giả lập) |
| `GET /get-key` | 429 | Rate limit (10 req/phút/IP) |
| `GET /claim-ok?token=` | 302 | Mark verified → redirect `/claim?token=` |
| `GET /claim-ok` (thiếu token) | 400 | Bad request |
| `GET /claim-ok?token=` (hết hạn/sai) | 410 | Gone — session hết hạn |
| `GET /claim?token=` (verified) | 200 | Trả/tạo key (HTML) |
| `GET /claim?token=` (CHƯA verified) | 403 | "Cần xác minh Link4m" — KHÔNG cấp key |
| `GET /claim` (thiếu token) | 400 | Bad request |
| `GET /claim?token=` (hết hạn/sai) | 410 | Gone — session hết hạn |
| `GET /claim.json` (verified) | 200 | JSON success |
| `GET /claim.json` (CHƯA verified) | 403 | `{success:false,error:"link4m verification required",needLink4m:true}` |
| `GET /claim.json` (thiếu token) | 400 | `{success:false,error:"missing token"}` |
| `GET /claim.json` (session sai) | 410 | `{success:false,error:"invalid or expired session"}` |
| `POST /api/verify` | 200 | Luôn 200; kết quả trong `valid`/`status` |
| `GET /api/verify` | 200 | GET fallback |
| `GET /health` | 200 | `{ok:true,time:...}` |
| `GET /admin/*` | 200 | (password đúng) |
| `GET /admin/*` | 401 | Unauthorized (sai password) |
| any `/api/*` không tồn tại | 404 | `{error:"not found"}` |
| any path không tồn tại | 404 | HTML 404 page |

---

## Files

```
kyzen-backend/
├── server.js          # Express app — tất cả endpoints + HTML
├── db.js              # SQLite layer (better-sqlite3)
├── crypto.js          # HMAC sign / identifier / key + token gen
├── link4m.js          # Link4m shorten API (server-side)
├── .env-loader.js     # load .env into process.env (no dep)
├── .env.example       # template env
├── .env               # env thật (KHÔNG commit) — có token Link4m
├── package.json
├── API.md             # file này
└── test-flow.js       # E2E test (29 assertions — enforced Link4m flow)
```

## Chạy

```bash
cd kyzen-backend
npm install
cp .env.example .env      # fill secrets
node server.js            # listen on PORT (default 8799)
```

## Test

```bash
node test-flow.js
```

---

## Ghi chú sandbox

Trong sandbox Ninja, Link4m API đôi khi bị Cloudflare challenge từ IP datacenter
(khi gọi server-side). Trong production (host IP thật) không bị. Flow verification
thực tế chạy trong **browser người dùng** (họ navigate tới link Link4m), nên server
chỉ cần *tạo* short link — phần verify do user làm. Nếu Link4m create bị block,
`/get-key` render trang cho cả link Link4m lẫn nút "Hoàn thành xác minh (giả lập Link4m)"
trỏ tới `/claim-ok` — mô phỏng redirect của Link4m để test end-to-end.

**Quan trọng**: `/claim` (và `/claim.json`) **luôn yêu cầu `verified=1`**. User phải đi
qua `/claim-ok` (tức là qua Link4m) thì mới được cấp key. Truy cập `/claim` trực tiếp
= 403, không key. Đây là enforcement Link4m cho người dùng.
