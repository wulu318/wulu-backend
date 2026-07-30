#!/bin/bash
set -e

echo "=== WULU Backend Deploy ==="

if [ ! -f .env ]; then
  echo "ERROR: .env file not found. Copy .env.example and fill in values."
  exit 1
fi

docker compose down 2>/dev/null || true
docker compose build --no-cache
docker compose up -d

echo "=== Waiting for health check ==="
for i in $(seq 1 10); do
  if curl -sf http://localhost:3001/api/health > /dev/null 2>&1; then
    echo "Backend is healthy!"
    break
  fi
  echo "Waiting... ($i/10)"
  sleep 3
done

echo "=== Deploy complete ==="
echo "API: https://ai.005656.xyz/api/health"