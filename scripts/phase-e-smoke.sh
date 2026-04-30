#!/usr/bin/env bash
set -euo pipefail

COORDINATOR_URL="${COORDINATOR_URL:-http://127.0.0.1:8787}"
API_TOKEN="${API_TOKEN:-dev-token}"
PROJECT_ID="${PROJECT_ID:-phase-e-smoke}"
ACTOR="${ACTOR:-5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY}"
SUBJECT_EXTERNAL_ID="${SUBJECT_EXTERNAL_ID:-}"
SUBJECT_ID="${SUBJECT_ID:-}"

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "$COORDINATOR_URL$path" \
      -H "Authorization: Bearer $API_TOKEN" \
      -H "Content-Type: application/json" \
      --data "$body"
  else
    curl -fsS -X "$method" "$COORDINATOR_URL$path" \
      -H "Authorization: Bearer $API_TOKEN"
  fi
}

json_field() {
  node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const v=JSON.parse(data)$1; if (v !== undefined && v !== null) console.log(v);})"
}

echo "Creating Phase E governance intent..."
intent_response="$(request POST /governance/intents "{\"projectId\":\"$PROJECT_ID\",\"kind\":\"opengov\",\"title\":\"Phase E smoke proposal\",\"body\":\"Local Phase E smoke submit.\"}")"
intent_id="$(printf '%s' "$intent_response" | json_field '.data.governanceIntent.id')"
echo "Intent: $intent_id"

echo "Submitting intent through coordinator OpenGov action path..."
submit_body="{\"actor\":\"$ACTOR\",\"submitArgs\":{\"proposal\":\"0xphasee\",\"enactment\":\"After\"}}"
if [[ -n "$SUBJECT_EXTERNAL_ID" ]]; then
  submit_body="{\"actor\":\"$ACTOR\",\"externalId\":\"$SUBJECT_EXTERNAL_ID\",\"submitArgs\":{\"proposal\":\"0xphasee\",\"enactment\":\"After\"}}"
fi
submit_response="$(request POST "/governance/intents/$intent_id/submit-opengov" "$submit_body")"
printf '%s\n' "$submit_response" | json_field '.data.receipt.tx.txHash' | sed 's/^/Tx: /'

if [[ -n "$SUBJECT_ID" || -n "$SUBJECT_EXTERNAL_ID" ]]; then
  echo "Reconciling indexed subject..."
  if [[ -n "$SUBJECT_ID" ]]; then
    request POST "/governance/intents/$intent_id/reconcile-subject" "{\"subjectId\":\"$SUBJECT_ID\"}" >/dev/null
  else
    request POST "/governance/intents/$intent_id/reconcile-subject" "{\"externalId\":\"$SUBJECT_EXTERNAL_ID\"}" >/dev/null
  fi
fi

echo "Reading merged view..."
request GET "/governance/merged/merged:$intent_id"

cat <<'EOF'

Next local-chain steps:
1. Start vibly-chain solo-node and vibly-indexer.
2. Rerun with SUBJECT_EXTERNAL_ID=<referendumIndex> after the indexer sees the referendum.
3. Submit a vote with:
   curl -X POST "$COORDINATOR_URL/governance/subjects/<subjectId>/vote-opengov" ...
4. Verify /governance/merged/<subjectId> readback.voteReadbackStatus moves from pending_indexer to indexed.
EOF
