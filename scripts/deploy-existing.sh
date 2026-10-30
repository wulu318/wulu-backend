#!/usr/bin/env bash
# Update an existing BaoTa/PM2 installation without changing system services,
# Node installations, DNS, firewall rules, credentials or reverse proxies.
set -euo pipefail
umask 077
APP_NAME="${WULU_APP_NAME:-wulu-backend}"
REF="${WULU_REF:-main}"
[[ "$REF" =~ ^[a-zA-Z0-9._/-]+$ ]] || { echo 'Invalid deployment ref' >&2; exit 1; }
WORK_DIR="$(mktemp -d /tmp/wulu-deploy.XXXXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

# BaoTa may install Node outside the login shell's PATH.
if ! command -v pm2 >/dev/null; then
  for candidate in /www/server/nodejs/*/bin/pm2; do
    if [[ -x "$candidate" ]]; then export PATH="$(dirname "$candidate"):$PATH"; break; fi
  done
fi
command -v pm2 >/dev/null || { echo 'Existing PM2 not found; no changes made.' >&2; exit 1; }
pm2 jlist > "$WORK_DIR/processes.json"
node - "$WORK_DIR/processes.json" "$APP_NAME" > "$WORK_DIR/selected.json" <<'JS'
const fs = require('fs');
const list = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const app = list.find(p => p.name === process.argv[3]);
if (!app || !app.pm2_env.pm_cwd) throw new Error('Existing backend process not found; no changes made');
fs.writeFileSync(process.argv[2] + '.selected', JSON.stringify(app));
console.log(JSON.stringify({ directory: app.pm2_env.pm_cwd, id: app.pm_id, interpreter: app.pm2_env.exec_interpreter }));
JS
APP_DIR="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).directory' "$WORK_DIR/selected.json")"
PROCESS_ID="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).id' "$WORK_DIR/selected.json")"
INTERPRETER="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).interpreter' "$WORK_DIR/selected.json")"
if [[ "$INTERPRETER" == /* && -x "$INTERPRETER" ]]; then export PATH="$(dirname "$INTERPRETER"):$PATH"; fi
[[ -f "$APP_DIR/.env" && -f "$APP_DIR/src/index.js" ]] || { echo 'Existing configuration/source missing; no changes made.' >&2; exit 1; }
echo "[deploy] Existing app: $APP_DIR (PM2 $PROCESS_ID); using $(node -v)"
curl --fail --silent --show-error --location --retry 3 \
  "https://api.github.com/repos/wulu318/wulu-backend/commits/$REF" > "$WORK_DIR/commit.json"
COMMIT="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).sha' "$WORK_DIR/commit.json")"
[[ "$COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo 'Could not resolve deployment commit' >&2; exit 1; }
curl --fail --silent --show-error --location --retry 3 \
  "https://codeload.github.com/wulu318/wulu-backend/tar.gz/$COMMIT" -o "$WORK_DIR/source.tar.gz"
mkdir "$WORK_DIR/source"
tar -xzf "$WORK_DIR/source.tar.gz" -C "$WORK_DIR/source" --strip-components=1
cd "$WORK_DIR/source"
echo '[deploy] Preparing dependencies before touching the running app'
npm install --omit=dev --no-audit --no-fund
node -e 'require("better-sqlite3")(":memory:").exec("CREATE TABLE t(a)")'
printf '%s\n' "$COMMIT" > REVISION

BACKUP_DIR="$APP_DIR/.deploy-backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$BACKUP_DIR"
# Source/config backup excludes user assets, which remain in place throughout.
tar -czf "$BACKUP_DIR/source.tar.gz" -C "$APP_DIR" \
  --exclude='./node_modules' --exclude='./data' --exclude='./.git' \
  --exclude='./.deploy-backups' --exclude='./public/runtime' .
# SQLite's online backup includes committed WAL transactions; copying the db
# file alone would not provide a consistent backup of a running service.
node - "$APP_DIR" "$BACKUP_DIR" "$WORK_DIR/processes.json.selected" <<'JS'
const fs = require('fs'), path = require('path');
const directory = process.argv[2], backup = process.argv[3];
const saved = JSON.parse(fs.readFileSync(process.argv[4], 'utf8')).pm2_env;
const env = require(path.join(directory, 'node_modules/dotenv')).parse(fs.readFileSync(path.join(directory, '.env')));
const filename = path.resolve(directory, saved.DATABASE_PATH || env.DATABASE_PATH || './data/wulu.db');
if (!fs.existsSync(filename)) throw new Error('Existing database not found; refusing a deployment that might create an empty database');
const db = require(path.join(directory, 'node_modules/better-sqlite3'))(filename, { readonly: true });
db.backup(path.join(backup, 'database.sqlite')).then(() => db.close()).catch(error => { console.error(error.message); process.exitCode = 1; });
fs.writeFileSync(path.join(backup, 'port'), String(saved.PORT || env.PORT || 3001));
JS
PORT="$(cat "$BACKUP_DIR/port")"
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo 'Invalid configured port' >&2; exit 1; }
CHANGED=0
rollback() {
  local result=$?
  trap - ERR
  if [[ "$CHANGED" == 1 ]]; then
    echo "[deploy] Deployment failed; restoring source/dependencies from $BACKUP_DIR" >&2
    tar -xzf "$BACKUP_DIR/source.tar.gz" -C "$APP_DIR"
    if [[ -d "$BACKUP_DIR/node_modules" ]]; then
      mv "$APP_DIR/node_modules" "$WORK_DIR/failed-node_modules" 2>/dev/null || true
      mv "$BACKUP_DIR/node_modules" "$APP_DIR/node_modules"
    fi
    pm2 restart "$PROCESS_ID" >/dev/null || true
  fi
  exit "$result"
}
trap rollback ERR
CHANGED=1
mv "$APP_DIR/node_modules" "$BACKUP_DIR/node_modules"
mv "$WORK_DIR/source/node_modules" "$APP_DIR/node_modules"
# Overlay repository files. Never delete .env, data, uploaded assets or local files.
tar -cf - --exclude='./.git' --exclude='./.env' --exclude='./data' \
  --exclude='./public/runtime' --exclude='./node_modules' -C "$WORK_DIR/source" . | tar -xf - -C "$APP_DIR"
pm2 restart "$PROCESS_ID" >/dev/null
HEALTH_OK=0
for attempt in {1..20}; do
  if curl --fail --silent "http://127.0.0.1:$PORT/api/health" > "$WORK_DIR/health.json" \
    && curl --fail --silent "http://127.0.0.1:$PORT/api/community/capabilities" > /dev/null; then
    if node -e 'const h=JSON.parse(require("fs").readFileSync(process.argv[1])); process.exit(h.commit===process.argv[2]?0:1)' "$WORK_DIR/health.json" "$COMMIT"; then HEALTH_OK=1; break; fi
  fi
  sleep 1
done
[[ "$HEALTH_OK" == 1 ]]
trap - ERR
echo "[deploy] Running commit $COMMIT; health and community APIs verified. Backup: $BACKUP_DIR"
