#!/bin/sh

set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
FAILED=0

pass() {
  printf 'OK   %s\n' "$1"
}

fail() {
  printf 'FAIL %s\n' "$1"
  FAILED=1
}

check_schema_sync() {
  website_normalized=$(mktemp)
  bot_normalized=$(mktemp)

  sed '/^[[:space:]]*directUrl[[:space:]]*=/d' \
    "$ROOT/xiaowo-rental/prisma/schema.prisma" > "$website_normalized"
  sed '/^[[:space:]]*directUrl[[:space:]]*=/d' \
    "$ROOT/linebot-rental/prisma/schema.prisma" > "$bot_normalized"

  if diff -q "$website_normalized" "$bot_normalized" >/dev/null; then
    pass "兩份 Prisma schema 同步（忽略 Bot 專用 DIRECT_URL）"
  else
    fail "兩份 Prisma schema 不同步"
    diff -u "$website_normalized" "$bot_normalized" || true
  fi

  rm -f "$website_normalized" "$bot_normalized"
}

check_env_example() {
  project="$1"
  example="$ROOT/$project/.env.example"
  used=$(mktemp)
  documented=$(mktemp)
  missing=$(mktemp)

  {
    rg --no-filename -o 'process\.env\.[A-Z0-9_]+' "$ROOT/$project/src" 2>/dev/null \
      | sed 's/.*process\.env\.//' || true
    rg --no-filename -o 'env\("[A-Z0-9_]+"\)' "$ROOT/$project/prisma" 2>/dev/null \
      | sed -E 's/env\("([A-Z0-9_]+)"\)/\1/' || true
  } | sort -u | sed '/^NODE_ENV$/d' > "$used"

  sed -nE 's/^([A-Z0-9_]+)=.*/\1/p' "$example" | sort -u > "$documented"
  comm -23 "$used" "$documented" > "$missing"

  if [ -s "$missing" ]; then
    fail "$project/.env.example 缺少：$(paste -sd ', ' "$missing")"
  else
    pass "$project/.env.example 已涵蓋程式使用的變數"
  fi

  rm -f "$used" "$documented" "$missing"
}

show_repo_status() {
  project="$1"
  repo="$ROOT/$project"
  changes=$(git -c safe.directory="$repo" -C "$repo" status --short)

  if [ -n "$changes" ]; then
    printf '\nINFO %s 尚未提交的變更：\n%s\n' "$project" "$changes"
  else
    printf '\nINFO %s 工作目錄乾淨\n' "$project"
  fi
}

printf '小蝸系統維護檢查\n\n'
check_schema_sync
check_env_example "xiaowo-rental"
check_env_example "linebot-rental"
show_repo_status "xiaowo-rental"
show_repo_status "linebot-rental"

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf '檢查完成，未發現同步問題。\n'
else
  printf '檢查完成，請先處理上方 FAIL 項目。\n'
fi

exit "$FAILED"
