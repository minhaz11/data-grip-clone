#!/usr/bin/env bash
# Disposable PostgreSQL for integration tests. Never points at any other database.
#   scripts/test-pg.sh up     start (or restart) quarry-test-pg on 127.0.0.1:55432 with TLS enabled
#   scripts/test-pg.sh seed   (re)create a small sample schema "shop" for manual browsing
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

seed() {
  docker exec -i "$NAME" psql -q -v ON_ERROR_STOP=1 -U quarry -d quarry_test <<'SQL'
DROP SCHEMA IF EXISTS shop CASCADE;
CREATE SCHEMA shop;
COMMENT ON SCHEMA shop IS 'Sample data for manual testing';
CREATE TABLE shop.customers (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  full_name  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE shop.products (
  id          bigserial PRIMARY KEY,
  sku         text NOT NULL UNIQUE,
  name        text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0)
);
CREATE TABLE shop.orders (
  id          bigserial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES shop.customers (id),
  status      text NOT NULL DEFAULT 'pending',
  placed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer_idx ON shop.orders (customer_id, placed_at DESC);
CREATE TABLE shop.order_items (
  order_id   bigint NOT NULL REFERENCES shop.orders (id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES shop.products (id),
  quantity   integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_id, product_id)
);
COMMENT ON TABLE shop.order_items IS 'Line items of an order';
CREATE VIEW shop.order_totals AS
  SELECT o.id AS order_id, sum(i.quantity * p.price_cents) AS total_cents
  FROM shop.orders o JOIN shop.order_items i ON i.order_id = o.id JOIN shop.products p ON p.id = i.product_id
  GROUP BY o.id;
CREATE MATERIALIZED VIEW shop.daily_sales AS
  SELECT date_trunc('day', o.placed_at) AS day, count(*) AS orders FROM shop.orders o GROUP BY 1;
INSERT INTO shop.customers (email, full_name)
  SELECT 'user' || g || '@example.test', 'User ' || g FROM generate_series(1, 50) g;
INSERT INTO shop.products (sku, name, price_cents)
  SELECT 'SKU-' || g, 'Product ' || g, (g * 137) % 10000 FROM generate_series(1, 20) g;
SQL
  echo "seeded schema shop in $NAME"
}

case "${1:-}" in
  up) up ;;
  seed) seed ;;
  down) docker rm -f "$NAME" >/dev/null 2>&1 && echo "$NAME removed" || echo "$NAME not running" ;;
  env)
    echo "QUARRY_TEST_PG_HOST=127.0.0.1"
    echo "QUARRY_TEST_PG_PORT=$PORT"
    echo "QUARRY_TEST_PG_USER=quarry"
    echo "QUARRY_TEST_PG_DB=quarry_test"
    echo "QUARRY_TEST_PG_PASSWORD_FILE=$DIR/password"
    ;;
  *) echo "usage: $0 up|seed|down|env" >&2; exit 2 ;;
esac
