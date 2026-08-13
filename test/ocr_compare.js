// OCR 한국어 인식 개선 전/후 비교 테스트.
//
// OLD: 기존 방식 — 전처리 없이 `tesseract img stdout -l kor+eng+jpn`.
// NEW: server.js의 ocrImage() — 전처리(확대/그레이/대비/언샤프) + 다중 PSM 베스트.
//
// test/fixtures/*.jpg (한글 오버레이 제목 이미지)에 대해 두 방식을 돌리고
// 정답과의 문자 단위 유사도(정규화 편집거리)를 비교한다.
// NEW 평균 정확도가 OLD보다 확실히 높으면 성공.

const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FIX = path.join(__dirname, 'fixtures');
const { ocrImage } = require('../server.js');

// 픽스처 이미지가 없으면 파이썬 생성기로 만든다(Pillow + NanumGothic 필요).
function ensureFixtures() {
  const manifestPath = path.join(FIX, 'manifest.json');
  const ready =
    fs.existsSync(manifestPath) &&
    JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (ready) return;
  execSync(`python3 ${path.join(__dirname, 'gen_fixtures.py')}`, { stdio: 'inherit' });
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function accuracy(expected, actual) {
  if (!actual) return 0;
  const clean = (s) => s.replace(/\s+/g, '');
  const e = clean(expected);
  const a = clean(actual);
  if (e.length === 0) return 1;
  const dist = levenshtein(e, a);
  return Math.max(0, 1 - dist / e.length);
}

async function oldMethod(imgPath) {
  try {
    const { stdout } = await execFileAsync('/usr/bin/tesseract', [imgPath, 'stdout', '-l', 'kor+eng+jpn'], { timeout: 30000 });
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  } catch (_) {
    return '';
  }
}

async function main() {
  ensureFixtures();
  const manifest = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8'));
  const names = Object.keys(manifest);

  let oldTotal = 0, newTotal = 0, newWins = 0;
  console.log('=== OCR 한국어 인식 전/후 비교 ===');
  for (const name of names) {
    const imgPath = path.join(FIX, `${name}.jpg`);
    const expected = manifest[name];
    const oldText = await oldMethod(imgPath);
    const newText = await ocrImage(imgPath, FIX);
    const oldAcc = accuracy(expected, oldText);
    const newAcc = accuracy(expected, newText || '');
    oldTotal += oldAcc;
    newTotal += newAcc;
    if (newAcc >= oldAcc) newWins++;
    console.log(`[${name}.jpg] 정답: "${expected}"`);
    console.log(`  OLD (${Math.round(oldAcc * 100)}%): "${oldText}"`);
    console.log(`  NEW (${Math.round(newAcc * 100)}%): "${newText || ''}"`);
  }

  const oldAvg = (oldTotal / names.length) * 100;
  const newAvg = (newTotal / names.length) * 100;
  console.log(`OLD 평균 정확도: ${oldAvg.toFixed(1)}%`);
  console.log(`NEW 평균 정확도: ${newAvg.toFixed(1)}%`);
  console.log(`NEW가 이기거나 동률: ${newWins}/${names.length} 케이스`);

  const pass = newAvg > oldAvg && newWins === names.length;
  console.log(`결과: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
