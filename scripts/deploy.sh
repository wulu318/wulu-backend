#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# WULU SuperAgent Backend — One-Click Deployment Script
#
# Usage (on a fresh Ubuntu/Debian server as root):
#   curl -fsSL https://raw.githubusercontent.com/wulu318/wulu-backend/main/scripts/deploy.sh | bash
# or after cloning the repo:
#   bash scripts/deploy.sh
#
# What it does:
#   1. Installs Node.js 22 LTS + PM2 (if missing)
#   2. Clones/updates the backend code to /www/wwwroot/wulu-backend
#   3. Installs npm dependencies (npmmirror registry for speed)
#   4. Creates .env (idempotent — keeps existing config)
#   5. Starts the service with PM2 + enables boot autostart
#   6. Opens the service port in ufw (default 3001)
#   7. Runs a health check
#
# Re-running is safe: it updates code and restarts PM2.
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

APP_NAME="wulu-backend"
APP_DIR="/www/wwwroot/wulu-backend"
REPO_URL="https://github.com/wulu318/wulu-backend.git"
PORT="${WULU_PORT:-3001}"
NODE_MAJOR=22

log()  { echo -e "\033[32m[deploy]\033[0m $*"; }
warn() { echo -e "\033[33m[warn]\033[0m $*"; }
fail() { echo -e "\033[31m[error]\033[0m $*" >&2; exit 1; }

# ── 1. Node.js ────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt $NODE_MAJOR ]]; then
  log "Installing Node.js ${NODE_MAJOR} via NodeSource..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh >/dev/null 2>&1
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs >/dev/null
fi
log "Node.js $(node -v), npm $(npm -v)"

# ── 2. PM2 ────────────────────────────────────────────────────────
if ! command -v pm2 >/dev/null 2>&1; then
  log "Installing PM2..."
  npm install -g pm2 --registry=https://registry.npmmirror.com >/dev/null 2>&1
fi
log "PM2 $(pm2 -v)"

# ── 3. Code ───────────────────────────────────────────────────────
mkdir -p /www/wwwroot
if [ -d "$APP_DIR/.git" ]; then
  log "Updating existing code at $APP_DIR..."
  git -C "$APP_DIR" fetch --all >/dev/null 2>&1 || warn "git fetch failed, continuing with existing code"
  git -C "$APP_DIR" reset --hard origin/HEAD >/dev/null 2>&1 || true
  git -C "$APP_DIR" clean -fd -e data -e .env -e public/runtime >/dev/null 2>&1 || true
else
  if [ -d "$APP_DIR" ]; then
    warn "$APP_DIR exists without .git — backing up data and redeploying"
    cp -a "$APP_DIR/data" /tmp/wulu-data-backup-$(date +%s) 2>/dev/null || true
    cp -a "$APP_DIR/.env" /tmp/wulu-env-backup-$(date +%s) 2>/dev/null || true
    cp -a "$APP_DIR/public/runtime" /tmp/wulu-runtime-backup-$(date +%s) 2>/dev/null || true
    rm -rf "$APP_DIR"
  fi
  log "Cloning $REPO_URL ..."
  git clone --depth 1 "$REPO_URL" "$APP_DIR" >/dev/null 2>&1
fi
[ -f "$APP_DIR/src/index.js" ] || fail "Backend code not found at $APP_DIR/src/index.js"

# ── 4. Dependencies ───────────────────────────────────────────────
log "Installing npm dependencies..."
cd "$APP_DIR"
npm install --registry=https://registry.npmmirror.com --omit=dev >/dev/null 2>&1 \
  || npm install --omit=dev >/dev/null 2>&1 \
  || fail "npm install failed"
node -e "require('better-sqlite3')(':memory:').exec('CREATE TABLE t(a)')" \
  || fail "better-sqlite3 native module failed to load"

# ── 5. .env ───────────────────────────────────────────────────────
if [ ! -f "$APP_DIR/.env" ]; then
  log "Creating .env (defaults — edit $APP_DIR/.env to customize)..."
  cat > "$APP_DIR/.env" <<EOF
PORT=$PORT
JWT_SECRET=wulu-superagent-jwt-secret-2026-prod
ADMIN_EMAIL=ai@ai.005656.xyz
ADMIN_PASSWORD=Wulu2026Admin
NEWAPI_BASE_URL=https://api.newapi.com
NEWAPI_API_KEY=sk-placeholder
DATABASE_PATH=./data/wulu.db
EOF
  chmod 600 "$APP_DIR/.env"
else
  log ".env already exists — keeping existing config"
fi

# ── 6. PM2 ────────────────────────────────────────────────────────
cd "$APP_DIR"
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start src/index.js --name "$APP_NAME" --time >/dev/null
pm2 save >/dev/null
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || warn "pm2 startup already configured"
sleep 3

# ── 7. Firewall ───────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${PORT}/tcp" >/dev/null 2>&1 || warn "ufw allow failed (check BT panel firewall)"
  log "ufw: port ${PORT} allowed"
else
  log "ufw inactive — remember to open port ${PORT} in your panel/security group"
fi

# ── 8. Health check ───────────────────────────────────────────────
log "Health check..."
if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
  log "Service is UP on port ${PORT}"
else
  pm2 logs "$APP_NAME" --lines 30 --nostream || true
  fail "Health check failed — inspect logs above"
fi

echo ""
log "══════════════════════════════════════════════════════"
log " Deployment complete!"
log "   Local:    http://127.0.0.1:${PORT}"
log "   Public:   http://<server-ip>:${PORT}"
log "   Admin:    http://<server-ip>:${PORT}/admin.html"
log "   API:      http://<server-ip>:${PORT}/api/health"
log "══════════════════════════════════════════════════════"
log "Next steps:"
log "  1. Reverse-proxy a domain (e.g. ai.005656.xyz) to 127.0.0.1:${PORT} in BT Panel"
log "  2. Upload static assets to public/runtime/ (runtime zips, kit bundles, icons)"
log "  3. Configure client keys via Admin → System (/api/admin/config)"
