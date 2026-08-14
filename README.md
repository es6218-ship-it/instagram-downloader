# 인스타 다운로더

인스타그램 게시물/릴스/캐러셀 링크를 붙여넣으면 사진·영상을 한 번에 받아오고,
큰 제목 텍스트를 OCR로 추출해 캡션·본문과 함께 노션 데이터베이스에 저장해주는
개인용 웹 앱입니다.

## 주요 기능

- 릴스, 사진 게시물, 여러 장짜리 캐러셀 전부 지원 (원래 순서 유지)
- 아이폰/아이패드 사파리에서 "사진 앱에 저장" 공유 시트로 바로 저장
- 첫 번째 이미지/영상 프레임에서 큰 제목 텍스트 OCR 추출 (한국어 인식 최적화)
- "노션에 저장" 버튼으로 제목/본문/작성자/원본 링크/이미지 전부를 노션 데이터베이스에 기록
- 다운로드 실패 시 자동 재시도
- 간단한 비밀번호 보호

## 요구사항

- Node.js 18+ (전역 `fetch` 사용)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- ffmpeg
- tesseract-ocr (+ 한국어 언어팩 `tesseract-ocr-kor`)

```bash
# Ubuntu/Debian 기준
sudo apt-get install -y ffmpeg tesseract-ocr tesseract-ocr-kor fonts-nanum
pip install -U yt-dlp   # 또는 pipx install yt-dlp
```

`server.js` 상단의 `YT_DLP`, `TESSERACT`, `FFMPEG` 상수가 실제 설치 경로를
가리키는지 확인하세요 (기본값은 `/root/.local/bin/yt-dlp`, `/usr/bin/tesseract`,
`/usr/bin/ffmpeg`).

## 설치

```bash
npm install
```

## 환경 변수 (.env)

프로젝트 루트에 `.env` 파일을 만들고 아래 값을 채웁니다 (`.env`는 git에 커밋되지 않습니다).

```bash
# 노션 연동 (선택 — 없으면 "노션에 저장" 기능만 비활성화됨)
NOTION_TOKEN=ntn_...              # https://www.notion.so/my-integrations 에서 발급
NOTION_DATABASE_ID=xxxxxxxx-...   # 저장할 노션 데이터베이스 ID

# 사이트 접근 제한 (선택 — 없으면 로그인 없이 전체 공개)
SITE_PASSWORD=원하는비밀번호

# 서버 포트 (선택, 기본 3000)
PORT=3000

# 바이럴 필터링 수집기용 (선택 — "바이럴 필터링 수집기" 절 참고)
APIFY_API_TOKEN=apify_api_...
VIRAL_NOTION_DATABASE_ID=xxxxxxxx-...
VIRAL_DISCORD_WEBHOOK=https://discord.com/api/webhooks/...
```

노션 연동을 쓰려면 대상 데이터베이스 페이지의 "···" 메뉴 → Connections에서
만든 연동을 추가해 접근 권한을 줘야 합니다.

## 실행

```bash
npm start
```

기본적으로 `http://localhost:3000` 에서 뜹니다. 실제 서비스로 계속 켜두려면
systemd 서비스나 pm2 등으로 등록하는 걸 추천합니다.

퍼블릭 도메인으로 노출하려면 앞단에 Caddy/nginx 같은 리버스 프록시로 HTTPS를
붙이세요 — 아이폰 Safari의 "사진 앱에 저장" 공유 기능(`navigator.share`)은
HTTPS(또는 localhost)에서만 동작합니다.

## 테스트

```bash
npm test          # 유닛 테스트 + OCR 정확도 비교 테스트 전체 실행
npm run test:unit # URL 검증, 캐러셀 정렬, 재시도 로직, OCR 점수 로직만
npm run test:ocr  # 한국어 OCR 전/후 정확도 비교 (합성 테스트 이미지 자동 생성)
```

## 바이럴 필터링 수집기 (선택 기능)

