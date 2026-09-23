#!/usr/bin/env python3
"""Per-class instance counts + imbalance analysis for a YOLO-layout dataset.

Outputs (printed and written as JSON):
  * instances per class, overall and per split
  * images per class
  * imbalance ratio (max/min instance count) and Gini coefficient
  * an optional **oversampling plan**: per-image repeat factors that equalize
    class exposure in the training split (image-level, so YOLO layouts stay
    valid). `--apply` materializes the plan as duplicate copies in an
    `images/train_balanced` / `labels/train_balanced` pool.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections import Counter
from pathlib import Path
from typing import Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hazard_domain import HAZARD_CLASSES  # noqa: E402

IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def class_name(cid: int) -> str:
    return HAZARD_CLASSES[cid] if 0 <= cid < len(HAZARD_CLASSES) else f"class_{cid}"


def scan_labels(lbl_dir: Path) -> Dict[str, Dict[str, int]]:
    """Per-image counts: {image_stem: {class_name: n}}."""
    out: Dict[str, Dict[str, int]] = {}
    for lbl in sorted(lbl_dir.glob("*.txt")):
        counts: Counter = Counter()
        for line in lbl.read_text(encoding="utf-8").splitlines():
            parts = line.split()
            if parts:
                try:
                    counts[int(float(parts[0]))] += 1
                except ValueError:
                    continue
        if counts:
            out[lbl.stem] = {class_name(c): n for c, n in counts.items()}
    return out


def gini(values: List[float]) -> float:
    v = sorted(values)
    n = len(v)
    if n == 0 or sum(v) == 0:
        return 0.0
    cum = sum((i + 1) * x for i, x in enumerate(v))
    return (2 * cum) / (n * sum(v)) - (n + 1) / n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--dataset-root", required=True)
    ap.add_argument("--splits", nargs="*", default=["train", "val", "test"])
    ap.add_argument("--report", default="reports/class_balance.json")
    ap.add_argument("--plan", default="reports/oversample_plan.json",
                    help="where to write the oversampling plan")
    ap.add_argument("--apply", action="store_true",
                    help="materialize the oversampling plan for the train split")
    args = ap.parse_args()

    root = Path(args.dataset_root)
    report: Dict = {"dataset_root": str(root.resolve()), "splits": {}}
    train_images: Dict[str, Dict[str, int]] = {}
    overall: Counter = Counter()

    for split in args.splits:
        lbl_dir = root / "labels" / split
        if not lbl_dir.is_dir():
            continue
        per_image = scan_labels(lbl_dir)
        instances: Counter = Counter()
        images_with: Counter = Counter()
        for _, classes in per_image.items():
            for name, n in classes.items():
                instances[name] += n
                images_with[name] += 1
                overall[name] += n
        if split == "train":
            train_images = per_image
        report["splits"][split] = {
            "images": len(list((root / "images" / split).glob("*")) ) if (root / "images" / split).is_dir() else 0,
            "labeled_images_with_hazards": len(per_image),
            "instances_per_class": dict(sorted(instances.items())),
            "images_per_class": dict(sorted(images_with.items())),
        }

    counts = [overall.get(c, 0) for c in HAZARD_CLASSES]
    nonzero = [c for c in counts if c > 0]
    report["overall_instances_per_class"] = {c: overall.get(c, 0) for c in HAZARD_CLASSES}
    report["imbalance_ratio"] = (max(nonzero) / min(nonzero)) if nonzero else 0.0
    report["gini"] = round(gini([float(c) for c in counts]), 4)
    report["majority_class"] = HAZARD_CLASSES[counts.index(max(counts))]
    report["minority_class"] = HAZARD_CLASSES[counts.index(min(counts))]

    # Oversampling plan (train split only): repeat factor so each class's total
    # exposure reaches the majority-class exposure, capped at --max-repeats.
    plan = {"strategy": "image-level repeat to equalize class exposure",
            "max_repeats": None, "repeats": {}, "expected_instances_per_class": {}}
    if train_images:
        train_counts: Counter = Counter()
        for classes in train_images.values():
            for name, n in classes.items():
                train_counts[name] += n
        present = {name: n for name, n in train_counts.items() if n > 0}
        if present:
            target_count = max(present.values())
            # exposure share of each class carried by each image
            repeats: Dict[str, int] = {}
            for stem, classes in train_images.items():
                need = 1
                for name, n in classes.items():
                    if train_counts.get(name, 0) <= 0:
                        continue
                    # how many copies so that name reaches target given this image contributes n
                    copies = -(-target_count // train_counts[name])  # ceil
                    need = max(need, min(copies, 8))
                repeats[stem] = need
            plan["max_repeats"] = max(repeats.values())
            plan["repeats"] = dict(sorted(repeats.items()))
            expected: Counter = Counter()
            for stem, r in repeats.items():
                for name, n in train_images[stem].items():
                    expected[name] += n * r
            plan["expected_instances_per_class"] = dict(sorted(expected.items()))

    if args.apply and plan["repeats"]:
        src_img = root / "images" / "train"
        src_lbl = root / "labels" / "train"
        dst_img = root / "images" / "train_balanced"
        dst_lbl = root / "labels" / "train_balanced"
        dst_img.mkdir(parents=True, exist_ok=True)
        dst_lbl.mkdir(parents=True, exist_ok=True)
        copied = 0
        for stem, r in plan["repeats"].items():
            img_path = next((p for p in src_img.iterdir() if p.stem == stem and p.suffix.lower() in IMG_EXTS), None)
            if img_path is None:
                continue
            for k in range(r):
                suffix = "" if k == 0 else f"_r{k}"
                shutil.copy2(img_path, dst_img / f"{stem}{suffix}{img_path.suffix}")
                lbl = src_lbl / f"{stem}.txt"
                if lbl.exists():
                    shutil.copy2(lbl, dst_lbl / f"{stem}{suffix}.txt")
                copied += 1
        plan["applied"] = {"copied_images": copied, "out_dir": str(dst_img)}

    report_path = Path(args.report)
    plan_path = Path(args.plan)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    plan_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    plan_path.write_text(json.dumps(plan, indent=2), encoding="utf-8")

    print(f"[balance] overall instances: {report['overall_instances_per_class']}")
    print(f"[balance] imbalance ratio: {report['imbalance_ratio']:.2f} "
          f"(gini {report['gini']}, majority {report['majority_class']}, minority {report['minority_class']})")
    print(f"[balance] oversample plan: max repeats {plan['max_repeats']} -> {plan_path}")
    print(f"[balance] report -> {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
