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
const OCR_LANGS = 'kor+eng+jpn';

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

async function downloadAllMedia(url, tmpDir) {
  const outputTemplate = path.join(tmpDir, '%(id)s.%(ext)s');

  await execFileAsync(
    YT_DLP,
    ['--no-playlist', '--ignore-no-formats-error', '-S', 'vcodec:h264', '-o', outputTemplate, url],
    EXEC_OPTS
  ).catch(() => {});

  let meta = null;
  const orderIndex = new Map();
  try {
    const { stdout } = await execFileAsync(
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

  await execFileAsync(
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

  const items = [...byId.entries()]
    .sort(([idA], [idB]) => {
      const rankA = orderIndex.has(idA) ? orderIndex.get(idA) : Infinity;
      const rankB = orderIndex.has(idB) ? orderIndex.get(idB) : Infinity;
      if (rankA !== rankB) return rankA - rankB;
      return idA.localeCompare(idB);
    })
    .map(([, v]) => ({ filename: v.filename, type: v.isVideo ? 'video' : 'image' }));

  return { items, meta };
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
    const { stdout } = await execFileAsync(
      TESSERACT,
      [ocrTargetPath, 'stdout', '-l', OCR_LANGS],
      EXEC_OPTS
    );
    const cleaned = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length >= 2)
      .join('\n')
      .trim();
    return cleaned || null;
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

app.listen(PORT, () => {
  console.log(`Instagram downloader running at http://localhost:${PORT}`);
});
