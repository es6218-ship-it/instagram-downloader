#!/bin/bash
# yt-dlp 자동 업데이트 — ytdlp-update.timer가 주 1회 실행한다.
# 인스타그램이 내부 구조를 바꾸면 yt-dlp가 깨지는 일이 잦아서, 수동 업데이트 대신 정기 업데이트로 대응.
# 결과는 /var/log/ytdlp_update.log에 기록하고, 버전이 실제로 바뀌었거나 실패했을 때만 디스코드로 알린다.
set -uo pipefail

YT_DLP="${YTDLP_UPDATE_BIN:-/root/.local/bin/yt-dlp}"
LOG_FILE="${YTDLP_UPDATE_LOG:-/var/log/ytdlp_update.log}"
DISCORD_WEBHOOK="${YTDLP_UPDATE_WEBHOOK:-https://discord.com/api/webhooks/1537085413632639046/Cqsi3GXlW2_EBVVPo20NYCuTBMa0BULquVWU7Jtk71a2V37scbGbMhd83cqDvaEs7OKj}"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" >> "$LOG_FILE"
}

notify() {
  curl -s -m 10 -X POST "$DISCORD_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "import json,sys; print(json.dumps({'content': sys.argv[1]}))" "$1" 2>/dev/null)" \
    > /dev/null 2>&1
}

OLD_VERSION=$("$YT_DLP" --version 2>/dev/null || echo "unknown")

if pip install -U yt-dlp >>"$LOG_FILE" 2>&1; then
  UPDATE_OK=1
elif "$YT_DLP" -U >>"$LOG_FILE" 2>&1; then
  UPDATE_OK=1
else
  UPDATE_OK=0
fi

NEW_VERSION=$("$YT_DLP" --version 2>/dev/null || echo "unknown")

if [ "$UPDATE_OK" = "1" ]; then
  if [ "$OLD_VERSION" != "$NEW_VERSION" ]; then
    log "업데이트 성공: $OLD_VERSION -> $NEW_VERSION"
    notify "✅ yt-dlp 자동 업데이트: $OLD_VERSION → $NEW_VERSION"
  else
    log "이미 최신 버전: $NEW_VERSION"
  fi
  exit 0
else
  log "업데이트 실패 (버전 $OLD_VERSION 유지)"
  notify "❌ yt-dlp 자동 업데이트 실패 (현재 버전 유지: $OLD_VERSION) — /var/log/ytdlp_update.log 확인 필요"
  exit 1
fi
