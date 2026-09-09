#!/usr/bin/env bash
# End-to-end smoke test: a fresh Taut instance, from signup to an agent answering "pong", then
# an agent with browser access fetching a secret from its own vault through `vault_get`, then
# attachments both ways (a PNG the agent reads from inbox/, a file it sends back with taut_send).
#
#   pnpm e2e                      # from the repo root
#   TAUT_E2E_PORT=3999 pnpm e2e   # pick the port (default 3901)
#   TAUT_E2E_KEEP=1 pnpm e2e      # keep the temp data dir + server log for inspection
#
# Needs: bash, curl, jq, node ≥ 22, pnpm, and — for the agent steps — a `claude` binary logged in
# on this host (the server runs with TAUT_DEV_HOST_LOGIN=true, agent-model §4 dev path) plus a
# built `packages/taut-mcp/dist/mcp.js` (`pnpm build`), or the agent has no taut_*/vault_* tools.
# The script starts its own server on a temp TAUT_DATA_DIR and stops it on exit.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${TAUT_E2E_PORT:-3901}"
BASE="http://127.0.0.1:${PORT}"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/taut-e2e.XXXXXX")"
LOG="${DATA_DIR}/server.log"
J_OWNER="${DATA_DIR}/owner.jar"
J_DANA="${DATA_DIR}/dana.jar"
TIMEOUT_S="${TAUT_E2E_TIMEOUT:-120}"
PASS=0
FAIL=0
SERVER_PID=""

for bin in curl jq node pnpm; do
  command -v "$bin" >/dev/null 2>&1 || { echo "e2e: missing dependency: $bin" >&2; exit 2; }
done

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.3; done
    kill -9 "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "${TAUT_E2E_KEEP:-0}" = "1" ]; then
    echo "e2e: kept ${DATA_DIR} (server log: ${LOG})"
  else
    rm -rf "$DATA_DIR"
  fi
}
trap cleanup EXIT

step() { # step <name> <ok:0|1> [detail]
  if [ "$2" = "0" ]; then
    PASS=$((PASS + 1)); printf 'PASS  %-44s %s\n' "$1" "${3:-}"
  else
    FAIL=$((FAIL + 1)); printf 'FAIL  %-44s %s\n' "$1" "${3:-}"
  fi
}

# api <jar> <method> <path> [json-body] → body on stdout; HTTP status via `st` (api runs in
# a command substitution, so it hands the status over through a file).
st() { cat "${DATA_DIR}/.status" 2>/dev/null || echo '???'; }
api() {
  local jar="$1" method="$2" path="$3" body="${4:-}"
  local out
  if [ -n "$body" ]; then
    out=$(curl -sS -b "$jar" -c "$jar" -X "$method" "${BASE}${path}" \
      -H 'content-type: application/json' -d "$body" -w $'\n%{http_code}')
  else
    out=$(curl -sS -b "$jar" -c "$jar" -X "$method" "${BASE}${path}" -w $'\n%{http_code}')
  fi
  printf '%s' "${out##*$'\n'}" >"${DATA_DIR}/.status"
  printf '%s' "${out%$'\n'*}"
}

echo "e2e: data dir ${DATA_DIR}, port ${PORT}"

# ── 0. server ────────────────────────────────────────────────────────────────
if curl -sf "${BASE}/api/health" >/dev/null 2>&1; then
  echo "e2e: something already listens on ${BASE}; stop it or set TAUT_E2E_PORT" >&2
  exit 2
fi
# `node --import tsx` runs the server in this one process (the `tsx` CLI would fork a child
# that outlives the trap), so SERVER_PID is the process that owns the port.
(
  cd "${ROOT}/apps/server" &&
    exec env PORT="$PORT" TAUT_DATA_DIR="$DATA_DIR" TAUT_DEV_HOST_LOGIN=true \
      TAUT_MACHINE_PROVIDER=local NODE_ENV=development \
      node --import tsx src/main.ts
) >"$LOG" 2>&1 &
SERVER_PID=$!

