const express = require('express');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || null;
const AUTH_COOKIE = 'ig_auth';
const authToken = SITE_PASSWORD
  ? crypto.createHash('sha256').update(SITE_PASSWORD).digest('hex')
  : null;

app.use(express.json());

// 간단한 비밀번호 게이트. SITE_PASSWORD가 설정되어 있지 않으면(로컬 개발 등) 그냥 통과.
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  if (!authToken) return true;
  const cookies = parseCookies(req.headers.cookie);
  return cookies[AUTH_COOKIE] === authToken;
}

const LOGIN_PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>로그인</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#000; color:#f5f5f7; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Apple SD Gothic Neo","Noto Sans KR",sans-serif; padding:24px; }
  .card { background:#121214; border:1px solid #2c2c2f; border-radius:24px; padding:36px 28px; width:100%; max-width:360px; box-shadow:0 20px 60px rgba(0,0,0,0.6); }
  h1 { font-size:20px; margin:0 0 20px; }
  input { width:100%; padding:14px 16px; border-radius:14px; border:1px solid #2c2c2f; background:#1c1c1f; color:#f5f5f7; font-size:15px; box-sizing:border-box; margin-bottom:12px; }
  button { width:100%; padding:14px; border:none; border-radius:14px; background:linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888); color:white; font-size:15px; font-weight:600; cursor:pointer; }
  .err { color:#ff453a; font-size:13px; min-height:18px; margin-top:10px; }
</style></head>
<body>
  <div class="card">
    <h1>비밀번호를 입력하세요</h1>
    <form id="f">
      <input type="password" id="pw" placeholder="비밀번호" autofocus required />
      <button type="submit">입장</button>
    </form>
    <div class="err" id="err"></div>
  </div>
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: document.getElementById('pw').value })
      });
      if (res.ok) location.href = '/';
      else document.getElementById('err').textContent = '비밀번호가 틀렸습니다.';
    });
  </script>
</body></html>`;

app.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!authToken || password !== SITE_PASSWORD) {
    return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
  }
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE}=${authToken}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax; Secure`
  );
  res.json({ ok: true });
});

// 인증 없이 접근 가능한 경로 — PWA manifest/아이콘은 브라우저(특히 iOS Safari)가
// 쿠키 없이 가져가는 경우가 있어 게이트에서 제외한다(민감 정보 없음).
function isPublicPath(p) {
  return p === '/login' || p === '/manifest.json' || p.startsWith('/icons/');
}

