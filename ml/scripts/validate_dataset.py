#!/usr/bin/env python3
"""Validate a YOLO-layout road-hazard dataset and write a JSON report.

Checks performed per split (train/val/test or any dir with images/ + labels/):
  * images readable (not corrupt) via OpenCV
  * a label file exists for every image (missing-label warning; optional error)
  * label rows well-formed: 5 whitespace-separated numeric fields
  * class ids within [0, nc) — nc from --classes or the referenced dataset yaml
  * box coordinates within (0, 1] and w*h > 0 (degenerate/overflow boxes flagged)
  * duplicate rows, empty label files
Writes a machine-readable JSON report and exits non-zero on errors
(unless --no-fail) so it can gate CI.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Dict, List, Optional

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hazard_domain import HAZARD_CLASSES, NUM_CLASSES  # noqa: E402

IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
SPLIT_NAMES = ("train", "val", "test")


def sha256_short(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def discover_splits(root: Path) -> List[str]:
    found = []
    for name in SPLIT_NAMES:
        if (root / "images" / name).is_dir():
            found.append(name)
    if not found and (root / "images").is_dir():
        found = ["all"]
    return found


def validate_split(
    root: Path,
    split: str,
    num_classes: int,
    issues: List[dict],
    per_class: Dict[str, int],
) -> dict:
    img_dir = root / "images" / split
    lbl_dir = root / "labels" / split
    stats = {
        "split": split,
        "images": 0,
        "label_files": 0,
        "missing_labels": 0,
        "empty_labels": 0,
        "instances": 0,
        "corrupt_images": 0,
        "bad_rows": 0,
        "bad_class_ids": 0,
        "bad_boxes": 0,
        "duplicate_rows": 0,
    }
    if not img_dir.is_dir():
        issues.append({"split": split, "severity": "error", "code": "SPLIT_MISSING",
                       "message": f"images/{split} does not exist"})
        return stats

    image_files = sorted(p for p in img_dir.iterdir() if p.suffix.lower() in IMG_EXTS)
    for img_path in image_files:
        stats["images"] += 1
        rel = f"{split}/{img_path.name}"
        img = cv2.imread(str(img_path))
        if img is None:
            stats["corrupt_images"] += 1
            issues.append({"split": split, "file": rel, "severity": "error",
                           "code": "CORRUPT_IMAGE", "message": "cv2.imread returned None"})
        h, w = (img.shape[0], img.shape[1]) if img is not None else (0, 0)

        lbl_path = lbl_dir / (img_path.stem + ".txt")
        if not lbl_path.exists():
            stats["missing_labels"] += 1
            issues.append({"split": split, "file": rel, "severity": "error",
                           "code": "MISSING_LABEL", "message": f"no {lbl_path.name}"})
            continue
        stats["label_files"] += 1
        seen_rows = set()
        rows = [ln.strip() for ln in lbl_path.read_text(encoding="utf-8").splitlines() if ln.strip()]
        if not rows:
            stats["empty_labels"] += 1
            issues.append({"split": split, "file": rel, "severity": "warning",
                           "code": "EMPTY_LABEL", "message": "label file has no rows (background image)"})
        for ln_no, row in enumerate(rows, 1):
            parts = row.split()
            if len(parts) != 5:
                stats["bad_rows"] += 1
                issues.append({"split": split, "file": rel, "line": ln_no, "severity": "error",
                               "code": "MALFORMED_ROW", "message": f"expected 5 fields, got {len(parts)}"})
                continue
            try:
                cls_id = int(float(parts[0]))
                cx, cy, bw, bh = (float(v) for v in parts[1:])
            except ValueError:
                stats["bad_rows"] += 1
                issues.append({"split": split, "file": rel, "line": ln_no, "severity": "error",
                               "code": "NON_NUMERIC", "message": row[:60]})
                continue
            if not (0 <= cls_id < num_classes):
                stats["bad_class_ids"] += 1
                issues.append({"split": split, "file": rel, "line": ln_no, "severity": "error",
                               "code": "CLASS_OUT_OF_RANGE",
                               "message": f"class id {cls_id} not in [0, {num_classes})"})
                continue
            per_class[cls_id] = per_class.get(cls_id, 0) + 1
            stats["instances"] += 1
            ok = True
            if not (0 < bw <= 1.0 and 0 < bh <= 1.0) or bw * bh <= 0:
                stats["bad_boxes"] += 1
                ok = False
                issues.append({"split": split, "file": rel, "line": ln_no, "severity": "error",
                               "code": "INVALID_BOX_SIZE", "message": f"w={bw} h={bh}"})
            # EPS: labels are stored at 6-decimal precision; a fully valid box
            # can sit within ~5e-7 of the border after rounding. 1e-5 stays
            # subpixel for any realistic image size.
            EPS = 1e-5
            if not (-EPS <= cx - bw / 2 and cx + bw / 2 <= 1.0 + EPS
                    and -EPS <= cy - bh / 2 and cy + bh / 2 <= 1.0 + EPS):
                stats["bad_boxes"] += 1
                ok = False
                issues.append({"split": split, "file": rel, "line": ln_no, "severity": "error",
                               "code": "BOX_OUT_OF_BOUNDS", "message": f"cx={cx} cy={cy} w={bw} h={bh}"})
            row_key = (cls_id, round(cx, 6), round(cy, 6), round(bw, 6), round(bh, 6))
            if row_key in seen_rows:
                stats["duplicate_rows"] += 1
                issues.append({"split": split, "file": rel, "line": ln_no, "severity": "warning",
                               "code": "DUPLICATE_ROW", "message": row[:60]})
            seen_rows.add(row_key)
            if not ok:
                continue
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--dataset-root", required=True,
                    help="YOLO dataset root containing images/<split>/ and labels/<split>/")
    ap.add_argument("--splits", nargs="*", default=None,
                    help="splits to check (default: auto-discover train/val/test)")
    ap.add_argument("--num-classes", type=int, default=None,
                    help="class count (default: 7 canonical RoadGuard classes)")
    ap.add_argument("--report", default="reports/validate_report.json", help="JSON report path")
    ap.add_argument("--no-fail", action="store_true", help="always exit 0 even with errors")
    args = ap.parse_args()

    root = Path(args.dataset_root)
    if not root.is_dir():
        print(f"[validate] dataset root not found: {root}")
        return 2
    num_classes = args.num_classes or NUM_CLASSES
    splits = args.splits if args.splits else discover_splits(root)
    if not splits:
        print(f"[validate] no images/<split> directories under {root}")
        return 2

    issues: List[dict] = []
    per_class: Dict[str, int] = {}
    split_stats = [validate_split(root, s, num_classes, issues, per_class) for s in splits]

    # Per-class report keyed by canonical class name where possible.
    per_class_named = {}
    for cid, count in sorted(per_class.items()):
        name = HAZARD_CLASSES[cid] if cid < len(HAZARD_CLASSES) else f"class_{cid}"
        per_class_named[name] = count

    errors = sum(1 for i in issues if i["severity"] == "error")
    warnings = sum(1 for i in issues if i["severity"] == "warning")
    report = {
        "dataset_root": str(root.resolve()),
        "splits": split_stats,
        "totals": {
            "images": sum(s["images"] for s in split_stats),
            "instances": sum(s["instances"] for s in split_stats),
            "errors": errors,
            "warnings": warnings,
        },
        "instances_per_class": per_class_named,
        "num_classes_expected": num_classes,
        "ok": errors == 0,
        "issues": issues[:2000],  # cap so the JSON stays readable
        "issues_truncated": len(issues) > 2000,
    }
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"[validate] {report['totals']['images']} images, "
          f"{report['totals']['instances']} instances, {errors} errors, {warnings} warnings")
    print(f"[validate] per class: {per_class_named}")
    print(f"[validate] report -> {report_path}")
    if errors:
        for issue in issues[:10]:
            if issue["severity"] == "error":
                print(f"  ERROR {issue.get('file', '')}: {issue['code']} — {issue['message']}")
    return 0 if (args.no_fail or errors == 0) else 1


if __name__ == "__main__":
    raise SystemExit(main())
