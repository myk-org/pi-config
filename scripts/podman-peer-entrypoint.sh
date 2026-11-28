#!/usr/bin/env bash
set -euo pipefail

# 1. Seed writable ~/.gitconfig from read-only seed (never mutate a :ro mount)
if [ -r /opt/gitconfig.seed ]; then
  cp /opt/gitconfig.seed /home/peer/.gitconfig
  chmod 600 /home/peer/.gitconfig
fi
# Ensure safe.directory=* so bind-mounted repos never fail git status/branch checks
git config --global --get-all safe.directory 2>/dev/null | grep -qxF '*' || git config --global --add safe.directory '*'
# Warm git index before Pi starts so initial git status reports branch immediately
git status --porcelain=v1 -b >/dev/null 2>&1 || true

# 2. Ensure writable global gitignore with exact line entries (.pi/ and .worktrees/)
GITIGNORE_PATH="/home/peer/.config/git/ignore"
mkdir -p "$(dirname "$GITIGNORE_PATH")"
touch "$GITIGNORE_PATH"
git config --global core.excludesfile "$GITIGNORE_PATH"
for entry in ".pi/" ".worktrees/"; do
  if ! grep -qxF "$entry" "$GITIGNORE_PATH"; then
    printf '%s\n' "$entry" >> "$GITIGNORE_PATH"
  fi
done

# 3. Configure git HTTPS auth via gh if a GitHub token is provided (zero ~/.ssh, never print token)
if [ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]; then
  if ! gh auth setup-git >/dev/null 2>&1; then
    echo "[entrypoint] warning: gh auth setup-git returned non-zero (continuing)" >&2
  fi
fi

# 4. Launch Pi in RPC + COMS mode with Node stdin-holder keeping stdin open & draining stdout.
#    No socat: PI_PIDASH_HOST and PI_PIDIFF_HOST connect directly to host.containers.internal.
exec node -e '
const { spawn } = require("node:child_process");
const cname = process.env.PI_PEER_CNAME;
const project = process.env.PI_PEER_PROJECT || "default";
if (!cname) {
  process.stderr.write("[entrypoint] PI_PEER_CNAME is required\n");
  process.exit(2);
}
const args = ["--mode", "rpc", "--coms", "--cname", cname, "--project", project];
if (process.env.PI_PEER_PURPOSE) args.push("--purpose", process.env.PI_PEER_PURPOSE);
if (process.env.PI_PEER_SESSION) args.push("--session", process.env.PI_PEER_SESSION);

const child = spawn("pi", args, { stdio: ["pipe", "pipe", "inherit"] });
child.stdout.on("data", () => {});
child.on("error", (err) => {
  process.stderr.write(`[entrypoint] failed to spawn pi: ${err.message}\n`);
  process.exit(1);
});
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    try { child.kill(sig); } catch {}
  });
}
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 128 : 0));
});
'
