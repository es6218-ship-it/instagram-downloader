# Work Log

자동 작업 에이전트가 실행할 때마다 결과를 아래에 추가합니다.

<!-- 새 항목은 이 줄 아래에 추가 -->

## 2026-08-14 - 바이럴 수집기 사용 중단 (Apify 비용 문제)
- 상태: 성공 (수동 반영 — 사용자가 비용 부담으로 수집 자체를 하지 않기로 결정)
- 변경 파일: docs/BACKLOG.md (시스템 변경: viral-collector.timer stop+disable, 코드/config는 삭제하지 않고 보존)
- 요약: 월 $20 예산에 맞춰 스캔량을 줄인 직후, 사용자가 "그래도 비싸다"며 수집 기능 자체를 쓰지 않기로 결정. `systemctl stop viral-collector.timer && systemctl disable viral-collector.timer`로 완전히 중지 — 재부팅해도 다시 켜지지 않음. scripts/collect_viral.js, config/viral_collector.json 등 코드는 그대로 남겨둬서 나중에 마음이 바뀌면 `systemctl enable --now viral-collector.timer`로 바로 재개 가능.

## 2026-08-14 - 바이럴 수집기 Apify 비용 예산에 맞춰 스캔량 축소
- 상태: 성공 (수동 반영 — 사용자가 무료 한도 초과 후 실제 지출 예산(월 $20) 제시)
- 변경 파일: config/viral_collector.json, /etc/systemd/system/viral-collector.timer, README.md
- 요약: Apify Instagram Scraper 가격 정책을 API로 조회해 확인 — 필터 통과 결과가 아니라 "가져온 원본 게시물 수" 기준 과금(무료 등급 결과 1건당 $0.0027)이라는 걸 사용자에게 설명. 기존 설정(계정 12개 × resultsLimitPerTarget 30 × 하루 10회)은 월 약 $292로 계산돼 예산과 크게 어긋남을 확인. resultsLimitPerTarget을 30→10으로, systemd 타이머를 144분 간격(하루 10회)→12시간 간격(하루 2회)으로 낮춰 월 약 $19.4로 예산 안쪽에 맞춤(daemon-reload+재시작으로 실제 적용 확인). README에 비용 계산식과 계정 수/스캔량/실행 빈도를 늘리면 비용도 같이 늘어난다는 주의사항 추가. 단, 스캔량을 줄여도 실제로 필터 통과하는 "진짜 바이럴" 게시물 개수는 계정별 게시 빈도에 달려있어 보장되지 않는다는 점을 사용자에게 명확히 안내함.

## 2026-08-14 - yt-dlp 실패 사유별 에러 메시지 구체화
- 상태: 성공 (클라우드 자율 에이전트가 네 번째로 실제 작업 성공 — 세션 cse_01YVYG9TtxFuoPdoTaAjgVKW, model=claude-fable-5, 22턴/198초, 커밋 3e40577, 유닛 31/31 통과. 이번에도 GitHub main에 반영되지 않음 — **5번 연속**. 다만 이번엔 라우틴 스스로 유력한 원인을 찾음: 세션의 git이 시작부터 `HEAD detached from refs/heads/main` 상태라 커밋이 어느 브랜치 ref에도 안 붙음 — 플랫폼의 "세션 브랜치를 자동으로 PR로 변환" 기능이 애초에 감지할 브랜치가 없는 셈. 로그를 참고해 수동으로 동일하게 재적용함)
- 변경 파일: server.js, test/unit.js, docs/BACKLOG.md
- 요약: classifyDownloadError(stderrText) 순수 함수 추가 — yt-dlp stderr를 private(비공개 계정)/not_found(삭제됨·404)/restricted(인스타그램의 rate-limit/login-required 뭉뚱그린 제한)/unsupported_url/network/unknown 6가지로 분류하고 사유별 한국어 안내 메시지 제공. downloadAllMedia가 영상 시도·메타데이터 호출 실패 시 stderr를 버리지 않고 errorOutput으로 모아 반환하도록 변경. /api/prepare의 두 실패 경로(파일 0개/예외)에서 분류된 메시지를 노출(사유 불명이면 기존 일반 메시지 유지). 테스트 7개 추가 — 총 31개 통과. 참고: 라우틴이 준 network 케이스 테스트("ETIMEDOUT")가 처음엔 정규식이 안 맞아 실패했는데, 로그에 정확한 정규식까지는 안 남아있어 직접 고침(timeout 패턴에 etimedout 추가).

