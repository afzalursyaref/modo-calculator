#!/usr/bin/env python3
"""
Generate icon PNG (16, 48, 128) untuk Modo Calculator.
Pure-Python PNG (struct + zlib), tidak butuh PIL.

Desain: rounded square gradient gelap dengan tombol kalkulator stylized.
"""

import os
import struct
import zlib

OUT_DIR = os.path.dirname(os.path.abspath(__file__))


def png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + chunk_type
        + data
        + struct.pack(">I", zlib.crc32(chunk_type + data) & 0xFFFFFFFF)
    )


def write_png(path: str, width: int, height: int, pixels: list) -> None:
    """pixels: flat list of (r,g,b,a) tuples, length = w*h."""
    raw = bytearray()
    idx = 0
    for _y in range(height):
        raw.append(0)  # filter: None
        for _x in range(width):
            r, g, b, a = pixels[idx]
            raw.extend((r, g, b, a))
            idx += 1
    compressed = zlib.compress(bytes(raw), 9)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(png_chunk(b"IHDR", ihdr))
        f.write(png_chunk(b"IDAT", compressed))
        f.write(png_chunk(b"IEND", b""))


def lerp(a, b, t):
    return a + (b - a) * t


def blend(c1, c2, t):
    return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(4))


def in_rounded_rect(x, y, w, h, r):
    """True jika (x,y) ada di dalam rounded rect (0..w, 0..h) dgn radius r."""
    if x < 0 or y < 0 or x >= w or y >= h:
        return False
    cx = max(r, min(w - r - 1, x))
    cy = max(r, min(h - r - 1, y))
    dx = x - cx
    dy = y - cy
    return (dx * dx + dy * dy) <= r * r


def draw_icon(size: int) -> list:
    """Render icon ukuran `size` x `size`, return list pixel RGBA."""
    px = [(0, 0, 0, 0)] * (size * size)

    radius = max(2, size * 22 // 100)  # ~22% dari sisi (macOS app icon style)
    # Background gradient: hitam-pekat ke abu kebiruan
    top_color = (45, 47, 56, 255)
    bot_color = (24, 24, 28, 255)

    for y in range(size):
        for x in range(size):
            if in_rounded_rect(x, y, size, size, radius):
                t = y / max(1, size - 1)
                px[y * size + x] = blend(top_color, bot_color, t)

    # Aksen orange (= sign) di tengah
    orange = (255, 149, 0, 255)
    if size >= 32:
        # Dua bar horizontal — gaya tombol "="
        bar_w = int(size * 0.46)
        bar_h = max(2, int(size * 0.085))
        gap = max(2, int(size * 0.10))
        x0 = (size - bar_w) // 2
        y_center = int(size * 0.62)
        y1 = y_center - gap // 2 - bar_h
        y2 = y_center + gap // 2

        for y in range(y1, y1 + bar_h):
            for x in range(x0, x0 + bar_w):
                if in_rounded_rect(x, y, size, size, radius):
                    px[y * size + x] = orange
        for y in range(y2, y2 + bar_h):
            for x in range(x0, x0 + bar_w):
                if in_rounded_rect(x, y, size, size, radius):
                    px[y * size + x] = orange

        # Plus kecil di kiri-atas (aksen "tombol")
        plus_size = max(3, int(size * 0.20))
        plus_thick = max(1, int(size * 0.06))
        cx = int(size * 0.30)
        cy = int(size * 0.30)
        # horizontal bar
        for y in range(cy - plus_thick // 2, cy - plus_thick // 2 + plus_thick):
            for x in range(cx - plus_size // 2, cx - plus_size // 2 + plus_size):
                if in_rounded_rect(x, y, size, size, radius):
                    px[y * size + x] = (255, 255, 255, 235)
        # vertical bar
        for y in range(cy - plus_size // 2, cy - plus_size // 2 + plus_size):
            for x in range(cx - plus_thick // 2, cx - plus_thick // 2 + plus_thick):
                if in_rounded_rect(x, y, size, size, radius):
                    px[y * size + x] = (255, 255, 255, 235)
    else:
        # Ukuran kecil (16): cukup satu "=" tebal
        bar_w = int(size * 0.55)
        bar_h = max(1, int(size * 0.14))
        gap = max(1, int(size * 0.18))
        x0 = (size - bar_w) // 2
        y_center = size // 2
        y1 = y_center - gap // 2 - bar_h
        y2 = y_center + gap // 2

        for y in range(y1, y1 + bar_h):
            for x in range(x0, x0 + bar_w):
                if in_rounded_rect(x, y, size, size, radius):
                    px[y * size + x] = orange
        for y in range(y2, y2 + bar_h):
            for x in range(x0, x0 + bar_w):
                if in_rounded_rect(x, y, size, size, radius):
                    px[y * size + x] = orange

    return px


def main():
    for size in (16, 48, 128):
        pixels = draw_icon(size)
        out_path = os.path.join(OUT_DIR, f"icon{size}.png")
        write_png(out_path, size, size, pixels)
        print(f"Wrote {out_path} ({size}x{size})")


if __name__ == "__main__":
    main()
