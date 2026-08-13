#!/usr/bin/env node
'use strict';

// 바이럴 필터링 수집기 — Apify Instagram Scraper API로 계정/해시태그의 게시물을
// 가져와 좋아요/조회수 기준으로 필터링하고 Notion에 저장한다. Claude 호출 없이
// 단독 실행되며, systemd timer로 하루 2회 자동 실행된다.
//
// 사용법:
//   node scripts/collect_viral.js                 # 실제 실행 (Apify + Notion)
//   node scripts/collect_viral.js --dry-run        # Apify는 호출하되 Notion 저장/중복기록은 생략
//   node scripts/collect_viral.js --fixture <path> # Apify 대신 로컬 JSON 파일을 응답으로 사용 (계정 없이 테스트용)
//
// 설정 파일: config/viral_collector.json (수집 대상 계정/해시태그, 필터 기준 등)
// 중복 방지 기록: data/viral_collected_ids.json
// Notion 속성 구조와 Apify 발급 절차는 README.md 참고.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'viral_collector.json');
const DEDUP_PATH = path.join(ROOT, 'data', 'viral_collected_ids.json');

const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
const APIFY_API_BASE = 'https://api.apify.com/v2';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const VIRAL_NOTION_DATABASE_ID = process.env.VIRAL_NOTION_DATABASE_ID;
const NOTION_API_BASE = 'https://api.notion.com/v1';

