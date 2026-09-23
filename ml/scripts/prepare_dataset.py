#!/usr/bin/env python3
"""Convert common road-damage annotation formats to the YOLO layout.

Supported inputs (--format):
  voc       Pascal VOC: directory of .xml sidecars next to images
  rdd2022   RDD2022 / CRDDC'22 style CSV (India/Japan/Czech/US dumps):
            columns for image name + xmin/ymin/xmax/ymax + class label
  yolo      Already-YOLO txt labels but with a classes.txt mapping or
            class-id offsets to remap onto the canonical 7 classes

Output: standard YOLO layout
    <out>/images/all/*.jpg     (copied or symlinked)
    <out>/labels/all/*.txt
    <out>/prepare_manifest.json

Canonical classes (see ml/hazard_domain.py):
    0 pothole 1 crack 2 erosion 3 waterlogging 4 marking 5 debris 6 edge_damage
"""
from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hazard_domain import CLASS_TO_ID, HAZARD_CLASSES  # noqa: E402

IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

# Default mapping for RDD2022 damage codes onto RoadGuard classes.
# D00 longitudinal crack, D10 transverse crack, D20 alligator crack -> crack;
# D40 pothole -> pothole. Japan/India/Czech variants (e.g. D0w, D0m, D01..) are
# normalized by their D-code prefix. Override with --class-map.
DEFAULT_RDD_CLASS_MAP: Dict[str, str] = {
    "d00": "crack", "d0w": "crack", "d0m": "crack", "d01": "crack", "d0y": "crack",
    "d10": "crack", "d1w": "crack", "d1m": "crack", "d11": "crack", "d1y": "crack",
    "d20": "crack", "d2w": "crack", "d2m": "crack", "d21": "crack", "d2y": "crack",
    "d40": "pothole", "d4w": "pothole", "d4m": "pothole", "d43": "pothole",
}

COLUMN_ALIASES = {
    "image": ["image_name", "image_path", "file_name", "filename", "name", "image"],
    "xmin": ["xmin", "x_min", "left", "x1", "x_min_px"],
    "ymin": ["ymin", "y_min", "top", "y1", "y_min_px"],
    "xmax": ["xmax", "x_max", "right", "x2", "x_max_px"],
    "ymax": ["ymax", "y_max", "bottom", "y2", "y_max_px"],
    "label": ["class", "label", "class_name", "type", "damage_type", "category"],
}


def _match_columns(fieldnames: List[str]) -> Dict[str, str]:
    norm = {f.strip().lower(): f for f in fieldnames}
    out = {}
    for role, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            if alias in norm:
                out[role] = norm[alias]
                break
    missing = [r for r in ("image", "xmin", "ymin", "xmax", "ymax") if r not in out]
    if missing:
        raise SystemExit(f"[prepare] CSV missing required columns {missing}; found: {fieldnames}")
    return out


def _resolve_image(images_root: Path, raw_name: str) -> Optional[Path]:
    name = Path(raw_name.replace("\\", "/")).name
    for cand in [images_root / name, *images_root.rglob(name)]:
        if cand.is_file():
            return cand
    return None


def _map_label(raw: str, class_map: Dict[str, str], on_unknown: str, stats: Dict[str, int]) -> Optional[str]:
    key = raw.strip().lower()
    if key in class_map:
        return class_map[key]
    prefix = key[:3]  # e.g. "d00"
    if prefix in class_map:
        return class_map[prefix]
    if key in CLASS_TO_ID:
        return key
    if key in {"d00", "d10", "d20"}:
        return "crack"
    if key in {"d40"}:
        return "pothole"
    stats["unknown_labels"] += 1
    if on_unknown == "error":
        raise SystemExit(f"[prepare] unknown label '{raw}' and --on-unknown-class=error")
    return None


def _emit(img_src: Path, boxes: List[Tuple[int, float, float, float, float]],
          out_img_dir: Path, out_lbl_dir: Path, copy: bool, corrupt: List[str]) -> bool:
    img = cv2.imread(str(img_src))
    if img is None:
        corrupt.append(str(img_src))
        return False
    h, w = img.shape[:2]
    dst_img = out_img_dir / f"{img_src.stem}{img_src.suffix.lower()}"
    if copy:
        shutil.copy2(img_src, dst_img)
    else:
        rel = Path("../..").resolve()
        target = img_src.resolve()
        try:
            dst_img.symlink_to(target)
        except OSError:
            shutil.copy2(img_src, dst_img)
    lines = []
    for cls_id, cx, cy, bw, bh in boxes:
        lines.append(f"{cls_id} {max(0.0, min(1.0, cx)):.6f} {max(0.0, min(1.0, cy)):.6f} "
                     f"{max(1e-4, min(1.0, bw)):.6f} {max(1e-4, min(1.0, bh)):.6f}")
    (out_lbl_dir / f"{dst_img.stem}.txt").write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    return True


