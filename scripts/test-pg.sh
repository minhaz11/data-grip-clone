#!/usr/bin/env bash
# Disposable PostgreSQL (and an SSH server in front of it) for integration tests. Never points at
# any other database.
#   scripts/test-pg.sh up     start (or restart) quarry-test-pg on 127.0.0.1:55432 with TLS enabled,
#                             and quarry-test-ssh (sshd with TCP forwarding) on 127.0.0.1:52222
#   scripts/test-pg.sh seed   (re)create a small sample schema "shop" (cursor tests need it; also for browsing)
#   scripts/test-pg.sh down   remove both containers and their network
#   scripts/test-pg.sh env    print the env vars the integration tests read
# Throwaway secrets and certificates live under target/test-pg/ (gitignored): the database
# password (kept across restarts), a test CA with a server certificate (localhost, 127.0.0.1) and a
# client certificate for the role quarry_cert, and SSH keys (a fixed host key; client keys with and
# without a passphrase).
set -euo pipefail

NAME=quarry-test-pg
SSH_NAME=quarry-test-ssh
NETWORK=quarry-test-net
PORT=55432
SSH_PORT=52222
IMAGE=postgres:16-alpine
SSH_IMAGE=alpine:3.20
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/target/test-pg"

certs() {
  local tls="$DIR/tls"
  mkdir -p "$tls"
  # A private CA, so verify-full can succeed with a CA file and client certificates can be tested.
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Quarry Test CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$tls/ca.key" -out "$tls/ca.crt" >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
    -keyout "$DIR/server.key" -out "$tls/server.csr" >/dev/null 2>&1
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > "$tls/server.ext"
  openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
    -days 2 -extfile "$tls/server.ext" -out "$DIR/server.crt" >/dev/null 2>&1
  cp "$tls/ca.crt" "$DIR/ca.crt"
  # Client certificate for the role that authenticates with "cert" (CN = role name).
  openssl req -newkey rsa:2048 -nodes -subj "/CN=quarry_cert" \
    -keyout "$tls/client.key" -out "$tls/client.csr" >/dev/null 2>&1
  printf 'extendedKeyUsage=clientAuth\n' > "$tls/client.ext"
  openssl x509 -req -in "$tls/client.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
    -days 2 -extfile "$tls/client.ext" -out "$tls/client.crt" >/dev/null 2>&1
  # A CA nothing was signed with, to prove a wrong CA file is refused.
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Other CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -keyout "$tls/other-ca.key" -out "$tls/other-ca.crt" >/dev/null 2>&1
}

