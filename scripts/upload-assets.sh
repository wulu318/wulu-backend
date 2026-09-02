#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# WULU SuperAgent Backend — Static Assets Uploader
#
# Uploads runtime zips / kit bundles / icons from a local directory
# to the server's public/runtime/ folder, then prints SHA256 for
# updating /api/admin/config.
#
# Usage:
#   bash scripts/upload-assets.sh <local-assets-dir> [user@host]
# Requires: ssh key or sshpass configured for the target host.
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

ASSETS_DIR="${1:-.}"
TARGET="${2:-root@107.149.159.174}"
REMOTE_DIR="/www/wwwroot/wulu-backend/public/runtime"

log() { echo -e "\033[32m[assets]\033[0m $*"; }

[ -d "$ASSETS_DIR" ] || { echo "Assets dir not found: $ASSETS_DIR"; exit 1; }

log "Uploading assets from $ASSETS_DIR to $TARGET:$REMOTE_DIR"
ssh "$TARGET" "mkdir -p $REMOTE_DIR"
scp "$ASSETS_DIR"/*.zip "$ASSETS_DIR"/*.png "$TARGET:$REMOTE_DIR/" 2>/dev/null || \
  scp "$ASSETS_DIR"/*.zip "$TARGET:$REMOTE_DIR/"

log "Remote checksums:"
ssh "$TARGET" "cd $REMOTE_DIR && sha256sum *.zip *.png 2>/dev/null"

log "Done. Update /api/admin/config with the printed SHA256 values"
log "  (Admin dashboard → System → Runtime/Kit keys)"
