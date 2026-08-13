#!/usr/bin/env python3
"""한국어 오버레이 제목 텍스트가 들어간 테스트 이미지를 생성한다.

실제 인스타그램 게시물처럼, 사진/그라디언트 배경 위에 큰 한글 제목이
얹혀 있는 상황을 흉내 낸다. server.js OCR 개선(전/후) 비교 테스트에 쓰인다.

의존성: Pillow, NanumGothic 폰트(fonts-nanum).
"""
import json
import os
import random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 720, 900
FONT_BOLD = "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf"
OUT_DIR = os.path.join(os.path.dirname(__file__), "fixtures")

# (파일명, 제목텍스트, 배경스타일, 밴드여부)
# band=True: 텍스트 뒤에 반투명 어두운 밴드(실제 인스타 제목 오버레이에서 매우 흔한 스타일).
CASES = [
    ("case1", "오늘의 추천 맛집", "gradient", True),
    ("case2", "제주도 여행 브이로그", "photo", True),
    ("case3", "집에서 만드는 파스타", "gradient", False),
    ("case4", "운동 루틴 공유합니다", "photo", True),
    ("case5", "겨울 코디 추천", "gradient", False),
]


def noisy_bg(w, h, style, seed):
    rnd = random.Random(seed)
    img = Image.new("RGB", (w, h))
    px = img.load()
    if style == "gradient":
        c1 = tuple(rnd.randint(30, 120) for _ in range(3))
        c2 = tuple(rnd.randint(30, 120) for _ in range(3))
        for y in range(h):
            t = y / h
            row = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
            for x in range(w):
                px[x, y] = row
    else:
        base = tuple(rnd.randint(40, 100) for _ in range(3))
        for y in range(h):
            for x in range(w):
                jitter = rnd.randint(-15, 15)
                px[x, y] = tuple(max(0, min(255, base[i] + jitter)) for i in range(3))
        img = img.filter(ImageFilter.GaussianBlur(2))
    return img


def draw_title(img, text, band):
    w, h = img.size
    draw = ImageDraw.Draw(img, "RGBA")
    font_size = int(h * 0.075)
    font = ImageFont.truetype(FONT_BOLD, font_size)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (w - tw) / 2
    ty = h * 0.42

    if band:
        pad = 24
        draw.rectangle(
            [tx - pad, ty - pad * 0.6, tx + tw + pad, ty + th + pad * 0.6],
            fill=(0, 0, 0, 140),
        )
        fill = (255, 255, 255, 255)
    else:
        # 그림자만 (저대비 상황 재현)
        draw.text((tx + 2, ty + 2), text, font=font, fill=(0, 0, 0, 160))
        fill = (240, 240, 240, 255)

    draw.text((tx, ty), text, font=font, fill=fill)
    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = {}
    for i, (name, text, style, band) in enumerate(CASES):
        img = noisy_bg(W, H, style, seed=i + 7)
        img = draw_title(img, text, band)
        path = os.path.join(OUT_DIR, f"{name}.jpg")
        img.convert("RGB").save(path, quality=90)
        manifest[name] = text
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"생성 완료: {len(CASES)} 개 이미지 -> {OUT_DIR}")


if __name__ == "__main__":
    main()
