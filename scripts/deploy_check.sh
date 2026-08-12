#!/bin/bash
set -euo pipefail

REPO_DIR="/root/instagram-downloader"
DISCORD_WEBHOOK="https://discord.com/api/webhooks/1537085413632639046/Cqsi3GXlW2_EBVVPo20NYCuTBMa0BULquVWU7Jtk71a2V37scbGbMhd83cqDvaEs7OKj"

cd "$REPO_DIR"

git fetch origin main --quiet

LOCAL_HEAD=$(git rev-parse main)
REMOTE_HEAD=$(git rev-parse origin/main)

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  exit 0
fi

CHANGED_FILES=$(git diff --name-only "$LOCAL_HEAD" "$REMOTE_HEAD")

git checkout main --quiet
git merge --ff-only origin/main --quiet

if echo "$CHANGED_FILES" | grep -q "^package.json$\|^package-lock.json$"; then
  npm install --production --quiet
fi

if node -c server.js 2>/tmp/deploy_check_syntax_err; then
  systemctl restart instagram-downloader.service
  sleep 2
  STATUS=$(systemctl is-active instagram-downloader.service)
  if [ "$STATUS" = "active" ]; then
    MSG="✅ 배포 완료: $(git log -1 --format='%h %s' main) | 변경파일: $(echo "$CHANGED_FILES" | tr '\n' ' ')"
  else
    MSG="⚠️ 배포 후 서비스가 active 상태가 아님 (status: $STATUS) — 확인 필요. 커밋: $(git log -1 --format='%h %s' main)"
  fi
else
  SYNTAX_ERR=$(cat /tmp/deploy_check_syntax_err)
  MSG="❌ 배포 중단: server.js 문법 오류. 서비스는 재시작하지 않음. 커밋: $(git log -1 --format='%h %s' main) | 오류: ${SYNTAX_ERR:0:300}"
fi

curl -s -X POST "$DISCORD_WEBHOOK" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "import json,sys; print(json.dumps({'content': sys.argv[1]}))" "$MSG")" \
  > /dev/null