def convert_voc(input_dir: Path, images_root: Path, class_map: Dict[str, str],
                on_unknown: str, stats: Dict[str, int]) -> Dict[str, List[Tuple]]:
    """Parse VOC XMLs; returns {image_path: [(class_id, cx, cy, w, h), ...]}."""
    parsed: Dict[str, List[Tuple]] = {}
    for xml in sorted(input_dir.rglob("*.xml")):
        try:
            tree = ET.parse(xml)
        except ET.ParseError:
            stats["malformed_xml"] += 1
            continue
        root = tree.getroot()
        filename = root.findtext("filename") or xml.stem
        size = root.find("size")
        iw = float(size.findtext("width", "0")) if size is not None else 0.0
        ih = float(size.findtext("height", "0")) if size is not None else 0.0
        img_path = _resolve_image(images_root, filename)
        if img_path is None:
            stats["images_not_found"] += 1
            continue
        if iw <= 1 or ih <= 1:  # size missing in xml — read from the image
            img = cv2.imread(str(img_path))
            if img is None:
                stats["corrupt_images"] += 1
                continue
            ih, iw = img.shape[:2]
        boxes = []
        for obj in root.iter("object"):
            raw_label = obj.findtext("name", "").strip()
            label = _map_label(raw_label, class_map, on_unknown, stats)
            if label is None:
                continue
            bnd = obj.find("bndbox")
            if bnd is None:
                stats["boxes_missing_bndbox"] += 1
                continue
            x1, y1 = float(bnd.findtext("xmin", "0")), float(bnd.findtext("ymin", "0"))
            x2, y2 = float(bnd.findtext("xmax", "0")), float(bnd.findtext("ymax", "0"))
            if x2 <= x1 or y2 <= y1:
                stats["invalid_boxes"] += 1
                continue
            boxes.append((CLASS_TO_ID[label],
                          ((x1 + x2) / 2) / iw, ((y1 + y2) / 2) / ih,
                          (x2 - x1) / iw, (y2 - y1) / ih))
        parsed[img_path] = boxes
    return parsed


def convert_rdd_csv(csv_path: Path, images_root: Path, class_map: Dict[str, str],
                    on_unknown: str, stats: Dict[str, int]) -> Dict[str, List[Tuple]]:
    parsed: Dict[str, List[Tuple]] = {}
    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        sample = f.read(4096)
        f.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        reader = csv.DictReader(f, dialect=dialect)
        cols = _match_columns(reader.fieldnames or [])
        for row in reader:
            label = _map_label(row.get(cols.get("label", ""), ""), class_map, on_unknown, stats)
            if label is None:
                continue
            img_path = _resolve_image(images_root, row[cols["image"]])
            if img_path is None:
                stats["images_not_found"] += 1
                continue
            try:
                x1, y1 = float(row[cols["xmin"]]), float(row[cols["ymin"]])
                x2, y2 = float(row[cols["xmax"]]), float(row[cols["ymax"]])
            except (TypeError, ValueError):
                stats["invalid_boxes"] += 1
                continue
            if x2 <= x1 or y2 <= y1:
                stats["invalid_boxes"] += 1
                continue
            img = cv2.imread(str(img_path))
            if img is None:
                stats["corrupt_images"] += 1
                continue
            ih, iw = img.shape[:2]
            parsed.setdefault(img_path, []).append(
                (CLASS_TO_ID[label], ((x1 + x2) / 2) / iw, ((y1 + y2) / 2) / ih,
                 (x2 - x1) / iw, (y2 - y1) / ih))
    return parsed


