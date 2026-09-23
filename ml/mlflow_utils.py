"""MLflow helpers shared by train.py / evaluate.py / the inference service.

* tracking URI + experiment resolution from env (``MLFLOW_TRACKING_URI``,
  ``MLFLOW_EXPERIMENT``) with a local file-store default under ``ml/mlruns``.
* :func:`start_rg_run` — wrapper that sets experiment, tags (git sha, dataset
  version) and returns the active run.
* :func:`log_detections_grid` — renders annotated sample images (boxes drawn
  with OpenCV) into a single grid PNG and logs it as an artifact.
* :func:`log_per_class_table` — per-class metrics table logged both as an
  MLflow table artifact (``log_table``) and a CSV fallback.
* dataset versioning: :func:`hash_dataset` builds a stable hash over label
  contents + image inventory (name, size, mtime) so runs are comparable.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence

import cv2
import numpy as np

from vision_utils import draw_detections, tile_grid  # type: ignore  # noqa: E402

ML_DIR = Path(__file__).resolve().parent


# ---------------------------------------------------------------------------
# Tracking setup
# ---------------------------------------------------------------------------
def tracking_uri() -> str:
    """Tracking backend URI.

    Default: sqlite (``ml/mlflow.db``) — MLflow >=3.15 raises on fresh file
    stores. An explicit ``MLFLOW_TRACKING_URI`` env var always wins; a
    ``file://`` URI is auto-opted-in below for convenience.
    """
    uri = os.environ.get("MLFLOW_TRACKING_URI", "").strip()
    if uri:
        return uri
    return f"sqlite:///{ML_DIR}/mlflow.db"


def experiment_name() -> str:
    return os.environ.get("MLFLOW_EXPERIMENT", "roadguard-atlas")


def setup_mlflow() -> "mlflow":  # noqa: F821 — imported lazily
    import mlflow

    uri = tracking_uri()
    if uri.startswith("file:"):
        # MLflow >=3.15 gates the legacy file store behind this flag.
        os.environ.setdefault("MLFLOW_ALLOW_FILE_STORE", "true")
    mlflow.set_tracking_uri(uri)
    name = experiment_name()
    exp = mlflow.get_experiment_by_name(name)
    if exp is None:
        mlflow.create_experiment(name, artifact_location=f"file://{ML_DIR / 'mlruns'}")
    else:
        mlflow.set_experiment(experiment_id=exp.experiment_id)
    return mlflow


def get_git_sha(repo: Path = ML_DIR.parent) -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=str(repo), stderr=subprocess.DEVNULL
        ).decode().strip()
    except Exception:  # noqa: BLE001 — git may be unavailable
        return "unknown"


def start_rg_run(
    name: str,
    tags: Optional[Dict[str, str]] = None,
):
    """Set up MLflow from env and start a run with standard RoadGuard tags."""
    mlflow = setup_mlflow()
    run_tags = {
        "project": "roadguard-atlas",
        "git_sha": get_git_sha(),
        **(tags or {}),
    }
    return mlflow.start_run(run_name=name, tags=run_tags)


# ---------------------------------------------------------------------------
# Dataset versioning
# ---------------------------------------------------------------------------
def hash_dataset(dataset_root: Path, splits: Sequence[str] = ("train", "val", "test")) -> Dict:
    """Content hash + inventory of a YOLO-layout dataset.

    Hash covers: sorted label-file relative paths, the bytes of every label
    file, and per-image (relative path, byte size, mtime). Deterministic for
    identical datasets; sensitive to any label edit or image set change.
    """
    root = Path(dataset_root)
    h = hashlib.sha256()
    inventory: List[Dict] = []
    label_files: List[Path] = []
    for split in splits:
        lbl_dir = root / "labels" / split
        if lbl_dir.is_dir():
            label_files.extend(sorted(lbl_dir.glob("*.txt")))
    for lbl in label_files:
        h.update(str(lbl.relative_to(root)).encode())
        h.update(lbl.read_bytes())
    for split in splits:
        img_dir = root / "images" / split
        if not img_dir.is_dir():
            continue
        for img in sorted(img_dir.rglob("*")):
            if img.is_file():
                st = img.stat()
                h.update(f"{img.relative_to(root)}|{st.st_size}|{int(st.st_mtime)}".encode())
                inventory.append({
                    "split": split, "file": str(img.relative_to(root)),
                    "bytes": st.st_size,
                })
    return {
        "dataset_root": str(root.resolve()),
        "dataset_hash": h.hexdigest()[:16],
        "num_label_files": len(label_files),
        "num_images": len(inventory),
    }


def resolve_dataset_yaml(yaml_path: Path) -> Dict:
    """Resolve a YOLO dataset yaml to absolute paths.

    Resolution order for ``path``: absolute → ``ROADGUARD_DATA_ROOT`` env →
    relative to the yaml file's directory. Returns the parsed dict with
    absolute ``path``; ``train``/``val``/``test`` are made absolute too.
    """
    import yaml

    yaml_path = Path(yaml_path).resolve()
    cfg = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    raw_path = str(cfg.get("path", ""))
    if raw_path and Path(raw_path).is_absolute():
        base = Path(raw_path)
    elif os.environ.get("ROADGUARD_DATA_ROOT", "").strip():
        base = Path(os.environ["ROADGUARD_DATA_ROOT"].strip())
    else:
        base = (yaml_path.parent / raw_path).resolve() if raw_path else yaml_path.parent

    resolved = dict(cfg)
    resolved["path"] = str(base)
    for key in ("train", "val", "test"):
        if key in cfg and isinstance(cfg[key], str):
            resolved[key] = str((base / cfg[key]).resolve())
        elif key in cfg and isinstance(cfg[key], list):
            resolved[key] = [str((base / p).resolve()) for p in cfg[key]]
    resolved["_resolved_from"] = str(yaml_path)
    return resolved


def write_resolved_yaml(resolved: Dict, out_path: Path) -> Path:
    """Persist a resolved dataset yaml (absolute paths) for Ultralytics."""
    import yaml

    clean = {k: v for k, v in resolved.items() if not k.startswith("_")}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(yaml.safe_dump(clean, sort_keys=False), encoding="utf-8")
    return out_path


# ---------------------------------------------------------------------------
# Artifact helpers
# ---------------------------------------------------------------------------
def log_detections_grid(
    images: Iterable[np.ndarray],
    boxes_per_image: Sequence[np.ndarray],
    classes_per_image: Sequence[np.ndarray],
    scores_per_image: Sequence[Sequence[float]],
    class_names: Sequence[str],
    artifact_file: str = "detections_grid.png",
    cols: int = 3,
    run=None,
) -> Optional[Path]:
    """Render annotated samples into one grid PNG and log it to MLflow."""
    mlflow = setup_mlflow()
    rendered = []
    for img, boxes, clses, scores in zip(images, boxes_per_image, classes_per_image, scores_per_image):
        rendered.append(draw_detections(img, boxes, clses, scores, class_names))
    if not rendered:
        return None
    out = ML_DIR / "reports" / artifact_file
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), tile_grid(rendered, cols=cols))
    mlflow.log_artifact(str(out), artifact_path="previews")
    return out


def log_per_class_table(per_class: Dict[str, Dict[str, float]], artifact_file: str = "per_class_metrics") -> None:
    """Log a {class: {metric: value}} table (MLflow table + CSV fallback)."""
    mlflow = setup_mlflow()
    columns = sorted({k for row in per_class.values() for k in row})
    data = [{"hazard_class": cls, **{c: row.get(c) for c in columns}} for cls, row in per_class.items()]
    try:
        import pandas as pd

        mlflow.log_table(pd.DataFrame(data), artifact_file=f"{artifact_file}.json")
    except Exception:  # noqa: BLE001 — table logging needs pandas/table store
        out = ML_DIR / "reports" / f"{artifact_file}.csv"
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["hazard_class", *columns])
            writer.writeheader()
            writer.writerows(data)
        mlflow.log_artifact(str(out), artifact_path="metrics")


def json_artifact(payload: dict, artifact_file: str, artifact_path: str = "reports") -> Path:
    """Write a JSON payload under ml/reports and log it to the active run."""
    mlflow = setup_mlflow()
    out = ML_DIR / "reports" / artifact_file
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    try:
        mlflow.log_artifact(str(out), artifact_path=artifact_path)
    except Exception:  # noqa: BLE001 — logging is best-effort outside a run
        pass
    return out


__all__ = [
    "tracking_uri", "experiment_name", "setup_mlflow", "get_git_sha", "start_rg_run",
    "hash_dataset", "resolve_dataset_yaml", "write_resolved_yaml",
    "log_detections_grid", "log_per_class_table", "json_artifact",
]
