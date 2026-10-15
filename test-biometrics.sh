#!/bin/bash
# End-to-end test of the Apple Watch biometrics API. Usage: ./test-biometrics.sh [baseUrl]
BASE="${1:-http://localhost:3000}"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS: $1"; pass=$((pass+1)); else echo "FAIL: $1 (expected '$3', got '$2')"; fail=$((fail+1)); fi; }
json() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(eval('o.'+process.argv[1]))}catch(e){console.log('ERR')}})" "$1"; }

PAIR=$(curl -s -X POST "$BASE/api/biometrics/pair")
SID=$(echo "$PAIR" | json sessionId); CODE=$(echo "$PAIR" | json pairCode)
check "pair code is 6 digits" "$(echo -n "$CODE" | grep -Ec '^[0-9]{6}$')" "1"

check "wrong code rejected" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/biometrics/pair/confirm" -H 'Content-Type: application/json' -d '{"code":"000000x"}')" "400"

CONF=$(curl -s -X POST "$BASE/api/biometrics/pair/confirm" -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}")
TOKEN=$(echo "$CONF" | json token)
check "valid code returns token" "$([ -n "$TOKEN" ] && [ "$TOKEN" != "ERR" ] && echo ok)" "ok"

check "code is single-use" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/biometrics/pair/confirm" -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}")" "400"
check "upload without token -> 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/biometrics" -H 'Content-Type: application/json' -d '{"bpm":80}')" "401"
check "upload with bad token -> 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/biometrics" -H 'Authorization: Bearer nope' -H 'Content-Type: application/json' -d '{"bpm":80}')" "401"
check "invalid bpm -> 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/biometrics" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"bpm":999}')" "400"

post() { curl -s -X POST "$BASE/api/biometrics" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$1"; }
check "calm sample" "$(post '{"bpm":66,"hrv":55,"restingBpm":64,"isStationary":true}' | json sample.stressLevel)" "Calm"
check "elevated sample" "$(post '{"bpm":82,"hrv":40,"restingBpm":64,"isStationary":true}' | json sample.stressLevel)" "Elevated"
check "high stress sample" "$(post '{"bpm":100,"hrv":22,"restingBpm":64,"isStationary":true}' | json sample.stressLevel)" "High Stress"
check "moving is not assessed" "$(post '{"bpm":130,"restingBpm":64,"isStationary":false}' | json sample.assessed)" "false"

CUR=$(curl -s "$BASE/api/biometrics/current?sessionId=$SID")
check "current shows connected" "$(echo "$CUR" | json connected)" "true"
check "current is latest sample" "$(echo "$CUR" | json latest.bpm)" "130"
check "history has 4 samples" "$(curl -s "$BASE/api/biometrics/history?sessionId=$SID" | json samples.length)" "4"
check "unknown session -> 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/biometrics/current?sessionId=bad")" "404"

curl -s -X DELETE "$BASE/api/biometrics/session?sessionId=$SID" > /dev/null
check "unpair deletes session" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/biometrics/current?sessionId=$SID")" "404"
check "token dead after unpair" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/biometrics" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"bpm":80}')" "401"

# Security: secret files must not be downloadable
check "settings.json not exposed" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/data/settings.json")" "404"
check "server.js not exposed" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/server.js")" "404"
check ".env not exposed" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/.env")" "404"
check "app page still loads" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")" "200"
check "renderer.js still loads" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/renderer.js")" "200"

echo "---- $pass passed, $fail failed ----"
[ "$fail" -eq 0 ]