up=1
for _ in $(seq 1 60); do
  if curl -sf "${BASE}/api/health" >/dev/null 2>&1; then up=0; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
step "server up (/api/health)" "$up" "$(curl -s "${BASE}/api/health" 2>/dev/null)"
if [ "$up" != "0" ]; then
  echo "--- server log:"; tail -40 "$LOG"; exit 1
fi

# ── 1. signup owner ──────────────────────────────────────────────────────────
res=$(api "$J_OWNER" POST /api/auth/signup '{"email":"owner@e2e.local","password":"password123","name":"Owner"}')
OWNER_ID=$(printf '%s' "$res" | jq -r '.user.id // empty')
[ "$(st)" = "201" ] || [ "$(st)" = "200" ]; ok=$?; [ -n "$OWNER_ID" ] || ok=1
step "signup owner" "$ok" "HTTP $(st) user=$OWNER_ID"

# ── 2. create company ────────────────────────────────────────────────────────
res=$(api "$J_OWNER" POST /api/companies '{"slug":"acme","name":"Acme","avatar":{"kind":"emoji","value":"🏢"}}')
COMPANY_ID=$(printf '%s' "$res" | jq -r '.id // empty')
[ -n "$COMPANY_ID" ]; step "create company" "$?" "HTTP $(st) company=$COMPANY_ID"

# ── 3. create department ─────────────────────────────────────────────────────
res=$(api "$J_OWNER" POST /api/departments "{\"name\":\"Engineering\",\"slug\":\"engineering\",\"headUserId\":\"$OWNER_ID\"}")
DEP_ID=$(printf '%s' "$res" | jq -r '.id // empty')
[ -n "$DEP_ID" ]; step "create department" "$?" "HTTP $(st) department=$DEP_ID"

# ── 4. invite dana ───────────────────────────────────────────────────────────
res=$(api "$J_OWNER" POST /api/invites '{"email":"dana@e2e.local","role":"member"}')
TOKEN=$(printf '%s' "$res" | jq -r '.token // empty')
[ -n "$TOKEN" ]; step "invite dana" "$?" "HTTP $(st)"

# ── 5. accept as a new user ──────────────────────────────────────────────────
res=$(api "$J_DANA" POST /api/invites/accept "{\"token\":\"$TOKEN\",\"name\":\"Dana\",\"password\":\"password123\"}")
DANA_ID=$(printf '%s' "$res" | jq -r '.user.id // empty')
[ -n "$DANA_ID" ]; ok=$?
if [ "$ok" = "0" ]; then
  me=$(api "$J_DANA" GET /api/auth/me); [ "$(printf '%s' "$me" | jq -r '.user.email // empty')" = "dana@e2e.local" ] || ok=1
fi
step "accept invite as new user (dana)" "$ok" "HTTP $(st) user=$DANA_ID"

# ── 6. set dana as department head ───────────────────────────────────────────
res=$(api "$J_OWNER" POST "/api/departments/$DEP_ID/head" "{\"headUserId\":\"$DANA_ID\"}")
[ "$(printf '%s' "$res" | jq -r '.headUserId // empty')" = "$DANA_ID" ]; step "set dana as department head" "$?" "HTTP $(st)"

# ── 7. vault item ────────────────────────────────────────────────────────────
res=$(api "$J_OWNER" POST /api/vault '{"kind":"anthropic.api_key","label":"E2E fake key","secret":"sk-ant-api03-e2e-not-a-real-key-0000"}')
VAULT_ID=$(printf '%s' "$res" | jq -r '.id // empty')
[ -n "$VAULT_ID" ] && [ "$(printf '%s' "$res" | jq -r 'has("ciphertext") or has("secret")')" = "false" ]
step "add vault item (metadata only in response)" "$?" "HTTP $(st) item=$VAULT_ID hint=$(printf '%s' "$res" | jq -r '.hint // ""')"

