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

## 프로젝트 구조

```
server.js              # Express 서버 — 다운로드/OCR/노션 저장/로그인 API
public/index.html       # 프론트엔드 (단일 페이지, 바닐라 JS)
Caddyfile               # 리버스 프록시 + 자동 HTTPS 설정 예시
scripts/deploy_check.sh # main 브랜치 변경 감지 시 자동 pull + 재시작 스크립트
docs/BACKLOG.md          # 남은/진행 중 작업 목록
docs/WORKLOG.md          # 작업 이력 로그
test/                    # 유닛 테스트, OCR 비교 테스트
```

## 주의사항

이 프로젝트는 개인/소규모 사용을 목적으로 만들어졌습니다. 인스타그램은
비공식적인 다운로드를 이용약관에서 제한하고 있으므로, 트래픽이 커지면
차단되거나 동작이 깨질 수 있습니다. 다운로드한 콘텐츠의 저작권은 원 게시자에게
있으니 사적인 용도로만 사용하세요.