## 2026-08-14 - 아이폰 홈 화면 PWA manifest + 아이콘 추가
- 상태: 성공 (클라우드 자율 에이전트가 세 번째로 실제 작업 성공 — 세션 cse_01GqorK2gvRRHLcoNw8iALyk, model=claude-fable-5, 28턴/233초, 커밋 7616eea, 유닛 24/24 통과, 비밀번호 게이트 켠 실서버 curl로 검증까지 완료. 이번에도 GitHub main에 반영되지 않음 — **4번 연속** 같은 문제(모델 무관하게 재현). 로그의 설명/코드 스니펫을 참고해 수동으로 동일하게 재적용함)
- 변경 파일: public/manifest.json(신규), public/icons/icon-192.png·icon-512.png·apple-touch-icon.png(신규), scripts/gen_icons.js(신규), public/index.html, server.js, test/unit.js
- 요약: scripts/gen_icons.js — 외부 의존성 없이 순수 Node(zlib)로 PNG를 직접 인코딩(IHDR/IDAT/IEND 청크 + CRC32)해 인스타 그라디언트 배경에 흰색 다운로드 화살표 아이콘 3종(192/512/apple-touch 180) 생성. public/manifest.json 신규(standalone, 다크 테마, maskable). index.html에 manifest 링크 + apple-mobile-web-app 메타 태그 추가. server.js에 isPublicPath() 함수를 분리해 비밀번호 게이트에서 /manifest.json과 /icons/*만 예외 처리(iOS Safari가 쿠키 없이 이 리소스들을 가져가는 경우가 있어서). 테스트 5개 추가(manifest 유효성/아이콘 PNG 시그니처+크기/index.html 링크/isPublicPath 판별/정적 서빙) — 총 24개 통과. SITE_PASSWORD 켠 실제 서비스에 curl로 재검증: manifest·아이콘 200, 루트·API는 여전히 401.

## 2026-08-14 - "분석 중..." 폴링 상태에 진행 단계 표시 추가
- 상태: 성공 (클라우드 자율 에이전트가 두 번째로 실제 작업 성공 — 세션 cse_01UDSADDgk1dMpN2z3Pi9xHs, model=claude-fable-5, ~9분 소요(도구 설치+OCR 테스트 포함), 커밋 af1c573, 유닛 20/20 + OCR 100% 통과. 이번에도 커밋이 GitHub main에 반영되지 않아 — 3번 연속 같은 문제 — 로그 설명을 참고해 수동으로 동일하게 재적용함)
- 변경 파일: server.js, public/index.html, test/unit.js
- 요약: jobs 맵의 pending job에 step 필드("다운로드 중"/"OCR 처리 중")를 추가하고, GET /api/status/:jobId 응답에 그대로 포함시킴. 프론트엔드 폴링 루프에서 submitBtn 텍스트를 고정된 "분석 중..." 대신 서버가 보내주는 step 값으로 갱신. app/jobs를 모듈 export에 추가해 실제 서버를 임시 포트에 띄우고 status 응답을 검증하는 테스트 2개 추가(step 있음/없음 케이스). 참고: 자율 에이전트 세션의 디스코드 웹훅 전송은 이번에도 샌드박스 네트워크 정책(403 CONNECT tunnel)에 막힘 — 알려진 제약.

## 2026-08-13 - 다운로드 완료 후 tmp 작업 디렉토리 자동 정리
- 상태: 성공 (클라우드 자율 에이전트가 처음으로 실제 작업 성공 — 세션 cse_01SbWVfnDhjeQN9E8uN9PV1q, turns=26, duration=113s. 단, 커밋이 세션 브랜치에만 남고 GitHub에 PR/브랜치로 반영되지 않는 문제가 재발해 동일 내용을 수동으로 다시 적용함)
- 변경 파일: server.js, test/unit.js, docs/BACKLOG.md
- 요약: 만료된 job 임시 디렉토리를 지우는 setInterval 기반 정리 로직(JOB_TTL_MS=10분, 60초마다 스캔) 자체는 초기 커밋부터 이미 존재했지만 테스트가 전혀 없었음. 판별 로직(findExpiredJobIds)과 실제 삭제(cleanupExpiredJobs)를 분리해 테스트 가능하게 리팩터링하고, 실제 임시 디렉토리를 만들어 정리 전/후 존재 여부를 검증하는 테스트 2개 추가(총 17개 테스트 전부 통과). 참고: 이 작업은 원래 자율 에이전트가 클라우드 세션에서 먼저 완료했으나, "커밋만 하면 플랫폼이 자동으로 PR로 만들어준다"는 가정이 이번에도 작동하지 않아(브랜치/PR이 GitHub에 전혀 생성되지 않음) 세션 로그를 참고해 동일한 변경을 수동으로 재적용함 — 이전에 한 번 있었던 것과 같은 유형의 유실 사고.

## 2026-08-13 - 바이럴 수집기 실전 검증 + 계정/해시태그에 링크 붙여넣기 지원
- 상태: 성공 (수동 반영 — 사용자가 실제 Apify 토큰/노션 DB 값을 넣어준 뒤 진행)
- 변경 파일: scripts/collect_viral.js, README.md
- 요약: 사용자가 노션에서 "링크 복사"로 가져온 ID가 실제로는 데이터베이스를 담은 상위 페이지 ID였고, 수동으로 만든 속성 이름/타입도 요구사항과 달라서(예: `속성 이름`, `타입 선택`) 노션 API로 직접 검색해 진짜 데이터베이스 ID를 찾고 PATCH로 속성 9개(URL/계정/좋아요/조회수/조회수 추정/캡션/게시일/수집일시/타입)를 정확히 재설정. 이후 샘플 데이터 + 실제 Apify API(계정 kinetic_trigger) 양쪽으로 전체 파이프라인(필터링/노션 저장/중복방지/디스코드 알림)을 실전 검증 — 필드 매핑(likesCount/ownerUsername/caption/timestamp/url)이 실제 응답과 정확히 일치함을 확인. 테스트로 생성된 노션 페이지 2건은 정리(archive)하고 중복방지 기록도 초기화. 추가로 config/viral_collector.json의 accounts/hashtags에 순수 이름 대신 인스타그램 프로필/해시태그 링크나 `@`/`#` 접두사를 그대로 붙여넣어도 자동으로 이름만 추출하도록 extractHandle() 헬퍼 추가(아이패드에서 앱 공유 시트로 복사한 링크를 그대로 붙여넣을 수 있게).

## 2026-08-13 - 바이럴 필터링 수집기 추가 (Apify → Notion, 무인 실행)
- 상태: 성공 (수동 반영 — 사용자 직접 요청, Apify 계정/노션 DB는 아직 미설정 상태로 코드만 완성)
- 변경 파일: scripts/collect_viral.js(신규), config/viral_collector.json(신규), data/.gitkeep(신규), test/fixtures/apify_sample_response.json(신규), README.md, .gitignore
- 요약: 직접 스크래핑 대신 Apify Instagram Scraper API를 통해 설정된 계정/해시태그의 게시물을 가져와 필터링(릴스: 좋아요 10만+ AND 조회수 100만+ / 일반 게시물: 좋아요 10만+, 조회수는 좋아요×20 추정치)하고 전용 노션 데이터베이스(URL/계정/좋아요/조회수/조회수추정/캡션/게시일/수집일시/타입 속성)에 저장하는 독립 스크립트. data/viral_collected_ids.json으로 중복 수집 방지. Apify 응답 필드명은 액터 버전마다 다를 수 있어 normalizeItem()에서 여러 후보 키를 시도하도록 방어적으로 작성 — 실제 계정 없이도 --dry-run/--fixture 옵션으로 필터링·중복방지·Notion 저장 로직 전체를 샘플 데이터로 검증 가능. systemd timer(viral-collector.timer, OnUnitActiveSec=144min)로 하루 10회 무인 실행 등록·활성화 완료(재부팅 후에도 자동 재개), 로그는 /var/log/viral_collector.log, 실행 결과 요약은 Discord 웹훅으로 전송. 실제 등록 확인: systemctl list-timers로 다음 실행 예정 확인, 실제 서비스 1회 트리거되어 로그 파일 기록까지 정상 확인(현재는 APIFY_API_TOKEN 미설정으로 의도된 실패 — 사용자가 키 발급 후 정상 동작 예상).

## 2026-08-13 - 노션 저장 후 새 탭 자동 오픈 제거
- 상태: 성공 (수동 반영 — 자율 에이전트 플랫폼 장애로 대신 직접 수정)
- 변경 파일: public/index.html
- 요약: notionSaveBtn 클릭 핸들러의 window.open(data.url, '_blank') 제거. 노션 저장은 그대로 데이터베이스에 추가되지만 새 탭이 자동으로 뜨지 않음.

## 2026-08-13 - URL 입력창에 붙여넣기 버튼 추가
- 상태: 성공 (수동 반영 — 자율 에이전트 플랫폼 장애로 대신 직접 수정)
- 변경 파일: public/index.html
- 요약: URL 입력창 옆에 📋 붙여넣기 버튼 추가. navigator.clipboard.readText()로 클립보드 내용을 읽어 입력창 값을 항상 덮어씀(매 클릭마다 .value 재할당이라 자동으로 교체됨). 클립보드 API 미지원/권한 거부 시 에러 메시지 표시.

## 2026-08-13 - UI 다크 테마 전면 개편
- 상태: 성공 (수동 반영 — 자율 에이전트 플랫폼 장애로 대신 직접 수정)
- 변경 파일: public/index.html
- 요약: 시스템 설정과 무관하게 항상 검은 배경(#000) 고정 다크 테마로 전환. 카드 표면/보조 표면 색상 분리(--surface/--surface2), 인스타그램 그라디언트 포인트 유지, 입력창 포커스 글로우 추가, 주요 액션(다운로드/사진앱저장)은 그라디언트 강조, 보조 액션(파일저장/노션저장)은 플랫 다크 톤으로 위계 구분. 기존 기능(갤러리, 붙여넣기 버튼, 상태 메시지) 전부 유지.

## 2026-08-13 - OCR 한국어 인식 정확도 개선 + 아이콘/이모지 노이즈 정리
- 상태: 성공 (수동 반영 — 자율 에이전트 플랫폼 장애로 대신 직접 수정. 클라우드에서 한 번 성공했던 작업이 push 불가로 유실되어 재작업)
- 변경 파일: server.js, package.json, .gitignore, test/gen_fixtures.py, test/ocr_compare.js
- 요약: extractOcrTitle을 전면 재작성. ffmpeg 전처리 2종(확대/그레이/대비 또는 정규화/언샤프) x tesseract PSM 4종을 조합해 여러 후보를 뽑고, 한글/영숫자 가중치 + 노이즈 기호 즉시 탈락 + 최소 글자수 규칙으로 각 후보 내 노이즈 줄을 걸러낸 뒤 가장 점수 높은 후보를 채택. 언어팩도 kor+eng+jpn → kor+eng로 조정(jpn이 한글을 한자로 오인식하는 문제 방지). 합성 한국어 테스트 5종 기준 평균 정확도 44.4%→100%로 개선(npm test로 검증 가능). 실제 인스타 게시물(다중 라인 영어 제목 카드)로도 확인 — 이전엔 프로필 아이콘까지 섞인 쓰레기 텍스트만 나왔는데, 이제 전체 제목 문구가 정확히 살아남음.

## 2026-08-13 - 다운로드 실패 시 자동 재시도 로직 + 기본 테스트 코드
- 상태: 성공 (수동 반영 — 자율 에이전트 플랫폼 장애로 대신 직접 수정)
- 변경 파일: server.js, package.json, test/unit.js
- 요약: execWithRetry 헬퍼 추가 — yt-dlp 호출(영상 다운로드/메타데이터/썸네일 3곳)에 지수 백오프 재시도(최대 2회 추가 시도) 적용, 인스타그램 CDN 일시적 오류 흡수. 캐러셀 정렬 로직을 sortItems 순수 함수로 분리해 테스트 가능하게 리팩터링. test/unit.js 신설(URL 검증 6개, 파일 정렬 3개, 재시도 로직 3개, OCR 점수 3개 = 총 15개 테스트, 전부 통과). npm test로 유닛+OCR 테스트 전체 실행.

## 2026-08-13 - 노션 저장 시 캐러셀 전체 이미지 첨부
- 상태: 성공 (수동 반영 — 자율 에이전트 플랫폼 장애로 대신 직접 수정)
- 변경 파일: server.js
- 요약: /api/notion-save에서 첫 번째 이미지만 첨부하던 로직(.find)을 전체 이미지 첨부(.filter + 반복 push)로 변경. 4장짜리 캐러셀로 실제 테스트해서 노션 페이지에 이미지 블록 4개 모두 들어가는 것 확인.

## 2026-08-13 - 사이트 접근 제한(비밀번호) 추가
- 상태: 성공 (수동 반영 — 자율 에이전트 플랫폼 장애로 대신 직접 수정)
- 변경 파일: server.js, .env(비공개)
- 요약: SITE_PASSWORD 환경변수 기반 간단 비밀번호 게이트 추가. 미인증 요청은 정적 파일/모든 API에서 401 + 로그인 페이지(정적 리소스는 페이지, API는 JSON 401). POST /login에서 비밀번호 확인 후 sha256 해시를 HttpOnly+Secure 쿠키(1년 만료)로 발급 — 평문 비밀번호는 쿠키에 저장하지 않음. 로그인/오탐/쿠키 재사용/API 보호 4가지 시나리오 curl로 직접 검증 완료.

## 2026-08-13 - README.md 작성
- 상태: 성공 (수동 반영 — 자율 에이전트 플랫폼 장애로 대신 직접 수정)
- 변경 파일: README.md (신규)
- 요약: 기능 요약, 요구사항(node/yt-dlp/ffmpeg/tesseract), .env 환경변수 설명, 설치/실행/테스트 명령어, 프로젝트 구조, 저작권 관련 주의사항을 정리. 이걸로 백로그에 있던 항목이 전부 완료됨.

## 2026-08-13 - /api/prepare 즉시응답+폴링 구조로 전환 (모바일 셀룰러 무한대기 버그 수정)
- 상태: 성공 (수동 반영 — 사용자가 아이폰 셀룰러 데이터에서 "분석 중"에 멈추는 문제를 신고, 실시간 로그 모니터링으로 재현)
- 변경 파일: server.js, public/index.html
- 요약: 원인 — POST /api/prepare가 다운로드 전체(수십 초)를 끝낼 때까지 응답을 안 보내는 구조였는데, 일부 모바일 통신사 망이 응답 없이 오래 열려있는 커넥션을 중간에서 끊어버려 클라이언트 fetch가 영원히 pending 상태로 남음(Caddy/앱 로그에 요청 흔적조차 안 남는 것으로 확인). 해결 — /api/prepare는 jobId만 즉시 반환하고 실제 다운로드는 백그라운드 IIFE로 진행, 새 GET /api/status/:jobId 엔드포인트로 진행상황(pending/done/error) 조회. jobs 맵에 status 필드 추가. 클라이언트는 prepare 응답을 받자마자 1.5초 간격으로 status를 폴링(최대 2분 타임아웃)하도록 변경. 매 HTTP 요청이 짧아져 통신사 커넥션 타임아웃 문제를 구조적으로 회피. curl로 즉시응답(0.04초)과 전체 폴링 사이클 정상 완료 확인.

## 2026-08-13 - OCR 처리 속도 최적화
- 상태: 성공 (수동 반영 — 폴링 구조 수정 후에도 사용자가 "너무 오래 걸린다"고 신고)
- 변경 파일: server.js
- 요약: 원인 두 가지. (1) OCR이 전처리 2종 x PSM 4종 = 8개 조합을 순차 실행하고 있었음 → PSM을 실전에서 효과 좋았던 2종(6, 11)으로 줄이고, 전처리/인식 전부 Promise.all로 병렬 실행(서버가 2코어라 완전 선형 향상은 아니지만 체감 개선 확인). (2) 사진 게시물은 첫 번째 "영상 다운로드 시도"가 정상적으로 실패하는 게 당연한데(영상이 없으니까) 최근에 넣은 재시도 로직이 이걸 매번 불필요하게 2번 더 재시도(백오프 포함 수 초 낭비)하고 있었음 → 이 첫 시도만 재시도 로직에서 제외. 결과: 사진 게시물 25초→15초, 릴스 10초. npm test 100% 정확도 유지 확인.

## 2026-08-13 - 다운로드 단계 yt-dlp 3회 호출 병렬화
- 상태: 성공 (수동 반영 — 사용자가 "더 빠르게 가능?"이라고 추가 요청)
- 변경 파일: server.js
- 요약: downloadAllMedia가 영상 다운로드 시도/메타데이터(-j)/썸네일(--write-thumbnail) 3개의 yt-dlp 호출을 순차로(await 각각) 실행하고 있었는데, 셋 다 서로 다른 파일에만 쓰고 서로의 결과에 의존하지 않아 굳이 순차일 필요가 없었음. 참고로 메타데이터를 --print JSON 조합으로 썸네일 호출과 하나로 합치는 방법도 시도해봤으나, 캐러셀(여러 이미지 게시물)에서 --print를 쓰면 --write-thumbnail이 아예 무동작하는 것을 확인해 이 방법은 폐기(단일 게시물에서는 되지만 캐러셀에서 깨짐 — -j와 유사한 종류의 비호환). 대신 세 호출을 Promise.all로 동시 실행하도록 변경. CLI 단독 측정 기준 캐러셀(이미지 4장) 다운로드 단계가 6.5초→2.3초로 단축(파일 무결성 확인: 병렬 실행 전후 4개 이미지 파일 크기/내용 동일). 서버 통한 전체 파이프라인(다운로드+OCR) 기준으로는 사진 게시물이 약 13초로 추가 단축(OCR이 남은 시간의 대부분을 차지). npm test 15개 유닛 테스트 + OCR 정확도 100% 유지 확인.
