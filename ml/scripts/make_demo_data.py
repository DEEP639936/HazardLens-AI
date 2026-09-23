#!/usr/bin/env python3
"""Generate a tiny synthetic road-hazard dataset so the whole pipeline runs
offline with zero downloads.

Procedurally renders road-texture images (asphalt speckle noise, lane
markings, curbs) and stamps 1-3 hazards per image from the 7 canonical
classes, emitting a YOLO-layout dataset:

    <out>/images/all/*.jpg
    <out>/labels/all/*.txt        (class_id cx cy w h — normalized)
    <out>/make_demo_data.manifest.json

Deterministic given --seed. Pair with scripts/split_dataset.py (70/20/10)
and dataset/road_hazards.demo.yaml (written automatically) to train.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hazard_domain import CLASS_TO_ID, HAZARD_CLASSES  # noqa: E402

IMG_EXT = ".jpg"


def _rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def _asphalt_base(size: int, rng: np.random.Generator) -> np.ndarray:
    """Dark asphalt with speckle noise + subtle vertical road gradient."""
    base = rng.integers(38, 58, dtype=np.uint8)
    img = np.full((size, size, 3), 0, dtype=np.uint8)
    img[..., :] = base
    noise = rng.normal(0, 9, (size, size)).astype(np.float32)
    # low-frequency shading so the road is not perfectly flat
    x = np.linspace(0, 1, size, dtype=np.float32)
    shade = 14 * np.sin(np.pi * x)[:, None]
    gray = np.clip(img[..., 0].astype(np.float32) + noise + shade, 0, 255)
    img[..., 0] = gray
    img[..., 1] = np.clip(gray * 0.98, 0, 255)
    img[..., 2] = np.clip(gray * 1.02, 0, 255)
    # speckles (aggregate stones)
    n_stones = int(size * size * 0.010)
    ys = rng.integers(0, size, n_stones)
    xs = rng.integers(0, size, n_stones)
    r = rng.integers(1, 3, n_stones)
    shade = rng.integers(-30, 34, n_stones)
    for y0, x0, r0, s0 in zip(ys, xs, r, shade):
        c = int(np.clip(base + s0, 0, 255))
        cv2.circle(img, (int(x0), int(y0)), int(r0), (c, c, c), -1)
    return img


def _draw_lane_marking(img, rng, size) -> tuple[int, int, int, int]:
    """Dashed white lane line; returns normalized (x, y, w, h)."""
    y0 = int(rng.integers(size * 0.15, size * 0.85))
    x0 = int(rng.integers(size * 0.05, size * 0.35))
    dashes = int(rng.integers(4, 7))
    dash_len, gap, thickness = size // 16, size // 24, max(3, size // 90)
    x = x0
    pts = []
    for _ in range(dashes):
        cv2.rectangle(
            img, (x, y0 - thickness // 2), (x + dash_len, y0 + thickness // 2),
            (225, 225, 220), -1,
        )
        pts.append((x, y0))
        x += dash_len + gap
    total_w = dashes * dash_len + (dashes - 1) * gap
    return (
        x0 / size,
        (y0 - thickness) / size,
        min(total_w, size - x0) / size,
        (2 * thickness) / size,
    )


def _draw_pothole(img, rng, size) -> tuple[int, int, int, int]:
    cx, cy = int(rng.integers(size * 0.2, size * 0.8)), int(rng.integers(size * 0.2, size * 0.8))
    rx, ry = int(rng.integers(size // 16, size // 8)), int(rng.integers(size // 20, size // 10))
    canvas = np.zeros_like(img[..., 0])
    cv2.ellipse(canvas, (cx, cy), (rx, ry), rng.integers(0, 180), 0, 360, 255, -1)
    # jagged rim: random small bites/extra bumps
    for _ in range(10):
        ang = rng.integers(0, 360)
        px = int(cx + rx * np.cos(np.deg2rad(ang)) * rng.uniform(0.85, 1.15))
        py = int(cy + ry * np.sin(np.deg2rad(ang)) * rng.uniform(0.85, 1.15))
        cv2.circle(canvas, (px, py), int(size // 60), 255, -1)
    mask = canvas.astype(bool)
    depth = rng.uniform(0.55, 0.75)
    img[mask] = (img[mask] * depth).astype(np.uint8)
    cv2.ellipse(img, (cx, cy), (rx + 2, ry + 2), 0, 0, 360, (30, 30, 32), 1)
    return ((cx - rx) / size, (cy - ry) / size, 2 * rx / size, 2 * ry / size)


def _draw_crack(img, rng, size) -> tuple[int, int, int, int]:
    x, y = float(rng.integers(size * 0.1, size * 0.9)), float(rng.integers(size * 0.1, size * 0.2))
    pts, min_x, min_y, max_x, max_y = [ (int(x), int(y)) ], x, y, x, y
    direction = float(rng.uniform(-np.pi / 3, np.pi / 3))
    length = rng.integers(size // 3, size)
    for _ in range(int(length // (size / 40))):
        direction += rng.uniform(-0.5, 0.5)
        step = rng.integers(size // 40, size // 18)
        x = float(np.clip(x + step * np.cos(direction), 2, size - 2))
        y = float(np.clip(y + abs(step * np.sin(direction)) * rng.choice([-1, 1]), 2, size - 2))
        pts.append((int(x), int(y)))
        min_x, min_y = min(min_x, x), min(min_y, y)
        max_x, max_y = max(max_x, x), max(max_y, y)
    thickness = max(2, size // 110)
    cv2.polylines(img, [np.int32(pts)], False, (18, 18, 20), thickness, cv2.LINE_AA)
    for px, py in pts[:: max(1, len(pts) // 6)]:  # hairline branches
        bx = px + int(rng.integers(-size // 30, size // 30))
        by = py + int(rng.integers(-size // 30, size // 30))
        cv2.line(img, (px, py), (bx, by), (22, 22, 24), max(1, thickness - 1), cv2.LINE_AA)
    return (
        max(0, min_x - 4) / size,
        max(0, min_y - 4) / size,
        min(size, max_x - min_x + 8) / size,
        min(size, max_y - min_y + 8) / size,
    )


def _draw_erosion(img, rng, size) -> tuple[int, int, int, int]:
    cx, cy = int(rng.integers(size * 0.25, size * 0.75)), int(rng.integers(size * 0.25, size * 0.75))
    rx, ry = int(rng.integers(size // 8, size // 4)), int(rng.integers(size // 10, size // 5))
    overlay = img.copy()
    cv2.ellipse(overlay, (cx, cy), (rx, ry), rng.integers(0, 180), 0, 360, (96, 84, 74), -1)
    mask = np.zeros(img.shape[:2], np.uint8)
    cv2.ellipse(mask, (cx, cy), (rx, ry), 0, 0, 360, 255, -1)
    alpha = 0.55
    img[mask > 0] = cv2.addWeighted(overlay, alpha, img, 1 - alpha, 0)[mask > 0]
    for _ in range(24):  # gravelly texture inside the patch
        ang = rng.uniform(0, 2 * np.pi)
        rr = rng.uniform(0, 1)
        px, py = int(cx + rx * rr * np.cos(ang)), int(cy + ry * rr * np.sin(ang))
        c = int(rng.integers(60, 110))
        cv2.circle(img, (px, py), 1, (c, c - 8, c - 16), -1)
    return ((cx - rx) / size, (cy - ry) / size, 2 * rx / size, 2 * ry / size)


def _draw_waterlogging(img, rng, size) -> tuple[int, int, int, int]:
    cx, cy = int(rng.integers(size * 0.25, size * 0.75)), int(rng.integers(size * 0.25, size * 0.75))
    rx, ry = int(rng.integers(size // 7, size // 4)), int(rng.integers(size // 9, size // 5))
    overlay = img.copy()
    puddle_color = tuple(int(c) for c in rng.integers(70, 120, 3))
    cv2.ellipse(overlay, (cx, cy), (rx, ry), rng.integers(0, 180), 0, 360, puddle_color, -1)
    mask = np.zeros(img.shape[:2], np.uint8)
    cv2.ellipse(mask, (cx, cy), (rx, ry), 0, 0, 360, 255, -1)
    img[mask > 0] = cv2.addWeighted(overlay, 0.65, img, 0.35, 0)[mask > 0]
    for _ in range(6):  # sky reflections
        px = int(cx + rng.integers(-rx // 2, rx // 2))
        py = int(cy + rng.integers(-ry // 2, ry // 2))
        cv2.ellipse(img, (px, py), (rx // 6, 1), 0, 0, 360, (200, 210, 220), -1)
    return ((cx - rx) / size, (cy - ry) / size, 2 * rx / size, 2 * ry / size)


def _draw_marking_damage(img, rng, size) -> tuple[int, int, int, int]:
    """Broken road marking: painted band with chunks scraped off."""
    y0 = int(rng.integers(size * 0.2, size * 0.8))
    x0, x1 = int(rng.integers(size * 0.05, size * 0.2)), int(rng.integers(size * 0.6, size * 0.95))
    thickness = max(4, size // 45)
    color = (235, 235, 230) if rng.random() < 0.7 else (30, 60, 200)
    cv2.rectangle(img, (x0, y0 - thickness // 2), (x1, y0 + thickness // 2), color, -1)
    for _ in range(rng.integers(4, 9)):  # scrape chunks
        px = int(rng.integers(x0, x1))
        py = y0 + int(rng.integers(-thickness // 2, thickness // 2))
        cv2.circle(img, (px, py), int(rng.integers(2, thickness)), (44, 46, 48), -1)
    return (x0 / size, (y0 - thickness) / size, (x1 - x0) / size, thickness / size)


def _draw_debris(img, rng, size) -> tuple[int, int, int, int]:
    cx, cy = int(rng.integers(size * 0.2, size * 0.8)), int(rng.integers(size * 0.2, size * 0.8))
    spread = size // 10
    pts = []
    for _ in range(rng.integers(5, 12)):
        px, py = int(cx + rng.integers(-spread, spread)), int(cy + rng.integers(-spread // 2, spread // 2))
        r = int(rng.integers(2, size // 40 + 3))
        c = int(rng.integers(70, 150))
        color = (c, c, c - 10) if rng.random() < 0.6 else (c - 20, c - 30, c - 40)
        cv2.circle(img, (px, py), r, color, -1)
        pts.append((px - r, py - r, px + r, py + r))
    xs = [p[0] for p in pts] + [p[2] for p in pts]
    ys = [p[1] for p in pts] + [p[3] for p in pts]
    return (
        max(0, min(xs)) / size,
        max(0, min(ys)) / size,
        min(size, max(xs) - min(xs)) / size,
        min(size, max(ys) - min(ys)) / size,
    )


def _draw_edge_damage(img, rng, size) -> tuple[int, int, int, int]:
    """Broken road edge / crumbling shoulder along a vertical curb line."""
    side = int(rng.choice([0, 1]))
    x_edge = int(rng.integers(size * 0.08, size * 0.2)) if side == 0 else int(
        rng.integers(size * 0.8, size * 0.92)
    )
    y_top, y_bot = int(size * 0.1), int(size * 0.9)
    cv2.line(img, (x_edge, y_top), (x_edge, y_bot), (90, 90, 92), max(3, size // 100))
    for _ in range(rng.integers(5, 10)):  # chunks missing from the edge
        cy = int(rng.integers(y_top, y_bot))
        depth = int(rng.integers(size // 40, size // 16))
        cv2.ellipse(
            img, (x_edge, cy), (depth, int(rng.integers(size // 60, size // 30))),
            0, 0, 360, (40, 40, 42), -1,
        )
    x_lo = max(0, x_edge - size // 14)
    x_hi = min(size, x_edge + size // 14)
    return (x_lo / size, y_top / size, (x_hi - x_lo) / size, (y_bot - y_top) / size)


DRAWERS = {
    "pothole": _draw_pothole,
    "crack": _draw_crack,
    "erosion": _draw_erosion,
    "waterlogging": _draw_waterlogging,
    "marking": _draw_marking_damage,
    "debris": _draw_debris,
    "edge_damage": _draw_edge_damage,
}


def _to_yolo_box(box_tlwh: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """Convert a top-left-origin box (x, y, w, h, normalized) to the YOLO
    center format (cx, cy, w, h), clamped fully inside the image with w,h > 0."""
    x, y, w, h = box_tlwh
    w = max(0.02, min(1.0, w))
    h = max(0.02, min(1.0, h))
    x = max(0.0, min(x, 1.0 - w))
    y = max(0.0, min(y, 1.0 - h))
    return x + w / 2, y + h / 2, w, h


def generate_image(index: int, size: int, rng: np.random.Generator) -> tuple[np.ndarray, list[tuple[int, float, float, float, float]]]:
    img = _asphalt_base(size, rng)
    if rng.random() < 0.5:  # static lane markings (background, not labeled)
        _draw_lane_marking(img, rng, size)

    n_obj = int(rng.integers(1, 4))  # 1..3 hazards
    classes = list(DRAWERS)
    rng.shuffle(classes)
    labels: list[tuple[int, float, float, float, float]] = []
    for cls_name in classes[:n_obj]:
        box = _to_yolo_box(DRAWERS[cls_name](img, rng, size))  # drawers return top-left boxes
        labels.append((CLASS_TO_ID[cls_name], *box))
    return img, labels


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--out", default="datasets/demo", help="output dataset root")
    ap.add_argument("--num", type=int, default=240, help="number of images")
    ap.add_argument("--size", type=int, default=416, help="square image size in px")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--quality", type=int, default=85, help="JPEG quality")
    args = ap.parse_args()

    out = Path(args.out)
    images_dir = out / "images" / "all"
    labels_dir = out / "labels" / "all"
    images_dir.mkdir(parents=True, exist_ok=True)
    labels_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "generator": "ml/scripts/make_demo_data.py",
        "seed": args.seed,
        "num_images": args.num,
        "image_size": args.size,
        "classes": {name: CLASS_TO_ID[name] for name in HAZARD_CLASSES},
        "synthetic": True,
        "license": "CC0 (procedurally generated, no copyright)",
    }
    per_class = {name: 0 for name in HAZARD_CLASSES}
    for i in range(args.num):
        rng = _rng(args.seed * 1_000_003 + i)
        img, labels = generate_image(i, args.size, rng)
        stem = f"demo_{i:06d}"
        cv2.imwrite(str(images_dir / f"{stem}{IMG_EXT}"), img, [cv2.IMWRITE_JPEG_QUALITY, args.quality])
        lines = [f"{c} {x:.6f} {y:.6f} {w:.6f} {h:.6f}" for c, x, y, w, h in labels]
        (labels_dir / f"{stem}.txt").write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
        for c, *_ in labels:
            per_class[ID_NAME[c]] += 1
    manifest["instances_per_class"] = per_class
    (out / "make_demo_data.manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    # Demo dataset yaml mirroring dataset/road_hazards.yaml, resolved for demo.
    yaml_path = Path(__file__).resolve().parents[1] / "dataset" / "road_hazards.demo.yaml"
    names = "\n".join(f"  {i}: {n}" for i, n in enumerate(HAZARD_CLASSES))
    yaml_path.write_text(
        "# AUTO-GENERATED by scripts/make_demo_data.py — synthetic demo dataset.\n"
        f"path: {images_dir.parent.parent.resolve()}\n"
        "train: images/train\nval: images/val\ntest: images/test\n"
        f"names:\n{names}\n",
        encoding="utf-8",
    )
    print(f"[make_demo_data] wrote {args.num} images to {images_dir}")
    print(f"[make_demo_data] instances per class: {per_class}")
    print(f"[make_demo_data] dataset yaml: {yaml_path}")
    return 0


ID_NAME = {i: n for n, i in CLASS_TO_ID.items()}

if __name__ == "__main__":
    raise SystemExit(main())
