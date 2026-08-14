// 기본 유닛 테스트 — 외부 네트워크/yt-dlp 없이 순수 로직만 검증한다.
// node test/unit.js 로 직접 실행 (프레임워크 없이 assert 기반).

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  app,
  jobs,
  INSTAGRAM_URL_RE,
  execWithRetry,
  classifyDownloadError,
  sortItems,
  scoreLine,
  findExpiredJobIds,
  cleanupExpiredJobs,
  isPublicPath
} = require('../server.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((err) => {
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
      failed++;
    });
}

async function main() {
  console.log('=== URL 검증 (INSTAGRAM_URL_RE) ===');
  await test('릴스 링크를 허용한다', () => {
    assert.ok(INSTAGRAM_URL_RE.test('https://www.instagram.com/reel/ABC123/'));
  });
  await test('게시물 링크를 허용한다', () => {
    assert.ok(INSTAGRAM_URL_RE.test('https://instagram.com/p/ABC123'));
  });
  await test('IGTV 링크를 허용한다', () => {
    assert.ok(INSTAGRAM_URL_RE.test('https://www.instagram.com/tv/ABC123/'));
  });
  await test('인스타그램이 아닌 링크는 거부한다', () => {
    assert.strictEqual(INSTAGRAM_URL_RE.test('https://example.com/reel/ABC123'), false);
  });
  await test('http(비보안) 링크는 거부한다', () => {
    assert.strictEqual(INSTAGRAM_URL_RE.test('http://www.instagram.com/reel/ABC123'), false);
  });
  await test('프로필 링크(경로 없음)는 거부한다', () => {
    assert.strictEqual(INSTAGRAM_URL_RE.test('https://www.instagram.com/someuser/'), false);
  });

  console.log('=== 캐러셀 파일 순서 정렬 (sortItems) ===');
  await test('orderIndex 순서를 그대로 따른다', () => {
    const byId = new Map([
      ['zzz', { filename: 'zzz.jpg', isVideo: false }],
      ['aaa', { filename: 'aaa.jpg', isVideo: false }],
      ['mmm', { filename: 'mmm.jpg', isVideo: false }]
    ]);
    const orderIndex = new Map([['zzz', 0], ['aaa', 1], ['mmm', 2]]);
    const items = sortItems(byId, orderIndex);
    assert.deepStrictEqual(items.map((i) => i.filename), ['zzz.jpg', 'aaa.jpg', 'mmm.jpg']);
  });
  await test('순서 정보가 없으면 파일명순으로 정렬한다', () => {
    const byId = new Map([
      ['b', { filename: 'b.jpg', isVideo: false }],
      ['a', { filename: 'a.jpg', isVideo: false }]
    ]);
    const items = sortItems(byId, new Map());
    assert.deepStrictEqual(items.map((i) => i.filename), ['a.jpg', 'b.jpg']);
  });
  await test('video/image 타입을 올바르게 반영한다', () => {
    const byId = new Map([['a', { filename: 'a.mp4', isVideo: true }]]);
    const items = sortItems(byId, new Map());
    assert.strictEqual(items[0].type, 'video');
  });

  console.log('=== 재시도 로직 (execWithRetry) ===');
  await test('계속 실패하는 커맨드는 재시도 소진 후 에러를 던진다', async () => {
    await assert.rejects(() =>
      execWithRetry('node', ['-e', 'process.exit(1)'], { timeout: 5000 }, 2, 50)
    );
  });
  await test('모든 재시도 소진 후에는 에러를 던진다', async () => {
    const start = Date.now();
    await assert.rejects(() =>
      execWithRetry('node', ['-e', 'process.exit(1)'], { timeout: 5000 }, 2, 20)
    );
    const elapsed = Date.now() - start;
    // 재시도 2번 * 최소 delay(20,40ms)만큼은 걸려야 함(재시도가 실제로 일어났다는 방증)
    assert.ok(elapsed >= 40, `재시도 지연이 반영되지 않은 것 같음 (elapsed=${elapsed}ms)`);
  });
  await test('성공하면 재시도 없이 바로 결과를 반환한다', async () => {
    const { stdout } = await execWithRetry('node', ['-e', 'console.log("hi")'], { timeout: 5000 }, 2, 20);
    assert.strictEqual(stdout.trim(), 'hi');
  });

  console.log('=== OCR 줄 점수 (scoreLine) ===');
  await test('한글 줄은 양수 점수를 받는다', () => {
    assert.ok(scoreLine('오늘의 추천 맛집') > 0);
  });
  await test('빈 줄/짧은 줄은 탈락한다', () => {
    assert.strictEqual(scoreLine(''), -Infinity);
    assert.strictEqual(scoreLine('ab'), -Infinity);
  });
  await test('기호가 섞인 노이즈 줄은 탈락한다', () => {
    assert.strictEqual(scoreLine('し K ) @'), -Infinity);
  });

  console.log('=== 만료된 작업 디렉토리 정리 (findExpiredJobIds / cleanupExpiredJobs) ===');
  await test('TTL 지난 job만 만료로 판별한다', () => {
    const now = 1_000_000;
    const jobsMap = new Map([
      ['old', { createdAt: now - 20 * 60 * 1000 }],
      ['fresh', { createdAt: now - 1 * 60 * 1000 }]
    ]);
    const expired = findExpiredJobIds(jobsMap, now, 10 * 60 * 1000);
    assert.deepStrictEqual(expired, ['old']);
  });
  await test('cleanupExpiredJobs가 실제로 디렉토리를 삭제하고 jobs 맵에서도 제거한다', async () => {
    const now = Date.now();
    const oldDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ig-cleanup-test-'));
    const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ig-cleanup-test-'));
    const jobsMap = new Map([
      ['old', { dir: oldDir, createdAt: now - 20 * 60 * 1000 }],
      ['fresh', { dir: freshDir, createdAt: now }]
    ]);

    await cleanupExpiredJobs(jobsMap, now, 10 * 60 * 1000);

    assert.strictEqual(jobsMap.has('old'), false);
    assert.strictEqual(jobsMap.has('fresh'), true);
    await assert.rejects(() => fs.access(oldDir), '만료된 job의 디렉토리가 실제로 삭제되어야 함');
    await assert.doesNotReject(() => fs.access(freshDir), '만료되지 않은 job의 디렉토리는 남아있어야 함');

    await fs.rm(freshDir, { recursive: true, force: true }).catch(() => {});
  });

  console.log('=== 폴링 진행 단계 (/api/status/:jobId step 필드) ===');
  // 실제 서버를 임시 포트에 띄우고 jobs 맵에 가짜 job을 넣어 status 응답을 검증한다.
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  await test('진행 중인 job은 step 필드를 그대로 반환한다', async () => {
    jobs.set('test-job-step', { dir: '/tmp/does-not-matter', createdAt: Date.now(), status: 'pending', step: 'OCR 처리 중' });
    const res = await fetch(`${base}/api/status/test-job-step`);
    const data = await res.json();
    assert.strictEqual(data.status, 'pending');
    assert.strictEqual(data.step, 'OCR 처리 중');
    jobs.delete('test-job-step');
  });
  await test('step이 없는 pending job은 step:null을 반환한다', async () => {
    jobs.set('test-job-nostep', { dir: '/tmp/does-not-matter', createdAt: Date.now(), status: 'pending' });
    const res = await fetch(`${base}/api/status/test-job-nostep`);
    const data = await res.json();
    assert.strictEqual(data.status, 'pending');
    assert.strictEqual(data.step, null);
    jobs.delete('test-job-nostep');
  });
  console.log('=== PWA (manifest / 아이콘 / 인증 예외 경로) ===');
  await test('manifest.json이 유효하고 필수 필드를 갖고 있다', async () => {
    const raw = await fs.readFile(path.join(__dirname, '..', 'public', 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw);
    assert.ok(manifest.name);
    assert.ok(manifest.short_name);
    assert.strictEqual(manifest.display, 'standalone');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  });
  await test('아이콘 PNG 파일이 존재하고 시그니처/크기가 올바르다', async () => {
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const [filename, size] of [
      ['icon-192.png', 192],
      ['icon-512.png', 512],
      ['apple-touch-icon.png', 180]
    ]) {
      const buf = await fs.readFile(path.join(__dirname, '..', 'public', 'icons', filename));
      assert.ok(buf.subarray(0, 8).equals(pngSig), `${filename}이 PNG 시그니처로 시작하지 않음`);
      assert.strictEqual(buf.readUInt32BE(16), size, `${filename} width가 ${size}가 아님`);
      assert.strictEqual(buf.readUInt32BE(20), size, `${filename} height가 ${size}가 아님`);
    }
  });
  await test('index.html에 manifest/apple-touch-icon 링크가 있다', async () => {
    const html = await fs.readFile(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(html.includes('rel="manifest"'));
    assert.ok(html.includes('apple-touch-icon'));
  });
  await test('isPublicPath가 manifest/아이콘/로그인만 인증 예외로 허용한다', () => {
    assert.strictEqual(isPublicPath('/manifest.json'), true);
    assert.strictEqual(isPublicPath('/icons/icon-192.png'), true);
    assert.strictEqual(isPublicPath('/login'), true);
    assert.strictEqual(isPublicPath('/'), false);
    assert.strictEqual(isPublicPath('/api/prepare'), false);
  });
  await test('테스트 서버에서 manifest/아이콘이 정적으로 서빙된다', async () => {
    const res1 = await fetch(`${base}/manifest.json`);
    assert.strictEqual(res1.status, 200);
    const res2 = await fetch(`${base}/icons/icon-192.png`);
    assert.strictEqual(res2.status, 200);
  });

  console.log('=== 다운로드 실패 사유 분류 (classifyDownloadError) ===');
  await test('비공개 계정 메시지를 private으로 분류한다', () => {
    const c = classifyDownloadError('ERROR: [Instagram] ABC123: This account is private');
    assert.strictEqual(c.reason, 'private');
  });
  await test('삭제된 게시물 메시지를 not_found로 분류한다', () => {
    const c = classifyDownloadError('ERROR: [Instagram] ABC123: content has been removed');
    assert.strictEqual(c.reason, 'not_found');
  });
  await test('요청 제한 메시지를 restricted로 분류한다', () => {
    const c = classifyDownloadError(
      'ERROR: [Instagram] Requested content is not available, rate-limit reached or login required'
    );
    assert.strictEqual(c.reason, 'restricted');
  });
  await test('지원하지 않는 URL 메시지를 unsupported_url로 분류한다', () => {
    const c = classifyDownloadError('ERROR: Unsupported URL: https://example.com/x');
    assert.strictEqual(c.reason, 'unsupported_url');
  });
  await test('타임아웃/네트워크 메시지를 network로 분류한다', () => {
    const c = classifyDownloadError('Error: connect ETIMEDOUT 1.2.3.4:443');
    assert.strictEqual(c.reason, 'network');
  });
  await test('알 수 없는/빈 메시지는 unknown으로 분류한다', () => {
    assert.strictEqual(classifyDownloadError('').reason, 'unknown');
    assert.strictEqual(classifyDownloadError(null).reason, 'unknown');
    assert.strictEqual(classifyDownloadError('뭔가 다른 이상한 에러').reason, 'unknown');
  });
  await test('각 사유마다 사람이 읽을 수 있는 한국어 메시지를 준다', () => {
    const c = classifyDownloadError('This account is private');
    assert.ok(c.message.includes('비공개'));
  });

  server.close();

  console.log(`\n${passed}개 통과, ${failed}개 실패`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