# ── 8. claude-code subscription ──────────────────────────────────────────────
res=$(api "$J_OWNER" POST /api/subscriptions "{\"runtime\":\"claude-code\",\"label\":\"Claude Code — e2e\",\"credentialId\":\"$VAULT_ID\"}")
SUB_ID=$(printf '%s' "$res" | jq -r '.id // empty')
SUB_STATUS=$(printf '%s' "$res" | jq -r '.status // empty')
[ -n "$SUB_ID" ]; step "add claude-code subscription" "$?" "HTTP $(st) status=$SUB_STATUS"
# The seat holds a fake key. Drain it (weight 0) so the run falls through to the host login
# instead of letting `claude` retry an invalid key for minutes (docs/CHANGELOG.md, Phase 4 §1).
res=$(api "$J_OWNER" PATCH "/api/subscriptions/$SUB_ID/weight" '{"weight":0}')
[ "$(printf '%s' "$res" | jq -r '.weight // empty')" = "0" ]; step "drain the fake seat (weight 0 → host login)" "$?" "HTTP $(st)"

# ── 9. agent bruno with a skill (dana, as head, creates it) ──────────────────
# `auto-edit`, not `plan`: Claude Code 2.1.263 refuses every MCP tool in plan mode
# ("Cannot call mcp__taut__vault_list while in plan mode"), whatever `--allowedTools` says,
# and step 14 needs `vault_list`/`vault_get`. See docs/CHANGELOG.md, "Browser access + agent vaults".
res=$(api "$J_DANA" POST /api/agents "{\"handle\":\"bruno\",\"name\":\"Bruno\",\"avatar\":{\"kind\":\"emoji\",\"value\":\"🦫\"},\"role\":\"Backend engineer\",\"mandate\":\"# Mandate\\n\\nAnswer briefly and do exactly what you are asked.\",\"runtimeKind\":\"claude-code\",\"permissionMode\":\"auto-edit\",\"departmentId\":\"$DEP_ID\"}")
AGENT_ID=$(printf '%s' "$res" | jq -r '.id // empty')
[ -n "$AGENT_ID" ] && [ "$(printf '%s' "$res" | jq -r '.departmentIds[0] // empty')" = "$DEP_ID" ]
step "create agent bruno in department (by its head)" "$?" "HTTP $(st) agent=$AGENT_ID"

res=$(api "$J_DANA" PUT "/api/agents/$AGENT_ID/skills/ping" '{"description":"Reply to ping-style checks","body":"# Ping\n\nWhen asked to reply with a word, reply with exactly that word and nothing else."}')
[ "$(printf '%s' "$res" | jq -r '.name // empty')" = "ping" ]; ok=$?
if [ "$ok" = "0" ]; then
  res=$(api "$J_OWNER" GET "/api/agents/$AGENT_ID/skills/ping")
  printf '%s' "$res" | jq -e '.body | test("reply with exactly that word")' >/dev/null || ok=1
fi
step "put skill + read it back (getSkill)" "$ok" "HTTP $(st)"
[ -f "$DATA_DIR/companies/acme/agents/bruno/skills/ping/SKILL.md" ]; step "SKILL.md exists in the agent home" "$?" "$DATA_DIR/companies/acme/agents/bruno/skills/ping/SKILL.md"

# ── 10. DM ───────────────────────────────────────────────────────────────────
res=$(api "$J_OWNER" POST /api/channels/dm "{\"memberKind\":\"agent\",\"memberId\":\"$AGENT_ID\"}")
DM_ID=$(printf '%s' "$res" | jq -r '.id // empty')
[ -n "$DM_ID" ] && [ "$(printf '%s' "$res" | jq -r '.kind // empty')" = "dm" ]; step "open DM with bruno" "$?" "HTTP $(st) channel=$DM_ID"

