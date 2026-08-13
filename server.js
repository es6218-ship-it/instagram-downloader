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

app.use(express.json());
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
const OCR_PSM_MODES = [6, 4, 11, 3];

const jobs = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
      jobs.delete(jobId);
    }
  }
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

  await execWithRetry(
    YT_DLP,
    ['--no-playlist', '--ignore-no-formats-error', '-S', 'vcodec:h264', '-o', outputTemplate, url],
    EXEC_OPTS
  ).catch(() => {});

  let meta = null;
  const orderIndex = new Map();
  try {
    const { stdout } = await execWithRetry(
      YT_DLP,
      ['--no-playlist', '--ignore-no-formats-error', '--skip-download', '-j', '-o', outputTemplate, url],
      EXEC_OPTS
    );
    const jsonLines = stdout.split('\n').filter((l) => l.trim().startsWith('{'));
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

  await execWithRetry(
    YT_DLP,
    ['--no-playlist', '--ignore-no-formats-error', '--write-thumbnail', '--skip-download', '-o', outputTemplate, url],
    EXEC_OPTS
  ).catch(() => {});

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
// 여러 전처리 변형 x 여러 PSM 모드로 인식한 뒤, 그 중 가장 그럴듯한 후보(줄 묶음)를 고른다.
async function ocrImage(imagePath, tmpDir) {
  const preFiles = [];
  const candidates = [];

  try {
    for (let i = 0; i < OCR_PREPROCESS_VARIANTS.length; i++) {
      const outPath = path.join(tmpDir, `__ocr_pre_${i}_${Date.now()}.png`);
      try {
        await preprocessForOcr(imagePath, outPath, OCR_PREPROCESS_VARIANTS[i]);
        preFiles.push(outPath);
      } catch (_) {
        continue;
      }
      for (const psm of OCR_PSM_MODES) {
        try {
          const text = await tesseractText(outPath, psm);
          candidates.push(text);
        } catch (_) {
          // skip this psm/variant combo
        }
      }
    }
  } finally {
    await Promise.all(preFiles.map((f) => fs.rm(f, { force: true }).catch(() => {})));
  }

  if (candidates.length === 0) return null;
  return pickBestCandidate(candidates);
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

app.post('/api/prepare', async (req, res) => {
  const url = (req.body && req.body.url || '').trim();

  if (!INSTAGRAM_URL_RE.test(url)) {
    return res.status(400).json({ error: '올바른 인스타그램 게시물/릴스 링크가 아닙니다.' });
  }

  const jobId = crypto.randomUUID();
  const tmpDir = path.join(os.tmpdir(), 'ig-dl-' + jobId);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const { items, meta } = await downloadAllMedia(url, tmpDir);

    if (items.length === 0) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      return res.status(502).json({ error: '다운로드할 수 있는 사진/영상을 찾지 못했습니다. 비공개 계정이거나 링크를 확인해주세요.' });
    }

    const ocrTitle = await extractOcrTitle(tmpDir, items);
    if (meta) meta.ocrTitle = ocrTitle;

    jobs.set(jobId, { dir: tmpDir, createdAt: Date.now(), items, meta });
    res.json({ jobId, items, caption: meta ? meta.description : null, ocrTitle });
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    console.error(err.stderr || err.message);
    res.status(502).json({ error: '다운로드에 실패했습니다. 링크를 확인하거나 잠시 후 다시 시도해주세요.' });
  }
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

    const firstImage = (job.items || []).find((it) => it.type === 'image');
    if (firstImage) {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      children.push({
        object: 'block',
        type: 'image',
        image: {
          type: 'external',
          external: { url: `${baseUrl}/api/file/${jobId}/${encodeURIComponent(firstImage.filename)}` }
        }
      });
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
  INSTAGRAM_URL_RE,
  execWithRetry,
  sortItems,
  preprocessForOcr,
  scoreLine,
  pickBestCandidate,
  ocrImage,
  extractOcrTitle
};
