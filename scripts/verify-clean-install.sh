#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d "${TMPDIR:-/tmp}/agent-department-clean.XXXXXX")"
project="agent-department-clean-$$"
api_pid=''
web_pid=''

free_port() {
  python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
}
db_port="$(free_port)"
api_port="$(free_port)"
web_port="$(free_port)"

cleanup() {
  if [[ -n "$web_pid" ]]; then kill "$web_pid" 2>/dev/null || true; fi
  if [[ -n "$api_pid" ]]; then kill "$api_pid" 2>/dev/null || true; fi
  POSTGRES_PORT="$db_port" docker compose -p "$project" -f "$stage/infra/compose.yml" down -v >/dev/null 2>&1 || true
  rm -rf "$stage"
}
trap cleanup EXIT INT TERM

rsync -a \
  --exclude .git --exclude .data --exclude dist --exclude node_modules \
  --exclude apps/desktop/node_modules --exclude services/agent-runtime/node_modules \
  "$root/" "$stage/"

cd "$stage"
npm ci
npm --prefix services/agent-runtime ci
POSTGRES_PORT="$db_port" docker compose -p "$project" -f infra/compose.yml up -d --wait
export DATABASE_URL="postgres://agent_department:local-development-only@127.0.0.1:${db_port}/agent_department"
export API_PORT="$api_port"
export WEB_PORT="$web_port"
export DATA_DIR="$stage/.data"
export TRACE_ROOT="$stage/.data/runs"
export OBSIDIAN_VAULT="$stage/.data/obsidian-vault"
npm run db:migrate
npm run build
node --import tsx apps/api/src/index.ts >"$stage/api.log" 2>&1 &
api_pid=$!
./node_modules/.bin/vite --host 127.0.0.1 >"$stage/web.log" 2>&1 &
web_pid=$!

for _ in {1..60}; do
  if curl --fail --silent "http://127.0.0.1:${api_port}/api/health" >/dev/null && curl --fail --silent "http://127.0.0.1:${web_port}/" >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent "http://127.0.0.1:${api_port}/api/health" | grep -q '"database":"connected"'
curl --fail --silent "http://127.0.0.1:${web_port}/" | grep -q '<div id="root"></div>'
curl --fail --silent -H "Origin: http://127.0.0.1:${web_port}" -H 'Sec-Fetch-Site: same-origin' "http://127.0.0.1:${web_port}/api/health" | grep -q '"database":"connected"'
printf 'Clean install verified: PostgreSQL %s, API %s, web %s\n' "$db_port" "$api_port" "$web_port"