# ── 11. post the prompt ──────────────────────────────────────────────────────
res=$(api "$J_OWNER" POST /api/messages "{\"channelId\":\"$DM_ID\",\"body\":\"reply with exactly: pong\"}")
MSG_ID=$(printf '%s' "$res" | jq -r '.id // empty')
MSG_SEQ=$(printf '%s' "$res" | jq -r '.seq // 0')
[ -n "$MSG_ID" ]; step "post \"reply with exactly: pong\"" "$?" "HTTP $(st) message=$MSG_ID"

# wait_reply <after-seq> [channel-id] → sets REPLY (json of the first agent message with
# status=sent and seq > after-seq in that channel — bruno's DM by default — or empty) and
# TASK_STATE ("failed: …" when the agent's message failed).
REPLY=""
TASK_STATE=""
wait_reply() {
  local after="$1" channel="${2:-$DM_ID}" page failed
  REPLY=""; TASK_STATE=""
  local deadline=$(( $(date +%s) + TIMEOUT_S ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    page=$(api "$J_OWNER" GET "/api/messages?channelId=${channel}&limit=20")
    REPLY=$(printf '%s' "$page" | jq -c --argjson after "$after" \
      '[(.items // [])[] | select(.authorKind=="agent" and .status=="sent" and .seq > $after)] | first // empty')
    [ -n "$REPLY" ] && return 0
    failed=$(printf '%s' "$page" | jq -c --argjson after "$after" \
      '[(.items // [])[] | select(.authorKind=="agent" and .status=="failed" and .seq > $after)] | first // empty')
    if [ -n "$failed" ]; then TASK_STATE="failed: $(printf '%s' "$failed" | jq -r '.error // .body')"; return 1; fi
    sleep 2
  done
  TASK_STATE="timed out after ${TIMEOUT_S}s"
  return 1
}
task_line() { # task_line [agent-id] → the newest task of that agent (bruno by default), one line
  api "$J_OWNER" GET "/api/tasks?agentId=${1:-$AGENT_ID}" |
    jq -r '(.items // [])[0] // {} | "task=\(.id) status=\(.status) channelKind=\(.channelKind) sub=\(.subscriptionId // "host-login")"' 2>/dev/null
}

# ── 12. poll for the agent's sent reply ──────────────────────────────────────
if wait_reply "$MSG_SEQ"; then
  body=$(printf '%s' "$REPLY" | jq -r '.body')
  step "agent reply arrived (status sent)" 0 "$(task_line)"
  [ "$(printf '%s' "$body" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')" = "pong" ]
  step "reply body is exactly \"pong\"" "$?" "body=$(printf '%s' "$body" | head -c 80 | tr '\n' ' ')"
else
  step "agent reply arrived (status sent)" 1 "${TASK_STATE}; $(task_line)"
  step "reply body is exactly \"pong\"" 1 "no reply"
  echo "--- last 30 server log lines:"; tail -30 "$LOG"
fi

# ── 13. agent vault: dana (head of bruno's department) adds an agent-scoped item ─
# docs/build-plan-browser-vaults.md acceptance §2–§4: the item is bruno's alone, the company
# vault never lists it, and the value only ever reaches bruno's process through `vault_get`.
AGENT_SECRET="e2e-agent-secret-$(node -e 'process.stdout.write(require("crypto").randomBytes(12).toString("hex"))')"
AGENT_SECRET_LEN=${#AGENT_SECRET}
res=$(api "$J_DANA" POST /api/vault "{\"kind\":\"generic.secret\",\"label\":\"E2E agent secret\",\"secret\":\"$AGENT_SECRET\",\"agentId\":\"$AGENT_ID\"}")
AGENT_VAULT_ID=$(printf '%s' "$res" | jq -r '.id // empty')
[ -n "$AGENT_VAULT_ID" ] && [ "$(printf '%s' "$res" | jq -r '.agentId // empty')" = "$AGENT_ID" ] \
  && [ "$(printf '%s' "$res" | jq -r 'has("secret") or has("ciphertext")')" = "false" ]
step "add agent-vault item as department head (dana)" "$?" "HTTP $(st) item=$AGENT_VAULT_ID hint=$(printf '%s' "$res" | jq -r '.hint // ""')"

res=$(api "$J_OWNER" GET /api/vault)
[ "$(printf '%s' "$res" | jq -r --arg id "$AGENT_VAULT_ID" '[(.items // [])[] | select(.id==$id)] | length')" = "0" ]
step "agent item is absent from the company vault (/vault)" "$?" "HTTP $(st)"

res=$(api "$J_DANA" GET "/api/vault?agentId=$AGENT_ID")
[ "$(printf '%s' "$res" | jq -r --arg id "$AGENT_VAULT_ID" '[(.items // [])[] | select(.id==$id)] | length')" = "1" ]
step "agent item listed under /vault?agentId= (as head)" "$?" "HTTP $(st)"

# ── 14. vault_list → vault_get through the MCP, reply with the length only ───
res=$(api "$J_OWNER" POST /api/messages "{\"channelId\":\"$DM_ID\",\"body\":\"Use the vault_list tool, then vault_get on the item labeled \\\"E2E agent secret\\\". Reply with only the number of characters in its value, written as digits and nothing else. Never write the value itself.\"}")
VAULT_MSG_SEQ=$(printf '%s' "$res" | jq -r '.seq // 0')
[ -n "$(printf '%s' "$res" | jq -r '.id // empty')" ]; step "post the vault_list/vault_get prompt" "$?" "HTTP $(st) expected length=$AGENT_SECRET_LEN"

if wait_reply "$VAULT_MSG_SEQ"; then
  body=$(printf '%s' "$REPLY" | jq -r '.body')
  step "agent reply to the vault prompt arrived" 0 "$(task_line)"
  printf '%s' "$body" | grep -q "$AGENT_SECRET_LEN"
  step "reply contains the value's length ($AGENT_SECRET_LEN)" "$?" "body=$(printf '%s' "$body" | head -c 80 | tr '\n' ' ')"
else
  step "agent reply to the vault prompt arrived" 1 "${TASK_STATE}; $(task_line)"
  step "reply contains the value's length ($AGENT_SECRET_LEN)" 1 "no reply"
  echo "--- last 30 server log lines:"; tail -30 "$LOG"
fi

# The secret must not appear in any message body of the DM (redaction, D5) …
page=$(api "$J_OWNER" GET "/api/messages?channelId=$DM_ID&limit=50")
[ "$(printf '%s' "$page" | jq -r --arg s "$AGENT_SECRET" '[(.items // [])[] | .body | contains($s)] | any')" = "false" ]
step "secret value appears in no message body" "$?" "$(printf '%s' "$page" | jq -r '(.items // []) | length') messages checked"
# … nor in the server log, and the resolve was audited as `tool` in the agent home.
! grep -q "$AGENT_SECRET" "$LOG"; step "secret value appears nowhere in the server log" "$?"
AUDIT="$DATA_DIR/companies/acme/agents/bruno/.taut/audit.log"
grep -q "tool vault=$AGENT_VAULT_ID" "$AUDIT" 2>/dev/null
step "audit.log in the agent home has the 'tool' resolve" "$?" "$AUDIT"

# ── 15. agent vera with browser access: Playwright MCP wired at task time ────
# docs/build-plan-browser-vaults.md acceptance §1. Local provider: needs Chromium from
# `npx playwright install chromium` on this host; the reply proves the `browser` server started.
# `auto-edit` for the same reason as bruno: plan mode rejects `browser_navigate` too.
res=$(api "$J_DANA" POST /api/agents "{\"handle\":\"vera\",\"name\":\"Vera\",\"avatar\":{\"kind\":\"emoji\",\"value\":\"🦊\"},\"role\":\"Research assistant\",\"mandate\":\"# Mandate\\n\\nDo exactly what you are asked, briefly.\",\"runtimeKind\":\"claude-code\",\"permissionMode\":\"auto-edit\",\"departmentId\":\"$DEP_ID\",\"browserAccess\":true}")
VERA_ID=$(printf '%s' "$res" | jq -r '.id // empty')
[ -n "$VERA_ID" ] && [ "$(printf '%s' "$res" | jq -r '.browserAccess')" = "true" ]
step "create agent vera with browser access (by head)" "$?" "HTTP $(st) agent=$VERA_ID browserAccess=$(printf '%s' "$res" | jq -r '.browserAccess')"

res=$(api "$J_OWNER" POST /api/channels/dm "{\"memberKind\":\"agent\",\"memberId\":\"$VERA_ID\"}")
VERA_DM_ID=$(printf '%s' "$res" | jq -r '.id // empty')
[ -n "$VERA_DM_ID" ]; step "open DM with vera" "$?" "HTTP $(st) channel=$VERA_DM_ID"

# The page is this very server's health endpoint on loopback (the local provider runs the agent
# on this host): a real Chromium launch + navigation that needs no DNS or internet. The body is
# `{"ok":true,"version":"<x>"}` (whatever /api/health says at the time), so the expected answer
# is read from the endpoint, not hard-coded.
HEALTH_VERSION=$(curl -s "${BASE}/api/health" | jq -r '.version // empty')
res=$(api "$J_OWNER" POST /api/messages "{\"channelId\":\"$VERA_DM_ID\",\"body\":\"Use your browser tools (browser_navigate, then browser_snapshot) to open ${BASE}/api/health — it shows a small JSON document. Reply with only the value of its \\\"version\\\" field, nothing else. Do not use curl or any other tool.\"}")
VERA_MSG_SEQ=$(printf '%s' "$res" | jq -r '.seq // 0')
[ -n "$(printf '%s' "$res" | jq -r '.id // empty')" ]; step "post the browser prompt to vera" "$?" "HTTP $(st) expected version=$HEALTH_VERSION"

if wait_reply "$VERA_MSG_SEQ" "$VERA_DM_ID"; then
  body=$(printf '%s' "$REPLY" | jq -r '.body')
  step "vera's reply arrived (browser on)" 0 "$(task_line "$VERA_ID")"
  [ -n "$HEALTH_VERSION" ] && printf '%s' "$body" | grep -qF "$HEALTH_VERSION"
  step "reply carries /api/health's version (browser really used)" "$?" "body=$(printf '%s' "$body" | head -c 200 | tr '\n' ' ')"
else
  step "vera's reply arrived (browser on)" 1 "${TASK_STATE}; $(task_line "$VERA_ID")"
  step "reply carries /api/health's version (browser really used)" 1 "no reply"
  echo "--- last 30 server log lines:"; tail -30 "$LOG"
fi

VERA_TASK_ID=$(api "$J_OWNER" GET "/api/tasks?agentId=$VERA_ID" | jq -r '(.items // [])[0].id // empty')
VERA_WORK="$DATA_DIR/companies/acme/agents/vera/work/$VERA_TASK_ID"
jq -e '.mcpServers.taut and .mcpServers.browser and (.mcpServers.browser.args | index("--headless") != null)' "$VERA_WORK/.taut/mcp.json" >/dev/null 2>&1
step "task mcp.json carries the browser server next to taut" "$?" "$VERA_WORK/.taut/mcp.json"
grep -q 'mcp__browser__\*' "$VERA_WORK/CLAUDE.md" 2>/dev/null
step "CLAUDE.md tells vera about the browser tools" "$?"
BRUNO_TASK_ID=$(api "$J_OWNER" GET "/api/tasks?agentId=$AGENT_ID" | jq -r '(.items // [])[0].id // empty')
BRUNO_MCP="$DATA_DIR/companies/acme/agents/bruno/work/$BRUNO_TASK_ID/.taut/mcp.json"
jq -e '.mcpServers | has("browser") | not' "$BRUNO_MCP" >/dev/null 2>&1
step "bruno (browser off) has no browser server" "$?" "$BRUNO_MCP"

# ── 16. attachments (a): a 1×1 PNG to bruno's DM, read from inbox/<messageId>/ ─────────────
# docs/build-plan-attachments.md, verification 2a. Upload (multipart) → send with the id →
# the reply is non-empty and the bytes were materialised into the agent home (D3).
# upload <jar> <channel-id> <file> <name> <mime> → body; HTTP status via `st`.
upload() {
  local jar="$1" channel="$2" file="$3" name="$4" mime="$5" out
  out=$(curl -sS -b "$jar" -c "$jar" -X POST "${BASE}/api/attachments" \
    -F "channelId=${channel}" -F "file=@${file};filename=${name};type=${mime}" -w $'\n%{http_code}')
  printf '%s' "${out##*$'\n'}" >"${DATA_DIR}/.status"
  printf '%s' "${out%$'\n'*}"
}
PIXEL="$DATA_DIR/pixel.png"
# A 64×64 solid red PNG, built here (node's zlib + a CRC table) so no fixture file is needed. A
# 1×1 image is too small for the model to name a colour reliably; 64×64 is unambiguous.
node -e '
const zlib = require("zlib")
const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (b) => { let r = 0xffffffff; for (const x of b) r = table[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
const w = 64, h = 64
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).fill(Buffer.from([255, 0, 0]))])
const raw = Buffer.concat(Array.from({ length: h }, () => row))
require("fs").writeFileSync(process.argv[1], Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]))
' "$PIXEL"
res=$(upload "$J_OWNER" "$DM_ID" "$PIXEL" pixel.png image/png)
PIXEL_ATT_ID=$(printf '%s' "$res" | jq -r '.id // empty')
[ "$(st)" = "201" ] && [ -n "$PIXEL_ATT_ID" ] && [ "$(printf '%s' "$res" | jq -r '.mimeType')" = "image/png" ] \
  && [ "$(printf '%s' "$res" | jq -r '.messageId // "orphan"')" = "orphan" ]