app.use((req, res, next) => {
  if (isAuthed(req) || isPublicPath(req.path)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  res.status(401).send(LOGIN_PAGE);
});

app.use(express.static(path.join(__dirname, 'public')));

const INSTAGRAM_URL_RE = /^https:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?/i;
const YT_DLP = '/root/.local/bin/yt-dlp';
const EXEC_OPTS = { timeout: 90_000, maxBuffer: 20 * 1024 * 1024 };
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const JOB_TTL_MS = 10 * 60 * 1000;

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_API_BASE = 'https://api.notion.com/v1';
const TESSERACT = '/usr/bin/tesseract';
const FFMPEG = '/usr/bin/ffmpeg';
// 한국어 우선. jpn 언어팩은 한글 제목을 한자/가나로 오인식하는 경우가 많아 기본에서 제외.
const OCR_LANGS = process.env.OCR_LANGS || 'kor+eng';
// 오버레이 제목 텍스트의 한글 인식률을 높이기 위한 이미지 전처리 변형들.
// 확대(lanczos) → 그레이스케일 → 대비/정규화 → 언샤프 순으로 적용한다.
// 배경/대비 특성에 따라 잘 맞는 필터가 달라서 여러 변형을 만든 뒤 가장 좋은 결과를 고른다.
const OCR_PREPROCESS_VARIANTS = [
  "scale='min(1080,3*iw)':-1:flags=lanczos,format=gray,eq=contrast=1.8:brightness=0.02,unsharp=5:5:1.0",
  "scale='min(1080,3*iw)':-1:flags=lanczos,format=gray,normalize,unsharp=5:5:1.0"
];
// VPS 코어가 적어(2코어) 모드를 너무 많이 늘리면 느려지기만 하므로,
// 오버레이 제목 텍스트에 실질적으로 잘 맞는 두 모드만 사용한다.
const OCR_PSM_MODES = [6, 11];

const jobs = new Map();

// 만료된(TTL 지난) job의 임시 디렉토리를 지우고 jobs 맵에서도 제거한다.
// 순수 판별 로직(어떤 job이 만료됐는지)과 실제 삭제를 분리해 테스트하기 쉽게 함.
function findExpiredJobIds(jobsMap, now, ttlMs) {
  const expired = [];
  for (const [jobId, job] of jobsMap) {
    if (now - job.createdAt > ttlMs) expired.push(jobId);
  }
  return expired;
}

async function cleanupExpiredJobs(jobsMap = jobs, now = Date.now(), ttlMs = JOB_TTL_MS) {
  const expiredIds = findExpiredJobIds(jobsMap, now, ttlMs);
  for (const jobId of expiredIds) {
    const job = jobsMap.get(jobId);
    if (job) await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    jobsMap.delete(jobId);
  }
  return expiredIds;
}

setInterval(() => {
  cleanupExpiredJobs();
}, 60_000);

// yt-dlp 호출은 인스타그램 CDN/네트워크 쪽 일시적 오류(타임아웃, 일시적 429 등)로
// 가끔 실패한다. 짧은 대기 후 몇 번 더 시도해서 이런 일시적 실패를 흡수한다.
async function execWithRetry(cmd, args, opts, retries = 2, delayMs = 1500) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await execFileAsync(cmd, args, opts);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

async function downloadAllMedia(url, tmpDir) {
  const outputTemplate = path.join(tmpDir, '%(id)s.%(ext)s');

  // 세 호출(영상 시도/메타데이터/썸네일) 모두 서로 다른 파일에만 쓰고 서로의
  // 결과에 의존하지 않으므로, 순차 실행 대신 동시에 실행해 인스타그램 세션
  // 설정 등 각 호출의 네트워크 왕복 대기 시간을 겹치게 한다(carousel 기준
  // 약 6.5초 → 2.3초로 단축, 파일 무결성은 병렬 실행 전후 동일함을 확인).
  //
  // 첫 번째 시도(영상 다운로드)는 사진 게시물이면 "영상 없음"으로 정상적으로
  // 실패하는 경우가 흔해서(재시도해도 소용없음) 재시도하지 않는다. 재시도는
  // 메타데이터/썸네일처럼 원래 성공해야 정상인 호출에만 적용한다.
  const videoAttemptPromise = execFileAsync(
    YT_DLP,
    ['--no-playlist', '--ignore-no-formats-error', '-S', 'vcodec:h264', '-o', outputTemplate, url],
    EXEC_OPTS
  ).catch(() => {});

  const metadataPromise = execWithRetry(
    YT_DLP,
    ['--no-playlist', '--ignore-no-formats-error', '--skip-download', '-j', '-o', outputTemplate, url],
    EXEC_OPTS
  ).catch(() => null);

  const thumbnailPromise = execWithRetry(
    YT_DLP,
    ['--no-playlist', '--ignore-no-formats-error', '--write-thumbnail', '--skip-download', '-o', outputTemplate, url],
    EXEC_OPTS
  ).catch(() => {});

  const [, metadataResult] = await Promise.all([videoAttemptPromise, metadataPromise, thumbnailPromise]);

  let meta = null;
  const orderIndex = new Map();
  if (metadataResult) {
    try {
      const jsonLines = metadataResult.stdout.split('\n').filter((l) => l.trim().startsWith('{'));
      jsonLines.forEach((line, idx) => {
        try {
          const entry = JSON.parse(line);
          if (entry.id) orderIndex.set(entry.id, idx);
        } catch (_) {}
      });
      if (jsonLines.length > 0) {
        const info = JSON.parse(jsonLines[0]);
        meta = {
          title: info.title || null,
          description: info.description || null,
          uploader: info.uploader || info.channel || null,
          webpage_url: info.webpage_url || url
        };
      }
    } catch (_) {
      // metadata is best-effort; ignore failures
    }
  }

  const files = await fs.readdir(tmpDir);
  const byId = new Map();

  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const id = path.basename(f, ext);
    const isVideo = VIDEO_EXTS.has(ext);
    const isImage = IMAGE_EXTS.has(ext);
    if (!isVideo && !isImage) continue;

    const existing = byId.get(id);
    if (!existing || (isVideo && !existing.isVideo)) {
      if (existing && !isVideo) continue;
      if (existing && isVideo && !existing.isVideo) {
        await fs.rm(path.join(tmpDir, existing.filename), { force: true }).catch(() => {});
      }
      byId.set(id, { filename: f, isVideo });
    }
  }

  const items = sortItems(byId, orderIndex);

  return { items, meta };
}

