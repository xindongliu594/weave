#!/bin/bash
set -euo pipefail
server_alias="${AGENT_SSH_HOST:-ai-mortgage-server}"
socket_path=/opt/agent-department/run/api.sock
ssh_options=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes)
# Only one launchd job owns this socket. Remove a stale socket before reconnecting.
/usr/bin/ssh "${ssh_options[@]}" "$server_alias" "rm -f '$socket_path'"
exec /usr/bin/ssh -nT "${ssh_options[@]}" -R "$socket_path:127.0.0.1:4311" "$server_alias" \
  "chown root:101 '$socket_path' && chmod 660 '$socket_path' && exec sleep infinity"
