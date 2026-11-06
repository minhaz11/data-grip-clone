#!/usr/bin/env bash
# Prints status and checkbox progress for each step plan in docs/plans/.
set -euo pipefail

plans_dir="$(cd "$(dirname "$0")/../docs/plans" && pwd)"
total_done=0
total_all=0

printf '%-40s %-12s %9s %5s\n' "Step" "Status" "Done" "%"
for file in "$plans_dir"/[0-9][0-9]-*.md; do
  name="$(basename "$file" .md)"
  status="$(grep -m1 -E '^\| Status ' "$file" | awk -F'|' '{gsub(/^ +| +$/, "", $3); print $3}')"
  done_count="$(grep -cE '^\s*- \[[xX]\]' "$file" || true)"
  open_count="$(grep -cE '^\s*- \[ \]' "$file" || true)"
  all=$((done_count + open_count))
  pct=0
  if [ "$all" -gt 0 ]; then
    pct=$((done_count * 100 / all))
  fi
  total_done=$((total_done + done_count))
  total_all=$((total_all + all))
  printf '%-40s %-12s %4s/%-4s %4s%%\n' "$name" "${status:-?}" "$done_count" "$all" "$pct"
done

overall=0
if [ "$total_all" -gt 0 ]; then
  overall=$((total_done * 100 / total_all))
fi
printf '\n%-40s %-12s %4s/%-4s %4s%%\n' "Overall" "" "$total_done" "$total_all" "$overall"