// byId: Map<id, {filename, isVideo}>, orderIndex: Map<id, originalCarouselPosition>.
// 캐러셀 원래 순서(orderIndex)를 우선 따르고, 순서 정보가 없는 항목은 파일명으로 정렬한다.
// downloadAllMedia에서 분리해 순수 함수로 유닛 테스트 가능하게 함.
function sortItems(byId, orderIndex) {
  return [...byId.entries()]
    .sort(([idA], [idB]) => {
      const rankA = orderIndex.has(idA) ? orderIndex.get(idA) : Infinity;
      const rankB = orderIndex.has(idB) ? orderIndex.get(idB) : Infinity;
      if (rankA !== rankB) return rankA - rankB;
      return idA.localeCompare(idB);
    })
    .map(([, v]) => ({ filename: v.filename, type: v.isVideo ? 'video' : 'image' }));
}

async function preprocessForOcr(srcPath, outPath, variantFilter) {
  await execFileAsync(FFMPEG, ['-y', '-i', srcPath, '-vf', variantFilter, outPath], EXEC_OPTS);
}

async function tesseractText(imgPath, psm) {
  const { stdout } = await execFileAsync(
    TESSERACT,
    [imgPath, 'stdout', '-l', OCR_LANGS, '--oem', '1', '--psm', String(psm)],
    EXEC_OPTS
  );
  return stdout;
}

