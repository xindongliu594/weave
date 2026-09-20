#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -p agent-department -f infra/compose.yml up -d --wait
exec node --import tsx apps/api/src/index.ts
