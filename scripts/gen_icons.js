// PWA 아이콘 생성 스크립트 — 외부 의존성 없이 순수 Node(zlib)로 PNG를 만든다.
// 인스타 그라디언트 배경(45deg, index.html의 --accent-grad와 동일 색상) 위에
// 흰색 다운로드 화살표 글리프를 그린다.
// 실행: node scripts/gen_icons.js → public/icons/*.png 재생성

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

// index.html의 --accent-grad: linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888)
const GRADIENT_STOPS = [
  [0xf0, 0x94, 0x33],
  [0xe6, 0x68, 0x3c],
  [0xdc, 0x27, 0x43],
  [0xcc, 0x23, 0x66],
  [0xbc, 0x18, 0x88]
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function gradientColor(t) {
  t = Math.max(0, Math.min(1, t));
  const segCount = GRADIENT_STOPS.length - 1;
  const seg = Math.min(segCount - 1, Math.floor(t * segCount));
  const localT = t * segCount - seg;
  const [r0, g0, b0] = GRADIENT_STOPS[seg];
  const [r1, g1, b1] = GRADIENT_STOPS[seg + 1];
  return [
    Math.round(lerp(r0, r1, localT)),
    Math.round(lerp(g0, g1, localT)),
    Math.round(lerp(b0, b1, localT))
  ];
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// pixels: RGBA Buffer, length = width*height*4
function encodePng(width, height, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = chunk('IHDR', ihdrData);

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });
  const idat = chunk('IDAT', idatData);

  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

function setPixel(pixels, width, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= width) return;
  const idx = (y * width + x) * 4;
  if (idx < 0 || idx >= pixels.length) return;
  pixels[idx] = r;
  pixels[idx + 1] = g;
  pixels[idx + 2] = b;
  pixels[idx + 3] = a;
}

// maskable 아이콘 규격을 고려해 가장자리에 안전 여백을 두고,
// 배경은 대각선 그라디언트, 중앙에는 흰색 다운로드 화살표(막대+삼각형)를 그린다.
function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * (size - 1)); // 45deg 대각선 진행률
      const [r, g, b] = gradientColor(t);
      setPixel(pixels, size, x, y, r, g, b, 255);
    }
  }

  const cx = size / 2;
  const stemW = size * 0.12;
  const stemTop = size * 0.28;
  const stemBottom = size * 0.55;
  const headW = size * 0.32;
  const headTop = stemBottom;
  const headBottom = size * 0.72;
  const baseW = size * 0.4;
  const baseY = size * 0.78;
  const baseH = size * 0.06;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let isWhite = false;

      if (y >= stemTop && y < stemBottom && Math.abs(x - cx) <= stemW / 2) {
        isWhite = true;
      }

      if (y >= headTop && y < headBottom) {
        const progress = (y - headTop) / (headBottom - headTop);
        const halfWidthAtY = (headW / 2) * (1 - progress);
        if (Math.abs(x - cx) <= halfWidthAtY) isWhite = true;
      }

      if (y >= baseY && y < baseY + baseH && Math.abs(x - cx) <= baseW / 2) {
        isWhite = true;
      }

      if (isWhite) setPixel(pixels, size, x, y, 255, 255, 255, 255);
    }
  }

  return encodePng(size, size, pixels);
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const targets = [
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['apple-touch-icon.png', 180]
  ];
  for (const [filename, size] of targets) {
    const png = drawIcon(size);
    fs.writeFileSync(path.join(OUT_DIR, filename), png);
    console.log(`생성됨: ${filename} (${size}x${size}, ${png.length} bytes)`);
  }
}

main();