// 한 줄(제목 후보)의 품질 점수. 한글 음절을 가장 높게 치고, 영숫자는 보통으로 친다.
// 정체불명 기호(아이콘/이모지/배경 오인식 노이즈)가 하나라도 섞여 있거나,
// 의미 있는 글자 수가 너무 적으면 아예 탈락시킨다(배경 텍스처 오인식 방지).
// 여러 전처리·PSM 후보에서 나온 줄 중 진짜 제목 줄을 골라내는 데 쓴다.
function scoreLine(line) {
  if (!line || !line.trim()) return -Infinity;
  const trimmed = line.trim();
  const hangul = (trimmed.match(/[가-힣]/g) || []).length;
  const alnum = (trimmed.match(/[a-zA-Z0-9]/g) || []).length;
  const junk = (trimmed.match(/[^가-힣a-zA-Z0-9\s.,!?~%'"-]/g) || []).length;
  const meaningful = hangul + alnum;
  if (junk > 0) return -Infinity;
  if (meaningful < 3) return -Infinity;
  return hangul * 3 + alnum * 1;
}

// 한 후보(하나의 전처리+PSM 조합) 텍스트 안에서 노이즈 줄만 걸러내고
// 진짜 제목으로 보이는 줄들은 원래 줄바꿈 순서 그대로 이어붙인다.
// (여러 줄짜리 영어 제목 카드처럼, 좋은 줄이 여러 개인 경우를 온전히 보존하기 위함)
function cleanCandidate(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const kept = lines.filter((l) => scoreLine(l) > 0);
  if (kept.length === 0) return { text: null, score: -Infinity };
  return {
    text: kept.join('\n'),
    score: kept.reduce((sum, l) => sum + scoreLine(l), 0)
  };
}

function pickBestCandidate(candidateTexts) {
  let best = null;
  let bestScore = -Infinity;
  for (const text of candidateTexts) {
    const cleaned = cleanCandidate(text);
    if (cleaned.text && cleaned.score > bestScore) {
      bestScore = cleaned.score;
      best = cleaned.text;
    }
  }
  return best;
}

// 한 장의 이미지에서 큰 제목 텍스트를 뽑아낸다.
// 여러 전처리 변형 x 여러 PSM 모드 조합을 전부 동시에(병렬로) 돌려서 지연을 줄이고,
// 그 중 가장 그럴듯한 후보(줄 묶음)를 고른다.
async function ocrImage(imagePath, tmpDir) {
  const preFiles = [];

  try {
    // 1) 전처리 변형들을 병렬로 생성
    const preResults = await Promise.all(
      OCR_PREPROCESS_VARIANTS.map(async (variant, i) => {
        const outPath = path.join(tmpDir, `__ocr_pre_${i}_${Date.now()}.png`);
        try {
          await preprocessForOcr(imagePath, outPath, variant);
          return outPath;
        } catch (_) {
          return null;
        }
      })
    );
    const readyFiles = preResults.filter(Boolean);
    preFiles.push(...readyFiles);

    // 2) (전처리 결과 x PSM 모드) 조합 전부를 동시에 인식
    const jobs = [];
    for (const outPath of readyFiles) {
      for (const psm of OCR_PSM_MODES) {
        jobs.push(tesseractText(outPath, psm).catch(() => null));
      }
    }
    const results = await Promise.all(jobs);
    const candidates = results.filter(Boolean);

    if (candidates.length === 0) return null;
    return pickBestCandidate(candidates);
  } finally {
    await Promise.all(preFiles.map((f) => fs.rm(f, { force: true }).catch(() => {})));
  }
}

async function extractOcrTitle(tmpDir, items) {
  if (!items || items.length === 0) return null;
  const first = items[0];
  const filePath = path.join(tmpDir, first.filename);
  let ocrTargetPath = filePath;
  let framePath = null;

  if (first.type === 'video') {
    framePath = path.join(tmpDir, '__ocr_frame.jpg');
    try {
      await execFileAsync(
        FFMPEG,
        ['-y', '-i', filePath, '-ss', '00:00:01', '-vframes', '1', framePath],
        EXEC_OPTS
      );
      ocrTargetPath = framePath;
    } catch (_) {
      return null;
    }
  }

  try {
    return await ocrImage(ocrTargetPath, tmpDir);
  } catch (_) {
    return null;
  } finally {
    if (framePath) await fs.rm(framePath, { force: true }).catch(() => {});
  }
}

// /api/prepare는 즉시 jobId만 반환하고, 실제 다운로드(수십 초 걸릴 수 있음)는
// 백그라운드에서 진행한다. 클라이언트는 /api/status/:jobId를 짧은 간격으로 폴링한다.
// (긴 요청을 하나 붙잡고 있으면 일부 모바일 통신망에서 응답 전에 연결이 끊겨
//  "무한 대기"처럼 보이는 문제가 있어, 매 요청을 짧게 유지하기 위한 구조.)
app.post('/api/prepare', async (req, res) => {
  const url = (req.body && req.body.url || '').trim();

  if (!INSTAGRAM_URL_RE.test(url)) {
    return res.status(400).json({ error: '올바른 인스타그램 게시물/릴스 링크가 아닙니다.' });
  }

  const jobId = crypto.randomUUID();
  const tmpDir = path.join(os.tmpdir(), 'ig-dl-' + jobId);
  const createdAt = Date.now();
  await fs.mkdir(tmpDir, { recursive: true });

  jobs.set(jobId, { dir: tmpDir, createdAt, status: 'pending', step: '다운로드 중' });
  res.json({ jobId });

  (async () => {
    try {
      const { items, meta } = await downloadAllMedia(url, tmpDir);

      if (items.length === 0) {
        await fs.rm(tmpDir, { recursive: true, force: true });
        jobs.set(jobId, {
          dir: tmpDir,
          createdAt,
          status: 'error',
          error: '다운로드할 수 있는 사진/영상을 찾지 못했습니다. 비공개 계정이거나 링크를 확인해주세요.'
        });
        return;
      }

      // 다운로드가 끝나고 OCR로 넘어가는 시점에 진행 단계를 갱신한다.
      // 폴링 중인 클라이언트가 "지금 뭘 하고 있는지"를 볼 수 있게 하기 위함.
      jobs.set(jobId, { dir: tmpDir, createdAt, status: 'pending', step: 'OCR 처리 중' });

      const ocrTitle = await extractOcrTitle(tmpDir, items);
      if (meta) meta.ocrTitle = ocrTitle;

      jobs.set(jobId, { dir: tmpDir, createdAt, status: 'done', items, meta });
    } catch (err) {
      console.error(err.stderr || err.message);
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      jobs.set(jobId, {
        dir: tmpDir,
        createdAt,
        status: 'error',
        error: '다운로드에 실패했습니다. 링크를 확인하거나 잠시 후 다시 시도해주세요.'
      });
    }
  })();
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });

  if (job.status === 'pending') return res.json({ status: 'pending', step: job.step || null });
  if (job.status === 'error') return res.json({ status: 'error', error: job.error });

  res.json({
    status: 'done',
    items: job.items,
    caption: job.meta ? job.meta.description : null,
    ocrTitle: job.meta ? job.meta.ocrTitle : null
  });
});

app.get('/api/file/:jobId/:filename', async (req, res) => {
  const { jobId, filename } = req.params;
  const job = jobs.get(jobId);

  if (!job || filename.includes('/') || filename.includes('..')) {
    return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  }

  const filePath = path.join(job.dir, filename);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  });
});