step "upload pixel.png to the DM (orphan, image/png)" "$?" "HTTP $(st) attachment=$PIXEL_ATT_ID"

res=$(api "$J_OWNER" POST /api/messages "{\"channelId\":\"$DM_ID\",\"body\":\"Read the attached image file and reply with its color as one English word, nothing else\",\"attachmentIds\":[\"$PIXEL_ATT_ID\"]}")
PIXEL_MSG_ID=$(printf '%s' "$res" | jq -r '.id // empty')
PIXEL_MSG_SEQ=$(printf '%s' "$res" | jq -r '.seq // 0')
[ -n "$PIXEL_MSG_ID" ] && [ "$(printf '%s' "$res" | jq -r '.attachments[0].name // empty')" = "pixel.png" ] \
  && [ "$(printf '%s' "$res" | jq -r '.attachments[0].messageId // empty')" = "$PIXEL_MSG_ID" ]
step "send the image with attachmentIds (message carries it)" "$?" "HTTP $(st) message=$PIXEL_MSG_ID"

# D5: the bytes come back behind the cookie, inline, with the exact length.
curl -sS -b "$J_OWNER" -o "$DATA_DIR/pixel.back" -D "$DATA_DIR/pixel.headers" "${BASE}/api/attachments/$PIXEL_ATT_ID/content"
cmp -s "$PIXEL" "$DATA_DIR/pixel.back" && grep -qi '^content-type: image/png' "$DATA_DIR/pixel.headers" \
  && grep -qi '^content-disposition: inline' "$DATA_DIR/pixel.headers"
