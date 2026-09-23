"""Pipeline sanity: generate the synthetic demo dataset, split it, then run
ml/scripts/validate_dataset.py and assert the JSON report is sane.

Runs the real scripts as subprocesses (the same way `make demo-data` does) so
the test exercises the exact CLI surface users hit.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
PY = sys.executable


def _run(*args: str, expect_ok: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run([PY, *args], capture_output=True, text=True, cwd=str(ML_DIR))
    if expect_ok and proc.returncode != 0:
        raise AssertionError(
            f"command failed ({proc.returncode}): {' '.join(args)}\n"
            f"stdout:\n{proc.stdout[-2000:]}\nstderr:\n{proc.stderr[-2000:]}"
        )
    return proc


def test_demo_data_generation_and_validation(tmp_path: Path):
    demo_root = tmp_path / "demo"
    report_path = tmp_path / "validate_report.json"

    # 1. generate a small synthetic dataset (fast: 12 images, 96 px)
    _run("scripts/make_demo_data.py", "--out", str(demo_root), "--num", "12",
         "--size", "96", "--seed", "7")

    # 2. stratified 70/20/10 split
    _run("scripts/split_dataset.py", "--dataset-root", str(demo_root),
         "--ratios", "0.7", "0.2", "0.1", "--seed", "7")

    # 3. validate
    proc = _run("scripts/validate_dataset.py", "--dataset-root", str(demo_root),
                "--report", str(report_path))
    assert "[validate]" in proc.stdout

    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["ok"] is True, f"validation errors: {report['issues'][:10]}"
    assert report["totals"]["errors"] == 0
    assert report["totals"]["images"] == 12
    assert report["totals"]["instances"] > 0

    # splits sum to the dataset size and respect the 70/20/10 ratios
    stats = {s["split"]: s for s in report["splits"]}
    assert set(stats) == {"train", "val", "test"}
    total = sum(s["images"] for s in report["splits"])
    assert total == 12
    assert stats["train"]["images"] >= 8 and stats["val"]["images"] >= 2 and stats["test"]["images"] >= 1

    # per-class counts agree with the generator manifest, all ids in range
    manifest = json.loads((demo_root / "make_demo_data.manifest.json").read_text(encoding="utf-8"))
    per_class = report["instances_per_class"]
    for cls, n in manifest["instances_per_class"].items():
        assert per_class.get(cls, 0) == n, f"{cls}: report={per_class.get(cls, 0)} manifest={n}"
    assert set(per_class) <= set(manifest["classes"])  # no out-of-range class ids

    # every image has a label file next to it
    for split in ("train", "val", "test"):
        imgs = list((demo_root / "images" / split).iterdir())
        lbls = {p.stem for p in (demo_root / "labels" / split).glob("*.txt")}
        for img in imgs:
            assert img.stem in lbls, f"missing label for {img.name} in {split}"

    # demo yaml generated for train.py
    yaml_path = ML_DIR / "dataset" / "road_hazards.demo.yaml"
    assert yaml_path.exists()
    text = yaml_path.read_text(encoding="utf-8")
    assert str(demo_root.resolve()) in text
    assert "6: edge_damage" in text  # canonical class order preserved


def test_validator_rejects_out_of_range_class(tmp_path: Path):
    """A label with class id 7 (out of range for 7 classes) must fail validation."""
    root = tmp_path / "bad"
    (root / "images" / "train").mkdir(parents=True)
    (root / "labels" / "train").mkdir(parents=True)
    import numpy as np
    import cv2

    img = np.full((64, 64, 3), 128, dtype=np.uint8)
    cv2.imwrite(str(root / "images" / "train" / "a.jpg"), img)
    (root / "labels" / "train" / "a.txt").write_text("7 0.5 0.5 0.2 0.2\n", encoding="utf-8")

    report_path = tmp_path / "bad_report.json"
    proc = _run("scripts/validate_dataset.py", "--dataset-root", str(root),
                "--report", str(report_path), expect_ok=False)
    assert proc.returncode == 1
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["ok"] is False
    codes = {i["code"] for i in report["issues"]}
    assert "CLASS_OUT_OF_RANGE" in codes