let notionTitlePropCache = null;
async function getNotionTitleProperty() {
  if (notionTitlePropCache) return notionTitlePropCache;
  const dbRes = await fetch(`${NOTION_API_BASE}/databases/${NOTION_DATABASE_ID}`, {
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28'
    }
  });
  const dbData = await dbRes.json();
  if (!dbRes.ok) throw new Error(dbData.message || '노션 데이터베이스 조회에 실패했습니다.');
  const entry = Object.entries(dbData.properties).find(([, v]) => v.type === 'title');
  if (!entry) throw new Error('노션 데이터베이스에 제목 속성이 없습니다.');
  notionTitlePropCache = entry[0];
  return notionTitlePropCache;
}

function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

app.post('/api/notion-save', async (req, res) => {
  if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
    return res.status(500).json({ error: '노션 연동이 설정되지 않았습니다.' });
  }

  const { jobId } = req.body || {};
  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: '작업을 찾을 수 없습니다. 다시 다운로드해주세요.' });
  }

  try {
    const titleProp = await getNotionTitleProperty();
    const meta = job.meta || {};
    const ocrLine = meta.ocrTitle ? meta.ocrTitle.split('\n')[0] : null;
    const titleText = (ocrLine || meta.title || meta.uploader || '인스타그램 게시물').slice(0, 200);

    const children = [];
    if (meta.ocrTitle) {
      children.push({
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: [{ text: { content: '제목: ' + meta.ocrTitle } }] }
      });
    }
    if (meta.description) {
      children.push({
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: [{ text: { content: '본문' } }] }
      });
      for (const chunk of chunkText(meta.description, 1900)) {
        children.push({
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ text: { content: chunk } }] }
        });
      }
    }
    if (meta.uploader) {
      children.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ text: { content: `작성자: ${meta.uploader}` } }] }
      });
    }
    if (meta.webpage_url) {
      children.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ text: { content: meta.webpage_url, link: { url: meta.webpage_url } } }] }
      });
    }

    const images = (job.items || []).filter((it) => it.type === 'image');
    if (images.length > 0) {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      for (const image of images) {
        children.push({
          object: 'block',
          type: 'image',
          image: {
            type: 'external',
            external: { url: `${baseUrl}/api/file/${jobId}/${encodeURIComponent(image.filename)}` }
          }
        });
      }
    }

    const notionRes = await fetch(`${NOTION_API_BASE}/pages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { database_id: NOTION_DATABASE_ID },
        properties: { [titleProp]: { title: [{ text: { content: titleText } }] } },
        children
      })
    });
    const notionData = await notionRes.json();
    if (!notionRes.ok) {
      console.error('Notion API error:', notionData);
      return res.status(502).json({ error: notionData.message || '노션 저장에 실패했습니다.' });
    }

    res.json({ url: notionData.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '노션 저장 중 오류가 발생했습니다: ' + err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Instagram downloader running at http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  jobs,
  INSTAGRAM_URL_RE,
  execWithRetry,
  sortItems,
  preprocessForOcr,
  scoreLine,
  pickBestCandidate,
  ocrImage,
  extractOcrTitle,
  findExpiredJobIds,
  cleanupExpiredJobs,
  isPublicPath
};