const DISCORD_WEBHOOK = process.env.VIRAL_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function loadDedupStore() {
  try {
    return JSON.parse(fs.readFileSync(DEDUP_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveDedupStore(store) {
  fs.mkdirSync(path.dirname(DEDUP_PATH), { recursive: true });
  fs.writeFileSync(DEDUP_PATH, JSON.stringify(store, null, 2));
}

// Apify 액터(예: apify/instagram-scraper)를 동기 실행해 결과 데이터셋을 바로 받는다.
// 액터 버전에 따라 입력 파라미터 이름이 달라질 수 있으니, 실제 응답을 받아보고
// 다르면 이 함수의 input 구성과 normalizeItem()의 필드 매핑을 맞춰 조정해야 한다.
async function runApifyActor(actorId, directUrls, resultsLimit) {
  const encodedActor = actorId.replace('/', '~');
  const url = `${APIFY_API_BASE}/acts/${encodedActor}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      directUrls,
      resultsType: 'posts',
      resultsLimit
    })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Apify API 오류 (HTTP ${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  if (!Array.isArray(data)) {
    throw new Error('Apify 응답이 배열 형태가 아닙니다: ' + JSON.stringify(data).slice(0, 300));
  }
  return data;
}

// config에 순수 계정명/해시태그 대신 인스타그램 링크를 그대로 붙여넣어도 동작하도록
// 정규화한다. "https://www.instagram.com/abc/", "@abc", "abc" 전부 "abc"로 통일.
function extractHandle(input) {
  let s = String(input).trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const parts = u.pathname.split('/').filter(Boolean);
      // /explore/tags/<tag>/ 형태의 해시태그 링크는 마지막 세그먼트가 태그명
      if (parts[0] === 'explore' && parts[1] === 'tags' && parts[2]) return parts[2];
      s = parts[0] || s;
    } catch (_) {
      // URL 파싱 실패 시 원본 문자열로 계속 진행
    }
  }
  return s.replace(/^[@#]/, '').replace(/\/+$/, '');
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

// Apify Instagram Scraper 응답의 필드명은 액터 버전에 따라 다를 수 있어,
// 흔히 쓰이는 여러 후보 키를 순서대로 시도한다.
function normalizeItem(raw) {
  const shortCode = pick(raw, ['shortCode', 'code']);
  const rawType = (pick(raw, ['type', 'productType']) || '').toString().toLowerCase();
  const isReel = rawType.includes('reel') || rawType.includes('clip') || rawType === 'video';

  let url = pick(raw, ['url']);
  if (!url && shortCode) {
    url = `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${shortCode}/`;
  }

  const id = pick(raw, ['id', 'shortCode', 'pk']) || shortCode || url;
  const likes = Number(pick(raw, ['likesCount', 'likes'])) || 0;
  const rawViews = pick(raw, ['videoViewCount', 'videoPlayCount', 'viewsCount', 'playsCount']);
  const realViews = rawViews != null ? Number(rawViews) : null;
  const account = pick(raw, ['ownerUsername', 'username']) || '';
  const caption = pick(raw, ['caption', 'text']) || '';
  const rawTimestamp = pick(raw, ['timestamp', 'takenAtTimestamp']);

  let postedAt = null;
  if (rawTimestamp != null) {
    if (typeof rawTimestamp === 'number') {
      // 초 단위 유닉스 타임스탬프와 밀리초 단위를 자릿수로 구분
      postedAt = new Date(rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp);
    } else {
      const parsed = new Date(rawTimestamp);
      if (!isNaN(parsed.getTime())) postedAt = parsed;
    }
  }

  return { id, url, isReel, likes, realViews, account, caption, postedAt };
}

function passesFilter(item, thresholds) {
  if (!item.id || !item.url) return false;
  if (item.isReel) {
    const views = item.realViews != null ? item.realViews : 0;
    return item.likes >= thresholds.reelLikes && views >= thresholds.reelViews;
  }
  return item.likes >= thresholds.postLikes;
}

let notionTitlePropCache = null;
async function getNotionTitleProperty() {
  if (notionTitlePropCache) return notionTitlePropCache;
  const dbRes = await fetch(`${NOTION_API_BASE}/databases/${VIRAL_NOTION_DATABASE_ID}`, {
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' }
  });
  const dbData = await dbRes.json();
  if (!dbRes.ok) throw new Error(dbData.message || '노션 데이터베이스 조회에 실패했습니다.');
  const entry = Object.entries(dbData.properties).find(([, v]) => v.type === 'title');
  if (!entry) throw new Error('노션 데이터베이스에 제목 속성이 없습니다.');
  notionTitlePropCache = { name: entry[0], properties: Object.keys(dbData.properties) };
  return notionTitlePropCache;
}

// README에 문서화된 이름으로 새 Notion 데이터베이스를 만들어야 한다.
// 데이터베이스에 없는 속성은 조용히 건너뛴다 (요청받지 않은 속성을 억지로 만들지 않음).
async function saveToNotion(item, isEstimated, estimatedViews) {
  const titleInfo = await getNotionTitleProperty();
  const has = (name) => titleInfo.properties.includes(name);

  const titleText = (item.caption || item.account || '바이럴 게시물').slice(0, 200);
  const properties = {
    [titleInfo.name]: { title: [{ text: { content: titleText } }] }
  };
  if (has('URL')) properties['URL'] = { url: item.url };
  if (has('계정')) properties['계정'] = { rich_text: [{ text: { content: item.account } }] };
  if (has('좋아요')) properties['좋아요'] = { number: item.likes };
  if (has('조회수')) properties['조회수'] = { number: isEstimated ? estimatedViews : item.realViews };
  if (has('조회수 추정')) properties['조회수 추정'] = { checkbox: isEstimated };
  if (has('캡션')) properties['캡션'] = { rich_text: [{ text: { content: (item.caption || '').slice(0, 1900) } }] };
  if (has('게시일') && item.postedAt) properties['게시일'] = { date: { start: item.postedAt.toISOString() } };
  if (has('수집일시')) properties['수집일시'] = { date: { start: new Date().toISOString() } };
  if (has('타입')) properties['타입'] = { select: { name: item.isReel ? '릴스' : '게시물' } };

  const res = await fetch(`${NOTION_API_BASE}/pages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ parent: { database_id: VIRAL_NOTION_DATABASE_ID }, properties })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Notion 저장 실패');
  return data;
}

async function sendDiscordSummary(stats) {
  if (!DISCORD_WEBHOOK) {
    log('DISCORD_WEBHOOK이 설정되지 않아 결과 요약 전송을 건너뜁니다.');
    return;
  }
  const content =
    `📊 **바이럴 수집기 실행 완료**\n` +
    `- 대상: ${stats.targets}개 (계정/해시태그)\n` +
    `- 신규 수집: ${stats.collected}건\n` +
    `- 중복 스킵: ${stats.skippedDup}건\n` +
    `- 필터 탈락: ${stats.skippedFilter}건\n` +
    `- 대상 처리 실패: ${stats.failed}건`;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
  } catch (err) {
    log('Discord 전송 실패: ' + err.message);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fixtureIdx = args.indexOf('--fixture');
  const fixturePath = fixtureIdx !== -1 ? args[fixtureIdx + 1] : null;

  if (!fixturePath && !APIFY_API_TOKEN) {
    throw new Error('APIFY_API_TOKEN이 설정되지 않았습니다 (.env 확인, 또는 --fixture로 테스트하세요).');
  }
  if (!dryRun && (!NOTION_TOKEN || !VIRAL_NOTION_DATABASE_ID)) {
    throw new Error('NOTION_TOKEN / VIRAL_NOTION_DATABASE_ID가 설정되지 않았습니다 (.env 확인, 또는 --dry-run으로 테스트하세요).');
  }

  const config = loadConfig();
  const dedup = loadDedupStore();

  const targets = [
    ...config.accounts.map((a) => {
      const handle = extractHandle(a);
      return { type: '계정', value: handle, url: `https://www.instagram.com/${handle}/` };
    }),
    ...config.hashtags.map((h) => {
      const tag = extractHandle(h);
      return { type: '해시태그', value: tag, url: `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/` };
    })
  ];

  if (targets.length === 0 && !fixturePath) {
    log('config/viral_collector.json에 수집 대상(accounts/hashtags)이 비어 있습니다. 처리할 작업 없음.');
    return;
  }

  let collected = 0;
  let skippedDup = 0;
  let skippedFilter = 0;
  let failed = 0;

  // --fixture 모드: Apify 계정 없이 실제 응답 형태의 로컬 JSON으로 파이프라인 전체(필터/중복/Notion 저장/Discord 알림)를 검증한다.
  const runsToProcess = fixturePath
    ? [{ type: '픽스처', value: fixturePath, url: null }]
    : targets;

  for (const target of runsToProcess) {
    try {
      const rawItems = fixturePath
        ? JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
        : await runApifyActor(config.apifyActorId, [target.url], config.resultsLimitPerTarget);

      for (const raw of rawItems) {
        const item = normalizeItem(raw);
        if (!item.id || !item.url) continue;

        if (dedup[item.id]) {
          skippedDup++;
          continue;
        }
        if (!passesFilter(item, config.thresholds)) {
          skippedFilter++;
          continue;
        }

        const isEstimated = !item.isReel;
        const estimatedViews = item.likes * config.estimatedViewsMultiplier;

        if (!dryRun) {
          await saveToNotion(item, isEstimated, estimatedViews);
          dedup[item.id] = { collectedAt: new Date().toISOString(), url: item.url };
          saveDedupStore(dedup);
        }
        collected++;
        log(
          `수집${dryRun ? '(dry-run)' : ''}: ${item.url} (좋아요 ${item.likes}, ` +
            `${isEstimated ? '추정 ' : ''}조회수 ${isEstimated ? estimatedViews : item.realViews})`
        );
      }
    } catch (err) {
      failed++;
      log(`[실패] ${target.type} "${target.value}": ${err.message}`);
    }
  }

  log(
    `완료 — 수집 ${collected}건 / 중복스킵 ${skippedDup}건 / 필터탈락 ${skippedFilter}건 / ` +
      `대상실패 ${failed}건 / 대상수 ${runsToProcess.length}`
  );

  if (!dryRun) {
    await sendDiscordSummary({
      collected,
      skippedDup,
      skippedFilter,
      failed,
      targets: runsToProcess.length
    });
  }
}

main().catch((err) => {
  log('치명적 오류: ' + (err.stack || err.message));
  process.exitCode = 1;
});