step "content endpoint streams the same bytes (image/png, inline)" "$?" "$(grep -i '^content-disposition' "$DATA_DIR/pixel.headers" | tr -d '\r')"

if wait_reply "$PIXEL_MSG_SEQ"; then
  body=$(printf '%s' "$REPLY" | jq -r '.body')
  step "bruno's reply to the image arrived" 0 "$(task_line)"
  # "non-empty" is not enough: a "permission denied" apology is non-empty too (that is exactly
  # what a run without `--add-dir <home>/inbox` produced). The image is solid red.
  printf '%s' "$body" | grep -Eqi 'red|ff0000|255, *0, *0'
  step "reply names the color red (agent read the image)" "$?" "body=$(printf '%s' "$body" | head -c 120 | tr '\n' ' ')"
else
  step "bruno's reply to the image arrived" 1 "${TASK_STATE}; $(task_line)"
  step "reply names the color red (agent read the image)" 1 "no reply"
  echo "--- last 30 server log lines:"; tail -30 "$LOG"
fi
INBOX_COPY="$DATA_DIR/companies/acme/agents/bruno/inbox/$PIXEL_MSG_ID/pixel.png"
[ -f "$INBOX_COPY" ] && cmp -s "$PIXEL" "$INBOX_COPY"
step "file materialised at <home>/inbox/<messageId>/pixel.png" "$?" "$INBOX_COPY"

