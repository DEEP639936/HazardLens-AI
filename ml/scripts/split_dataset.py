#!/usr/bin/env python3
"""Stratified train/val/test split (default 70/20/10) for a YOLO-layout dataset.

Stratification is per-image multi-label aware: images are grouped by their set
of present classes (rare class-set combinations are shared out first by a
greedy round-robin over the least-filled splits), which keeps per-class
distributions close to the requested ratios.

    <root>/images/all  + <root>/labels/all   ->   images/{train,val,test} + labels/{train,val,test}

Safe to re-run with a different --seed; original files are moved (or copied
with --copy) and a split report JSON is written.
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hazard_domain import HAZARD_CLASSES  # noqa: E402

IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def read_image_classes(lbl_path: Path) -> Tuple[List[int], bool]:
    """Return (class ids present, file existed)."""
    if not lbl_path.exists():
        return [], False
    classes = []
    for line in lbl_path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if parts:
            try:
                classes.append(int(float(parts[0])))
            except ValueError:
                continue
    return classes, True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--dataset-root", required=True, help="dataset root containing images/ and labels/")
    ap.add_argument("--ratios", nargs=3, type=float, default=[0.7, 0.2, 0.1], metavar=("TRAIN", "VAL", "TEST"))
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--source-split", default="all",
                    help="subdirectory holding the un-split pool (images/<source-split>)")
    ap.add_argument("--copy", action="store_true", help="copy instead of move (keeps the pool)")
    ap.add_argument("--report", default=None, help="split report JSON path (default <root>/split_report.json)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    tr, va, te = args.ratios
    if abs(tr + va + te - 1.0) > 1e-6 or min(tr, va, te) < 0:
        ap.error(f"--ratios must be non-negative and sum to 1.0 (got {args.ratios})")

    root = Path(args.dataset_root)
    src_img = root / "images" / args.source_split
    src_lbl = root / "labels" / args.source_split
    if not src_img.is_dir():
        print(f"[split] missing image pool: {src_img}")
        return 2
    image_files = sorted(p for p in src_img.iterdir() if p.suffix.lower() in IMG_EXTS)
    if not image_files:
        print(f"[split] no images in {src_img}")
        return 2

    # Group images by the frozenset of classes present (stratification key).
    groups: Dict[frozenset, List[Path]] = defaultdict(list)
    for img in image_files:
        classes, _ = read_image_classes(src_lbl / (img.stem + ".txt"))
        groups[frozenset(classes)].append(img)

    rng = random.Random(args.seed)
    assignments: Dict[str, List[str]] = {"train": [], "val": [], "test": []}
    splits_order = ["train", "val", "test"]
    target = {"train": tr, "val": va, "test": te}
    total = len(image_files)
    filled = Counter()

    # Largest groups first keeps the overall ratio tight; rare combos are then
    # placed on the split that is most under its target share.
    for key in sorted(groups, key=lambda k: -len(groups[k])):
        members = groups[key]
        rng.shuffle(members)
        for img in members:
            deficit = {s: target[s] * total - filled[s] for s in splits_order}
            chosen = max(splits_order, key=lambda s: deficit[s])
            assignments[chosen].append(img.name)
            filled[chosen] += 1

    report = {
        "dataset_root": str(root.resolve()),
        "seed": args.seed,
        "ratios": {"train": tr, "val": va, "test": te},
        "total_images": total,
        "counts": {s: len(v) for s, v in assignments.items()},
        "mode": "copy" if args.copy else "move",
    }

    for split, names in assignments.items():
        dst_img = root / "images" / split
        dst_lbl = root / "labels" / split
        if args.dry_run:
            print(f"[split][dry-run] {split}: {len(names)} images")
            continue
        dst_img.mkdir(parents=True, exist_ok=True)
        dst_lbl.mkdir(parents=True, exist_ok=True)
        for name in names:
            img_src = src_img / name
            lbl_src = src_lbl / (Path(name).stem + ".txt")
            op = shutil.copy2 if args.copy else shutil.move
            op(str(img_src), str(dst_img / name))
            if lbl_src.exists():
                op(str(lbl_src), str(dst_lbl / (Path(name).stem + ".txt")))
            else:  # background image: create an empty label so YOLO doesn't warn
                (dst_lbl / (Path(name).stem + ".txt")).touch()

    if not args.dry_run:
        # Per-split class distribution for the report
        dist = {}
        for split in splits_order:
            counter: Counter = Counter()
            for p in (root / "labels" / split).glob("*.txt"):
                ids, _ = read_image_classes(p)
                counter.update(ids)
            dist[split] = {HAZARD_CLASSES[c] if c < len(HAZARD_CLASSES) else str(c): n
                           for c, n in sorted(counter.items())}
        report["class_distribution"] = dist
        report_path = Path(args.report) if args.report else root / "split_report.json"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"[split] {report['counts']} — report -> {report_path}")
        print(f"[split] class distribution: {dist}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
