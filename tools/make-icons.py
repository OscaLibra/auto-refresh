#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成扩展图标（16 / 48 / 128 PNG）。

不依赖 Pillow：直接用 zlib + struct 手写 PNG，保证在任何 Python 3 环境都能跑。
图形语义：蓝色圆角方块 + 白色环形箭头（顺时针刷新）。
做法：4 倍超采样后盒式降采样，得到平滑边缘（16px 下也能看清）。
"""

import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
SIZES = (16, 48, 128)
SS = 4  # 超采样倍数

BG = (37, 99, 235)      # #2563eb，与扩展页主色一致
FG = (255, 255, 255)

RADIUS_RATIO = 0.22     # 圆角半径占边长比例
RING_RATIO = 0.30       # 环半径
STROKE_RATIO = 0.092    # 环线宽


def rounded_rect_alpha(x, y, s, r):
    """返回点 (x, y) 落在圆角方形内的覆盖率（0/1，超采样下无需抗锯齿）。"""
    # 先缩到四个角的坐标系里判断
    dx = min(x, s - x)
    dy = min(y, s - y)
    if dx >= r or dy >= r:
        return 1.0 if (0 <= x < s and 0 <= y < s) else 0.0
    # 角区：判断到圆心距离
    cx = r if x < r else s - r
    cy = r if y < r else s - r
    return 1.0 if (x - cx) ** 2 + (y - cy) ** 2 <= r * r else 0.0


def in_triangle(px, py, a, b, c):
    """重心坐标法判断点是否在三角形内。"""
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def render(size):
    s = float(size)
    cx = cy = s / 2.0
    r = s * RING_RATIO
    half_w = s * STROKE_RATIO / 2.0
    rad = s * RADIUS_RATIO

    # 环的缺口在正上方（θ 250°~310°，屏幕坐标系 y 向下）
    arc_start = math.radians(310)
    arc_sweep = math.radians(300)

    # 箭头：位于缺口右侧起点，沿顺时针切线方向
    theta = math.radians(300)
    px, py = cx + r * math.cos(theta), cy + r * math.sin(theta)
    tx, ty = -math.sin(theta), math.cos(theta)          # 顺时针切线
    nx, ny = math.cos(theta), math.sin(theta)           # 径向
    head_h = s * 0.135
    head_w = s * 0.105
    apex = (px + tx * head_h, py + ty * head_h)
    base1 = (px + nx * head_w, py + ny * head_w)
    base2 = (px - nx * head_w, py - ny * head_w)

    hi = size * SS
    pixels = [[(0, 0, 0, 0)] * hi for _ in range(hi)]

    for j in range(hi):
        y = (j + 0.5) / SS
        for i in range(hi):
            x = (i + 0.5) / SS
            if rounded_rect_alpha(x, y, s, rad) <= 0:
                continue
            color = BG
            dx, dy = x - cx, y - cy
            d = math.hypot(dx, dy)

            # 环：距离在带宽内，且角度落在圆弧区间（避开缺口）
            if abs(d - r) <= half_w:
                ang = math.atan2(dy, dx) - arc_start
                ang %= 2 * math.pi
                if ang <= arc_sweep:
                    color = FG

            # 箭头
            if in_triangle(x, y, apex, base1, base2):
                color = FG

            pixels[j][i] = (color[0], color[1], color[2], 255)

    # 盒式降采样
    out = bytearray()
    for j in range(size):
        out.append(0)  # filter type 0
        for i in range(size):
            r_acc = g_acc = b_acc = a_acc = 0
            for dj in range(SS):
                for di in range(SS):
                    pr, pg, pb, pa = pixels[j * SS + dj][i * SS + di]
                    # 预乘 alpha 后再平均，避免边缘出现黑边
                    r_acc += pr * pa
                    g_acc += pg * pa
                    b_acc += pb * pa
                    a_acc += pa
            n = SS * SS
            if a_acc == 0:
                out.extend((0, 0, 0, 0))
            else:
                out.extend((r_acc // a_acc, g_acc // a_acc, b_acc // a_acc, a_acc // n))
    return bytes(out)


def write_png(path, size):
    raw = render(size)
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        write_png(path, size)
        print(f"generated {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
