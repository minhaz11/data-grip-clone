#!/usr/bin/env bash
# Soak run against the disposable server: a large result paged, sorted, filtered and exported in
# rounds while resident memory is sampled (crates/db-postgres/tests/soak_pg.rs).
#
#   scripts/soak.sh                 2 minutes, 1,000,000 rows
#   scripts/soak.sh 60 10000000     one hour, 10,000,000 rows
#
# Needs `scripts/test-pg.sh up`. Prints one line per round and fails if memory keeps growing.
set -euo pipefail
cd "$(dirname "$0")/.."
export QUARRY_SOAK_MINUTES="${1:-2}"
export QUARRY_SOAK_ROWS="${2:-1000000}"
exec cargo test -p quarry-db-postgres --release --test soak_pg -- --ignored --nocapture
