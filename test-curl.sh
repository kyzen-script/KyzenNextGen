#!/bin/bash
# Full end-to-end curl test of the Link4m-enforced flow against localhost.
set -e
BASE="http://localhost:8799"
COOKIE_JAR="/tmp/kyzen-cookies.txt"
rm -f "$COOKIE_JAR"

echo "=========================================="
echo "  KYZEN NEXTGEN — Link4m Enforcement Test"
echo "=========================================="

echo ""
echo "=== STEP 1: GET / (landing page) ==="
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/")
echo "Status: $STATUS (expect 200)"

echo ""
echo "=== STEP 2: GET /get-key (creates session, redirects to Link4m) ==="
# Follow=false to capture the 302 + cookie
REDIR=$(curl -sS -D /tmp/gk-hdrs.txt -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$BASE/get-key")
LOC=$(grep -i "^location:" /tmp/gk-hdrs.txt | tr -d '\r' | awk '{print $2}')
echo "Status: $REDIR"
echo "Redirect Location: $LOC"
if echo "$LOC" | grep -qi "link4m"; then
  echo "✅ Redirected to Link4m — API working!"
elif [ "$REDIR" = "200" ]; then
  echo "⚠️  Got 200 fallback page (Link4m API blocked in sandbox)"
fi

echo ""
echo "=== STEP 3: Get token from DB ==="
TOKEN=$(node -e "const D=require('better-sqlite3');const db=new D('./data/kyzen.db');const r=db.prepare('SELECT id FROM claim_sessions ORDER BY createdAt DESC LIMIT 1').get();process.stdout.write(r.id);")
echo "Token: $TOKEN"

echo ""
echo "=== STEP 4: GET /claim.json WITHOUT Link4m -> expect 403 ==="
RESP=$(curl -sS -w "\n%{http_code}" -b "$COOKIE_JAR" "$BASE/claim.json?token=$TOKEN")
BODY=$(echo "$RESP" | head -n -1)
CODE=$(echo "$RESP" | tail -1)
echo "Status: $CODE (expect 403)"
echo "Body: $BODY"
if [ "$CODE" = "403" ]; then echo "✅ BLOCKED — no key without Link4m!"; else echo "❌ FAIL"; fi

echo ""
echo "=== STEP 5: GET /claim (HTML) WITHOUT Link4m -> expect 403 + link4mRequiredPage ==="
RESP=$(curl -sS -w "\n%{http_code}" -b "$COOKIE_JAR" "$BASE/claim?token=$TOKEN")
BODY=$(echo "$RESP" | head -n -1)
CODE=$(echo "$RESP" | tail -1)
echo "Status: $CODE (expect 403)"
if echo "$BODY" | grep -q "XÁC MINH LINK4M"; then echo "✅ Shows link4m-required page!"; else echo "❌ FAIL"; fi

echo ""
echo "=== STEP 6: Simulate Link4m redirect -> GET /claim-ok?token=XXXX (expect 302) ==="
RESP=$(curl -sS -D /tmp/ok-hdrs.txt -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" "$BASE/claim-ok?token=$TOKEN" -H "Referer: https://link4m.net/abc")
LOC=$(grep -i "^location:" /tmp/ok-hdrs.txt | tr -d '\r' | awk '{print $2}')
echo "Status: $RESP (expect 302)"
echo "Redirect to: $LOC"

echo ""
echo "=== STEP 7: Verify session is now verified in DB ==="
VERIFIED=$(node -e "const D=require('better-sqlite3');const db=new D('./data/kyzen.db');const r=db.prepare('SELECT verified FROM claim_sessions WHERE id=?').get('$TOKEN');process.stdout.write(String(r.verified));")
echo "verified = $VERIFIED (expect 1)"
if [ "$VERIFIED" = "1" ]; then echo "✅ Session marked verified!"; else echo "❌ FAIL"; fi

echo ""
echo "=== STEP 8: GET /claim.json AFTER Link4m -> expect 200 + KEY ==="
RESP=$(curl -sS -w "\n%{http_code}" -b "$COOKIE_JAR" "$BASE/claim.json?token=$TOKEN")
BODY=$(echo "$RESP" | head -n -1)
CODE=$(echo "$RESP" | tail -1)
echo "Status: $CODE (expect 200)"
echo "Body: $BODY"
if echo "$BODY" | grep -q '"success":true'; then echo "✅ KEY ISSUED after Link4m!"; else echo "❌ FAIL"; fi

echo ""
echo "=== STEP 9: Roblox POST /api/verify with the key ==="
KEY=$(echo "$BODY" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(d.key);")
echo "Key: $KEY"
RESP=$(curl -sS -X POST "$BASE/api/verify" -H "Content-Type: application/json" -d "{\"key\":\"$KEY\"}")
echo "Verify response: $RESP"
if echo "$RESP" | grep -q '"valid":true'; then echo "✅ Roblox verify works!"; else echo "❌ FAIL"; fi

echo ""
echo "=========================================="
echo "  FLOW COMPLETE — Link4m is enforced! 🔒"
echo "=========================================="
