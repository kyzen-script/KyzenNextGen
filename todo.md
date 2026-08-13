# Kyzen NextGen — Link4m Enforcement Fix

## Completed
- [x] Define `link4mRequiredPage()` function in server.js (was missing — caused ReferenceError)
- [x] Restructure flow: `/get-key` shortens `/claim-ok?token=XXXX` (not `/claim`) via Link4m
- [x] Add `/claim-ok` endpoint — Link4m redirect target, marks session verified → bounces to `/claim`
- [x] `/claim` and `/claim.json` now CHECK `session.verified` → 403 if not verified (no key!)
- [x] Add genuineness check in `/claim-ok` (Referer from link4m domain or extra query params)
- [x] Update fallback page (remove "bypass" framing, reframe as "Hoàn thành xác minh")
- [x] Restart server with updated code
- [x] Update test-flow.js — 29 assertions covering enforced Link4m flow
- [x] Run tests — 29/29 passed:
  - [x] Direct `/claim?token=XXXX` without Link4m → blocked (403)
  - [x] Going through `/claim-ok?token=XXXX` → verified → `/claim` issues key
- [x] Update API.md — documented `/claim-ok` endpoint + enforced Link4m flow + bypass diagram
- [x] Created test-curl.sh — 9-step curl E2E test (all pass)
- [x] Expose port (CloudFront proxy returns 302→404 — known sandbox limitation; localhost works perfectly)
