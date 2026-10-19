#!/usr/bin/env bash
# Disposable PostgreSQL for integration tests. Never points at any other database.
#   scripts/test-pg.sh up     start (or restart) quarry-test-pg on 127.0.0.1:55432 with TLS enabled
#   scripts/test-pg.sh down   remove the container
#   scripts/test-pg.sh env    print the env vars the integration tests read
# Credentials and the self-signed certificate are generated fresh under target/test-pg/ (gitignored).
set -euo pipefail

NAME=quarry-test-pg
PORT=55432
IMAGE=postgres:16-alpine
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/target/test-pg"

up() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  mkdir -p "$DIR"
  umask 077
  openssl rand -hex 16 > "$DIR/password"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=localhost" \
    -keyout "$DIR/server.key" -out "$DIR/server.crt" >/dev/null 2>&1
  # The image entrypoint runs as root first, so it can install the key with postgres ownership.
  docker run -d --rm --name "$NAME" \
    -p "127.0.0.1:$PORT:5432" \
    -e POSTGRES_USER=quarry -e POSTGRES_DB=quarry_test \
    -e POSTGRES_PASSWORD="$(cat "$DIR/password")" \
    -v "$DIR:/certs:ro" \
    --entrypoint sh "$IMAGE" -c '
      install -o postgres -m 600 /certs/server.key /tmp/server.key &&
      install -o postgres -m 644 /certs/server.crt /tmp/server.crt &&
      exec docker-entrypoint.sh postgres -c ssl=on \
        -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key' >/dev/null
  for _ in $(seq 1 60); do
    if docker exec "$NAME" pg_isready -U quarry -d quarry_test -h 127.0.0.1 >/dev/null 2>&1; then
      echo "$NAME ready on 127.0.0.1:$PORT"
      return 0
    fi
    sleep 1
  done
  echo "$NAME did not become ready" >&2
  docker logs "$NAME" >&2 || true
  return 1
}

case "${1:-}" in
  up) up ;;
  down) docker rm -f "$NAME" >/dev/null 2>&1 && echo "$NAME removed" || echo "$NAME not running" ;;
  env)
    echo "QUARRY_TEST_PG_HOST=127.0.0.1"
    echo "QUARRY_TEST_PG_PORT=$PORT"
    echo "QUARRY_TEST_PG_USER=quarry"
    echo "QUARRY_TEST_PG_DB=quarry_test"
    echo "QUARRY_TEST_PG_PASSWORD_FILE=$DIR/password"
    ;;
  *) echo "usage: $0 up|down|env" >&2; exit 2 ;;
esac
