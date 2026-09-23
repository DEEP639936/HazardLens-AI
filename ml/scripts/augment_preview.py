#!/usr/bin/env python3
"""Render a grid of augmented training samples and save it as a PNG.

Primary path uses Ultralytics' real train-time transform pipeline (mosaic,
HSV jitter, flips, scale/translate, ...) so the preview reflects exactly what
the model sees during `train.py`. If the Ultralytics internals are not
available, a fully-specified OpenCV fallback (HLS jitter / flips / affine with
box warping) is used so the preview always works.

Output: <out> PNG grid + a small JSON manifest next to it.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import List, Optional

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hazard_domain import HAZARD_CLASSES  # noqa: E402
from vision_utils import draw_detections, palette_color, tile_grid  # noqa: E402

IMGSZ_DEFAULT = 640


def _denorm_xywh_to_xyxy(box: np.ndarray, size: int) -> np.ndarray:
    cx, cy, w, h = [float(v) for v in box]
    return np.array([(cx - w / 2) * size, (cy - h / 2) * size,
                     (cx + w / 2) * size, (cy + h / 2) * size])


def sample_ultralytics(data_yaml: str, imgsz: int, count: int):
    """Yield (bgr_image, boxes_xyxy, class_ids) from the real train pipeline."""
    from ultralytics.cfg import get_cfg
    from ultralytics.data.build import build_yolo_dataset
    from ultralytics.data.utils import check_det_dataset

    cfg = get_cfg(overrides={
        "task": "detect", "mode": "train", "data": str(data_yaml), "imgsz": imgsz,
        "batch": 4, "augment": True, "degrees": 5.0, "translate": 0.1,
        "scale": 0.5, "fliplr": 0.5, "flipud": 0.0, "mosaic": 1.0,
        "hsv_h": 0.015, "hsv_s": 0.7, "hsv_v": 0.4,
    })
    data = check_det_dataset(cfg.data)
    ds = build_yolo_dataset(cfg, img_path=data["train"], batch=4, data=data, mode="train")
    for i in range(min(count, len(ds))):
        item = ds[i]
        img = item["img"]
        if hasattr(img, "numpy"):
            img = img.numpy()
        img = np.ascontiguousarray(np.transpose(img, (1, 2, 0))).astype(np.uint8)
        img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        bboxes = np.asarray(item["bboxes"], dtype=np.float64).reshape(-1, 4)
        clses = np.asarray(item["cls"], dtype=np.int64).reshape(-1)
        boxes = np.stack([_denorm_xywh_to_xyxy(b, imgsz) for b in bboxes]) if len(bboxes) else np.zeros((0, 4))
        yield img, boxes, clses


def sample_opencv(dataset_root: str, split: str, imgsz: int, count: int, seed: int):
    """Fallback: deterministic OpenCV augmentations applied with box warping."""
    root = Path(dataset_root)
    img_dir = root / "images" / split
    lbl_dir = root / "labels" / split
    files = sorted(p for p in img_dir.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".bmp"})
    if not files:
        raise SystemExit(f"[augment] no images in {img_dir}")
    rng = np.random.default_rng(seed)
    idxs = rng.permutation(len(files))[:count]
    for k in idxs:
        path = files[int(k)]
        img = cv2.imread(str(path))
        if img is None:
            continue
        h, w = img.shape[:2]
        rows = []
        lbl = lbl_dir / (path.stem + ".txt")
        if lbl.exists():
            for line in lbl.read_text().splitlines():
                parts = line.split()
                if len(parts) == 5:
                    rows.append((int(float(parts[0])), *[float(v) for v in parts[1:]]))
        # random affine: scale 0.6..1.2 + translate ±10%
        scale = rng.uniform(0.6, 1.2)
        tx, ty = rng.uniform(-0.1, 0.1) * w, rng.uniform(-0.1, 0.1) * h
        M = np.array([[scale, 0, tx], [0, scale, ty]], dtype=np.float64)
        warped = cv2.warpAffine(img, M, (w, h), borderValue=(114, 114, 114))
        # HSV jitter
        hsv = cv2.cvtColor(warped, cv2.COLOR_BGR2HLS).astype(np.float32)
        hsv[..., 0] = np.clip(hsv[..., 0] + rng.uniform(-8, 8), 0, 179)
        hsv[..., 1] = np.clip(hsv[..., 1] * rng.uniform(0.6, 1.4), 0, 255)
        hsv[..., 2] = np.clip(hsv[..., 2] * rng.uniform(0.6, 1.4), 0, 255)
        out_img = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HLS2BGR)
        if rng.random() < 0.5:
            out_img = cv2.flip(out_img, 1)
            flip = True
        else:
            flip = False
        boxes, clses = [], []
        for cls_id, cx, cy, bw, bh in rows:
            corners = np.array([[ (cx - bw/2)*w, (cy - bh/2)*h, 1.0],
                                [ (cx + bw/2)*w, (cy + bh/2)*h, 1.0]], dtype=np.float64)
            mapped = (M @ corners.T).T
            x1, y1 = mapped.min(axis=0)[:2]
            x2, y2 = mapped.max(axis=0)[:2]
            if flip:
                x1, x2 = w - x2, w - x1
            x1, x2 = sorted((max(0, min(w-1, x1)), max(0, min(w-1, x2))))
            y1, y2 = sorted((max(0, min(h-1, y1)), max(0, min(h-1, y2))))
            if x2 - x1 > 3 and y2 - y1 > 3:
                boxes.append([x1, y1, x2, y2])
                clses.append(cls_id)
        resized = cv2.resize(out_img, (imgsz, imgsz))
        sf = imgsz / w
        boxes = (np.asarray(boxes, dtype=np.float64) * sf) if boxes else np.zeros((0, 4))
        yield resized, boxes, np.asarray(clses, dtype=np.int64)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--data", default="dataset/road_hazards.demo.yaml", help="dataset yaml")
    ap.add_argument("--dataset-root", default=None,
                    help="fallback path (OpenCV mode): YOLO root with images/<split>")
    ap.add_argument("--split", default="train")
    ap.add_argument("--out", default="reports/augment_preview.png")
    ap.add_argument("--grid", type=int, default=9, help="samples in the grid")
    ap.add_argument("--cols", type=int, default=3)
    ap.add_argument("--imgsz", type=int, default=IMGSZ_DEFAULT)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    engine = "ultralytics"
    samples: List[np.ndarray] = []
    try:
        for img, boxes, clses in sample_ultralytics(args.data, args.imgsz, args.grid):
            samples.append(draw_detections(img, boxes, clses, [1.0] * len(clses), HAZARD_CLASSES))
        if not samples:
            raise RuntimeError("no samples produced")
    except Exception as exc:  # noqa: BLE001 — fall back to the cv2 implementation
        engine = f"opencv-fallback (ultralytics path failed: {type(exc).__name__}: {exc})"
        root = args.dataset_root
        if root is None:
            data_path = Path(args.data)
            if data_path.exists():
                import yaml
                cfg = yaml.safe_load(data_path.read_text())
                base = Path(cfg.get("path") or data_path.parent)
                root = str((base if Path(base).is_absolute() else (data_path.parent / base).resolve()))
            else:
                root = "datasets/demo"
        for img, boxes, clses in sample_opencv(root, args.split, args.imgsz, args.grid, args.seed):
            samples.append(draw_detections(img, boxes, clses, [1.0] * len(clses), HAZARD_CLASSES))

    grid = tile_grid(samples, cols=args.cols)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), grid)
    out.with_suffix(".json").write_text(json.dumps(
        {"engine": engine, "samples": len(samples), "data": str(args.data),
         "imgsz": args.imgsz, "note": "boxes drawn on the transformed (letterboxed/mosaicked) canvas"},
        indent=2), encoding="utf-8")
    print(f"[augment] engine={engine} samples={len(samples)} -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