def convert_yolo(labels_dir: Path, images_root: Path, class_map: Dict[str, str],
                 on_unknown: str, stats: Dict[str, int]) -> Dict[str, List[Tuple]]:
    """Remap existing YOLO txt labels via classes.txt (id -> name) if present."""
    remap: Dict[int, str] = {}
    classes_txt = labels_dir / "classes.txt"
    if classes_txt.exists():
        for i, line in enumerate(classes_txt.read_text(encoding="utf-8").splitlines()):
            name = line.strip().lower()
            if name:
                remap[i] = name
    parsed: Dict[str, List[Tuple]] = {}
    for txt in sorted(labels_dir.rglob("*.txt")):
        if txt.name == "classes.txt":
            continue
        img_path = _resolve_image(images_root, txt.stem + ".jpg") or \
            _resolve_image(images_root, txt.stem + ".png")
        if img_path is None:
            # try any extension
            for ext in IMG_EXTS:
                img_path = _resolve_image(images_root, txt.stem + ext)
                if img_path:
                    break
        if img_path is None:
            stats["images_not_found"] += 1
            continue
        img = cv2.imread(str(img_path))
        if img is None:
            stats["corrupt_images"] += 1
            continue
        ih, iw = img.shape[:2]
        boxes = []
        for line in txt.read_text(encoding="utf-8").splitlines():
            parts = line.split()
            if len(parts) != 5:
                stats["malformed_rows"] += 1
                continue
            try:
                src_id = int(float(parts[0]))
                cx, cy, bw, bh = (float(v) for v in parts[1:])
            except ValueError:
                stats["malformed_rows"] += 1
                continue
            raw_name = remap.get(src_id, class_map.get(f"__id__{src_id}", ""))
            label = _map_label(raw_name or f"id{src_id}", class_map, on_unknown, stats)
            if label is None:
                continue
            boxes.append((CLASS_TO_ID[label], cx, cy, bw, bh))
        parsed[img_path] = boxes
    return parsed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--format", required=True, choices=["voc", "rdd2022", "yolo"])
    ap.add_argument("--input", required=True,
                    help="VOC: dir with .xml files | rdd2022: annotations CSV | yolo: labels dir")
    ap.add_argument("--images", required=True, help="root dir containing raw images")
    ap.add_argument("--out", default="datasets/road_hazards", help="output YOLO dataset root")
    ap.add_argument("--class-map", default=None,
                    help="JSON file mapping raw label names -> canonical class "
                         f"(default RDD map: {DEFAULT_RDD_CLASS_MAP})")
    ap.add_argument("--on-unknown-class", choices=["skip", "error"], default="skip")
    ap.add_argument("--copy", action="store_true", help="copy images (default: symlink when possible)")
    ap.add_argument("--include-empty", action="store_true",
                    help="emit empty label files for images with no valid boxes (background images)")
    ap.add_argument("--no-yaml", action="store_true", help="do not write the dataset yaml")
    args = ap.parse_args()

    class_map = dict(DEFAULT_RDD_CLASS_MAP)
    if args.class_map:
        custom = json.loads(Path(args.class_map).read_text(encoding="utf-8"))
        class_map.update({str(k).lower(): str(v) for k, v in custom.items()})
    for name in HAZARD_CLASSES:  # canonical names always pass through
        class_map[name] = name

    images_root = Path(args.images)
    if not images_root.is_dir():
        print(f"[prepare] images dir not found: {images_root}")
        return 2

    stats = {"images_not_found": 0, "corrupt_images": 0, "invalid_boxes": 0,
             "unknown_labels": 0, "malformed_xml": 0, "malformed_rows": 0,
             "boxes_missing_bndbox": 0, "written": 0, "empty_background": 0}

    input_path = Path(args.input)
    if args.format == "voc":
        parsed = convert_voc(input_path, images_root, class_map, args.on_unknown_class, stats)
    elif args.format == "rdd2022":
        if not input_path.is_file():
            print(f"[prepare] CSV not found: {input_path}")
            return 2
        parsed = convert_rdd_csv(input_path, images_root, class_map, args.on_unknown_class, stats)
    else:
        parsed = convert_yolo(input_path, images_root, class_map, args.on_unknown_class, stats)

    out = Path(args.out)
    out_img = out / "images" / "all"
    out_lbl = out / "labels" / "all"
    out_img.mkdir(parents=True, exist_ok=True)
    out_lbl.mkdir(parents=True, exist_ok=True)

    per_class: Dict[str, int] = {name: 0 for name in HAZARD_CLASSES}
    for img_path, boxes in sorted(parsed.items()):
        if boxes or args.include_empty:
            if _emit(img_path, boxes, out_img, out_lbl, args.copy, []):
                stats["written"] += 1
                if not boxes:
                    stats["empty_background"] += 1
                for cls_id, *_ in boxes:
                    per_class[HAZARD_CLASSES[cls_id]] += 1

    manifest = {
        "format": args.format,
        "input": str(input_path),
        "images_root": str(images_root),
        "out": str(out.resolve()),
        "canonical_classes": list(HAZARD_CLASSES),
        "class_map_applied": class_map,
        "instances_per_class": per_class,
        "stats": stats,
    }
    (out / "prepare_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    if not args.no_yaml:
        names = "\n".join(f"  {i}: {n}" for i, n in enumerate(HAZARD_CLASSES))
        (Path(__file__).resolve().parents[1] / "dataset" / "road_hazards.prepared.yaml").write_text(
            f"# AUTO-GENERATED by scripts/prepare_dataset.py from {input_path}\n"
            f"path: {out.resolve()}\ntrain: images/train\nval: images/val\ntest: images/test\n"
            f"names:\n{names}\n", encoding="utf-8")

    print(f"[prepare] wrote {stats['written']} images ({stats['empty_background']} background) -> {out}")
    print(f"[prepare] instances per class: {per_class}")
    print(f"[prepare] stats: {stats}")
    print("[prepare] next: scripts/split_dataset.py --dataset-root " + str(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
