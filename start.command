#!/bin/zsh
set -e
cd "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  toolchain="../ylab-dsh-lab/toolchains/node-v22.19.0-darwin-arm64/bin"
  if [[ -x "$toolchain/node" ]]; then
    export PATH="${PWD}/${toolchain}:$PATH"
  else
    print '请安装 Node.js 22.19+，再重新启动。'
    exit 1
  fi
fi
docker compose -p agent-department -f infra/compose.yml up -d --wait
if [[ ! -d node_modules ]]; then npm ci; fi
if [[ ! -d services/agent-runtime/node_modules ]]; then npm --prefix services/agent-runtime ci; fi
print '打开 http://127.0.0.1:4310 使用为伍 · 一个想法，一支团队'
npm run dev