ssh_keys() {
  local ssh="$DIR/ssh"
  mkdir -p "$ssh"
  # Fixed across restarts so a trusted host key stays valid; delete target/test-pg/ to rotate.
  [ -s "$ssh/host_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C quarry-test-host -f "$ssh/host_ed25519"
  [ -s "$ssh/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C quarry-test -f "$ssh/id_ed25519"
  [ -s "$ssh/passphrase" ] || openssl rand -hex 12 > "$ssh/passphrase"
  [ -s "$ssh/id_ed25519_enc" ] ||
    ssh-keygen -q -t ed25519 -N "$(cat "$ssh/passphrase")" -C quarry-test-enc -f "$ssh/id_ed25519_enc"
  [ -s "$ssh/password" ] || openssl rand -hex 12 > "$ssh/password"
  cat "$ssh/id_ed25519.pub" "$ssh/id_ed25519_enc.pub" > "$ssh/authorized_keys"
  ssh-keygen -l -E sha256 -f "$ssh/host_ed25519.pub" | awk '{print $2}' > "$ssh/host_fingerprint"
}

up() {
  docker rm -f "$NAME" "$SSH_NAME" >/dev/null 2>&1 || true
  docker network create "$NETWORK" >/dev/null 2>&1 || true
  mkdir -p "$DIR"
  umask 077
  # Keep the throwaway password across restarts so saved test profiles keep working;
  # delete target/test-pg/ to rotate it.
  [ -s "$DIR/password" ] || openssl rand -hex 16 > "$DIR/password"
  certs
  ssh_keys
  # The image entrypoint runs as root first, so it can install the key with postgres ownership.
  # The init script lets quarry_cert log in with its client certificate only (hostssl + cert).
  cat > "$DIR/init-cert.sh" <<'INIT'
#!/bin/sh
set -e
psql -v ON_ERROR_STOP=1 -U quarry -d quarry_test -c "CREATE ROLE quarry_cert LOGIN"
{ echo "hostssl all quarry_cert all cert"; cat "$PGDATA/pg_hba.conf"; } > /tmp/pg_hba.conf
cp /tmp/pg_hba.conf "$PGDATA/pg_hba.conf"
INIT
  chmod 755 "$DIR/init-cert.sh"
  docker run -d --restart unless-stopped --name "$NAME" \
    --network "$NETWORK" --network-alias pg \
    -p "127.0.0.1:$PORT:5432" \
    -e POSTGRES_USER=quarry -e POSTGRES_DB=quarry_test \
    -e POSTGRES_PASSWORD="$(cat "$DIR/password")" \
    -v "$DIR:/certs:ro" \
    --entrypoint sh "$IMAGE" -c '
      install -o postgres -m 600 /certs/server.key /tmp/server.key &&
      install -o postgres -m 644 /certs/server.crt /tmp/server.crt &&
      install -o postgres -m 644 /certs/ca.crt /tmp/ca.crt &&
      install -m 755 /certs/init-cert.sh /docker-entrypoint-initdb.d/init-cert.sh &&
      exec docker-entrypoint.sh postgres -c ssl=on \
        -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key \
        -c ssl_ca_file=/tmp/ca.crt' >/dev/null
  # sshd with TCP forwarding, a fixed host key, key and password logins for user "quarry".
  docker run -d --restart unless-stopped --name "$SSH_NAME" \
    --network "$NETWORK" \
    -p "127.0.0.1:$SSH_PORT:22" \
    -e SSH_PASSWORD="$(cat "$DIR/ssh/password")" \
    -v "$DIR/ssh:/keys:ro" \
    "$SSH_IMAGE" sh -c '
      apk add --no-cache openssh-server >/dev/null &&
      adduser -D -s /bin/sh quarry && echo "quarry:$SSH_PASSWORD" | chpasswd &&
      install -d -o quarry -m 700 /home/quarry/.ssh &&
      install -o quarry -m 600 /keys/authorized_keys /home/quarry/.ssh/authorized_keys &&
      install -m 600 /keys/host_ed25519 /etc/ssh/ssh_host_ed25519_key &&
      exec /usr/sbin/sshd -D -e -h /etc/ssh/ssh_host_ed25519_key \
        -o AllowTcpForwarding=yes -o PasswordAuthentication=yes -o PubkeyAuthentication=yes' \
    >/dev/null
  for _ in $(seq 1 60); do
    if docker exec "$NAME" pg_isready -U quarry -d quarry_test -h 127.0.0.1 >/dev/null 2>&1 &&
      docker exec "$SSH_NAME" sh -c 'nc -z 127.0.0.1 22' >/dev/null 2>&1; then
      echo "$NAME ready on 127.0.0.1:$PORT; $SSH_NAME ready on 127.0.0.1:$SSH_PORT"
      return 0
    fi
    sleep 1
  done
  echo "$NAME or $SSH_NAME did not become ready" >&2
  docker logs "$NAME" >&2 || true
  docker logs "$SSH_NAME" >&2 || true
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
  down)
    docker rm -f "$NAME" "$SSH_NAME" >/dev/null 2>&1 && echo "$NAME and $SSH_NAME removed" ||
      echo "$NAME not running"
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
    ;;
  env)
    echo "QUARRY_TEST_PG_HOST=127.0.0.1"
    echo "QUARRY_TEST_PG_PORT=$PORT"
    echo "QUARRY_TEST_PG_USER=quarry"
    echo "QUARRY_TEST_PG_DB=quarry_test"
    echo "QUARRY_TEST_PG_PASSWORD_FILE=$DIR/password"
    echo "QUARRY_TEST_SSH=127.0.0.1:$SSH_PORT (user quarry; keys and password in $DIR/ssh)"
    ;;
  *) echo "usage: $0 up|seed|down|env" >&2; exit 2 ;;
esac