# ── 17. attachments (b): bruno sends a file back with taut_send attachments ─────────────────
# Verification 2b: the agent creates work/hello.txt and attaches it; a message in the DM carries
# an attachment named hello.txt whose content endpoint returns `hi` (D4 → D1 → D5).
res=$(api "$J_OWNER" POST /api/messages "{\"channelId\":\"$DM_ID\",\"body\":\"Create the file work/hello.txt in your home containing exactly the two letters hi (no newline). Then call the taut_send tool with to \\\"@owner\\\", text \\\"here is the file\\\" and attachments [\\\"work/hello.txt\\\"]. Then reply with exactly: done\"}")
HELLO_MSG_SEQ=$(printf '%s' "$res" | jq -r '.seq // 0')
[ -n "$(printf '%s' "$res" | jq -r '.id // empty')" ]; step "post the taut_send-attachments prompt" "$?" "HTTP $(st)"

HELLO_ATT_ID=""
if wait_reply "$HELLO_MSG_SEQ"; then
  step "bruno's reply to the file prompt arrived" 0 "$(task_line)"
  # The taut_send message lands before the final reply; give the page a few polls anyway.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    page=$(api "$J_OWNER" GET "/api/messages?channelId=$DM_ID&limit=50")
    HELLO_ATT_ID=$(printf '%s' "$page" | jq -r --argjson after "$HELLO_MSG_SEQ" \
      '[(.items // [])[] | select(.authorKind=="agent" and .seq > $after) | .attachments[]? | select(.name=="hello.txt")] | first | .id // empty')
    [ -n "$HELLO_ATT_ID" ] && break
    sleep 2
  done
else
  step "bruno's reply to the file prompt arrived" 1 "${TASK_STATE}; $(task_line)"
  echo "--- last 30 server log lines:"; tail -30 "$LOG"
fi
[ -n "$HELLO_ATT_ID" ]; step "a DM message from bruno carries an attachment named hello.txt" "$?" "attachment=${HELLO_ATT_ID:-none}"
if [ -n "$HELLO_ATT_ID" ]; then
  got=$(curl -sS -b "$J_OWNER" -D "$DATA_DIR/hello.headers" "${BASE}/api/attachments/$HELLO_ATT_ID/content")
  [ "$(printf '%s' "$got" | tr -d '[:space:]')" = "hi" ] && grep -qi '^content-type: text/plain' "$DATA_DIR/hello.headers"
  step "hello.txt content endpoint returns hi (text/plain)" "$?" "body=$(printf '%s' "$got" | head -c 40)"
else
  step "hello.txt content endpoint returns hi (text/plain)" 1 "no attachment"
fi

echo
echo "e2e: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" = "0" ]