`scripts/collect_viral.js`는 [Apify](https://apify.com)의 Instagram Scraper API로
설정된 계정/해시태그의 게시물을 가져와 좋아요·조회수 기준으로 필터링하고
노션에 저장하는 무인 실행 스크립트입니다. 메인 다운로더와 별개로 동작하며,
systemd timer로 하루 여러 번 자동 실행되도록 등록되어 있습니다.

### 1. Apify 계정 준비 및 API 토큰 발급

1. https://console.apify.com 에서 회원가입 (무료 크레딧으로 테스트 가능, 이후 사용량만큼 과금)
2. 로그인 후 좌측 메뉴 **Settings → Integrations**로 이동
3. **Personal API tokens**에서 토큰을 복사
4. `.env`에 `APIFY_API_TOKEN=발급받은토큰` 추가
5. (선택) Apify 콘솔의 Store에서 "Instagram Scraper" 액터(`apify/instagram-scraper`)
   페이지를 한 번 열어서 최신 입력 파라미터/출력 필드 스키마를 확인해두면 좋습니다 —
   액터가 업데이트되면 필드명이 바뀔 수 있어 아래 "필드 매핑 주의사항"과 대조해보세요.

### 2. 전용 노션 데이터베이스 만들기

기존 다운로더가 쓰는 노션 데이터베이스와는 구조가 달라서(제목+본문 블록 방식이
아니라 표 형태의 구조화된 속성이 필요) **새 데이터베이스를 하나 더** 만들어야 합니다.

새 데이터베이스에 아래 속성을 이름/타입 그대로 추가하세요 (없는 속성은 스크립트가
자동으로 건너뛰므로, 필요한 것만 만들어도 동작은 합니다):

| 속성 이름 | 타입 |
|---|---|
| (기본 제목 속성, 이름 무관) | Title |
| `URL` | URL |
| `계정` | Text |
| `좋아요` | Number |
| `조회수` | Number |
| `조회수 추정` | Checkbox |
| `캡션` | Text |
| `게시일` | Date |
| `수집일시` | Date |
| `타입` | Select (옵션: `릴스`, `게시물`) |

데이터베이스 페이지의 "···" → Connections에서 기존 노션 연동을 추가한 뒤,
`.env`에 `VIRAL_NOTION_DATABASE_ID=xxxxxxxx-...`로 이 데이터베이스 ID를 넣습니다.
(`NOTION_TOKEN`은 기존 다운로더 것을 그대로 재사용합니다.)

### 3. .env 추가 값

```bash
APIFY_API_TOKEN=apify_api_...
VIRAL_NOTION_DATABASE_ID=xxxxxxxx-...
VIRAL_DISCORD_WEBHOOK=https://discord.com/api/webhooks/...   # 없으면 DISCORD_WEBHOOK을 대신 사용, 둘 다 없으면 알림 생략
```

### 4. 수집 대상 설정

`config/viral_collector.json`에서 수집할 계정/해시태그와 필터 기준을 조정합니다.

```json
{
  "accounts": ["계정1", "계정2"],
  "hashtags": ["해시태그1"],
  "resultsLimitPerTarget": 10,
  "apifyActorId": "apify/instagram-scraper",
  "thresholds": {
    "reelLikes": 100000,
    "reelViews": 1000000,
    "postLikes": 100000
  },
  "estimatedViewsMultiplier": 20
}
```

- `accounts`/`hashtags`에는 순수 이름(`계정1`) 대신 인스타그램 링크(`https://www.instagram.com/계정1/`)나 `@계정1`/`#해시태그1` 형식을 그대로 붙여넣어도 됩니다 — 자동으로 이름만 추출합니다.
- 릴스는 좋아요/조회수 실측치를 그대로 사용해 두 조건(`reelLikes` AND `reelViews`)을 모두 만족해야 통과합니다.
- 일반 게시물(이미지/캐러셀)은 조회수가 비공개라 `postLikes` 기준만 보고, 통과 시 `좋아요 × estimatedViewsMultiplier`를 "조회수" 속성에 추정치로 기록하고 `조회수 추정` 체크박스를 켭니다.
- 이미 수집한 게시물은 `data/viral_collected_ids.json`에 기록되어 다음 실행부터 자동으로 건너뜁니다.

**비용 주의사항**: Apify는 "필터를 통과한 결과 수"가 아니라 **가져온 원본 게시물 수** 기준으로 과금합니다
(Instagram Scraper 무료 등급 기준 결과 1건당 $0.0027). 즉 `resultsLimitPerTarget × (accounts+hashtags 개수) ×
하루 실행 횟수`만큼 매일 청구됩니다. 예를 들어 계정 12개 × 10개씩 × 하루 2회 = 240건/일 ≈ 월 $19.4.
계정 수/`resultsLimitPerTarget`/systemd 타이머 간격 중 하나라도 늘리면 비용이 그만큼 커지니, 바꾸기 전에
[console.apify.com/billing](https://console.apify.com/billing)에서 이번 달 사용량을 먼저 확인하세요.

### 5. Apify 계정 없이 먼저 테스트하기

```bash
# Apify/Notion 호출 없이 필터링·중복방지 로직만 검증 (샘플 데이터 사용)
node scripts/collect_viral.js --dry-run --fixture test/fixtures/apify_sample_response.json

# Notion 저장까지 실제로 검증하고 싶으면(Apify는 아직 없어도 됨) --dry-run만 빼면 됨
node scripts/collect_viral.js --fixture test/fixtures/apify_sample_response.json
```

Apify 토큰을 발급받은 뒤에는 `--fixture` 없이 실행하면 실제 API를 호출합니다:

```bash
node scripts/collect_viral.js            # 실제 실행
node scripts/collect_viral.js --dry-run  # 실제 Apify는 호출하되 Notion 저장/중복기록은 생략(필터 결과만 로그로 확인)
```

### 6. 필드 매핑 주의사항

Apify Instagram Scraper의 응답 필드명은 액터 버전에 따라 달라질 수 있습니다.
`scripts/collect_viral.js`의 `normalizeItem()` 함수가 `likesCount`/`videoViewCount`/
`ownerUsername`/`caption`/`timestamp` 등 흔히 쓰이는 필드명을 우선순위대로 시도하도록
작성되어 있지만, 실제 토큰으로 처음 실행해서 원하는 값이 제대로 채워지는지
`/var/log/viral_collector.log` 로그로 꼭 확인하세요. 필드명이 다르면 `normalizeItem()`의
`pick(raw, [...])` 후보 목록에 실제 필드명을 추가하면 됩니다.

### 7. systemd 자동 실행

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now viral-collector.timer
systemctl list-timers viral-collector.timer   # 다음 실행 시각 확인
journalctl -u viral-collector.service -f      # 실행 로그 실시간 확인
```

하루 2회, 12시간 간격으로 자동 실행되며(`/etc/systemd/system/viral-collector.timer`),
서버가 재부팅돼도 `enable` 상태라 자동으로 다시 켜집니다. 실행 로그는
`/var/log/viral_collector.log`에 계속 쌓이고, 매 실행 결과 요약(수집/중복/필터탈락/실패
건수)이 Discord 웹훅으로 전송됩니다.

## yt-dlp 자동 업데이트 (systemd timer)

인스타그램이 내부 구조를 바꾸면 yt-dlp가 깨지는 일이 잦아서, 주 1회 자동으로
`pip install -U yt-dlp`를 실행하는 oneshot service + timer가 `scripts/`에 있습니다
(pip 경로가 실패하면 `yt-dlp -U`로 폴백). 결과는 `/var/log/ytdlp_update.log`에
기록되고, 버전이 실제로 바뀌었거나 업데이트에 실패했을 때만 Discord로 알립니다.

설치:

```bash
cp scripts/ytdlp-update.service scripts/ytdlp-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ytdlp-update.timer
systemctl list-timers ytdlp-update.timer   # 다음 실행 시각 확인
```

## 프로젝트 구조

```
server.js                     # Express 서버 — 다운로드/OCR/노션 저장/로그인 API
public/index.html              # 프론트엔드 (단일 페이지, 바닐라 JS)
Caddyfile                      # 리버스 프록시 + 자동 HTTPS 설정 예시
scripts/deploy_check.sh        # main 브랜치 변경 감지 시 자동 pull + 재시작 스크립트
scripts/collect_viral.js       # 바이럴 필터링 수집기 (Apify → Notion, systemd timer로 무인 실행)
scripts/update_ytdlp.sh        # yt-dlp 주 1회 자동 업데이트 스크립트 (ytdlp-update.timer가 실행)
scripts/ytdlp-update.service   # 위 스크립트용 oneshot systemd 서비스 유닛
scripts/ytdlp-update.timer     # 주 1회 실행 타이머
config/viral_collector.json    # 수집 대상 계정/해시태그, 필터 기준 설정
data/viral_collected_ids.json  # 수집기 중복 방지 기록 (git에는 포함 안 됨, 런타임 상태)
docs/BACKLOG.md                 # 남은/진행 중 작업 목록
docs/WORKLOG.md                 # 작업 이력 로그
test/                           # 유닛 테스트, OCR 비교 테스트, 수집기 dry-run용 샘플 응답
```

## 주의사항

이 프로젝트는 개인/소규모 사용을 목적으로 만들어졌습니다. 인스타그램은
비공식적인 다운로드를 이용약관에서 제한하고 있으므로, 트래픽이 커지면
차단되거나 동작이 깨질 수 있습니다. 다운로드한 콘텐츠의 저작권은 원 게시자에게
있으니 사적인 용도로만 사용하세요.
