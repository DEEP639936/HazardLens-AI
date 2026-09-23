#!/usr/bin/env python3
"""Train a YOLOv8 road-hazard detector with full MLflow tracking.

Wraps Ultralytics YOLOv8 (default: ``yolov8s.pt``) and logs to MLflow:

* params  — model, epochs, imgsz, batch, device, seed, dataset hash, git sha,
            class names, dataset version (manifest artifact)
* metrics — per-epoch ``box_loss``/``cls_loss``/``dfl_loss``, ``precision``,
            ``recall``, ``mAP50``, ``mAP50_95`` (via ``on_fit_epoch_end`` callback)
* artifacts — best.pt, results.png, confusion_matrix*.png, PR/F1 curves,
            dataset manifest, resolved dataset yaml, sample preview grids

Example:
    python3 train.py --data dataset/road_hazards.yaml --model yolov8s.pt \
        --epochs 50 --imgsz 640 --batch 16 --device cpu
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Dict

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mlflow_utils import (  # noqa: E402
    get_git_sha,
    hash_dataset,
    json_artifact,
    resolve_dataset_yaml,
    start_rg_run,
    write_resolved_yaml,
)

ML_DIR = Path(__file__).resolve().parent

# Whitelisted trainer metrics -> flat MLflow metric names.
METRIC_ALIASES: Dict[str, str] = {
    "train/box_loss": "train_box_loss",
    "train/cls_loss": "train_cls_loss",
    "train/dfl_loss": "train_dfl_loss",
    "val/box_loss": "val_box_loss",
    "val/cls_loss": "val_cls_loss",
    "val/dfl_loss": "val_dfl_loss",
    "metrics/precision(B)": "precision",
    "metrics/recall(B)": "recall",
    "metrics/mAP50(B)": "mAP50",
    "metrics/mAP50-95(B)": "mAP50_95",
}


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--data", default="dataset/road_hazards.yaml", help="dataset yaml (relative paths OK)")
    ap.add_argument("--model", default="yolov8s.pt",
                    help="Ultralytics model (yolov8s.pt / yolov8n.pt / a .yaml to train from scratch)")
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--device", default="cpu", help="cpu | 0 | 0,1 | mps")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--patience", type=int, default=50, help="early-stopping patience (epochs)")
    ap.add_argument("--run-name", default=None)
    ap.add_argument("--project", default=None, help="training output root (default: ml/runs)")
    ap.add_argument("--no-mlflow", action="store_true", help="skip MLflow tracking")
    ap.add_argument("--no-copy-weights", action="store_true",
                    help="do not copy best.pt into ml/models/best.pt")
    return ap.parse_args()


def main() -> int:
    args = parse_args()

    # Resolve the dataset yaml to absolute paths so Ultralytics cannot
    # mis-interpret `path` against its own datasets_dir.
    data_yaml = Path(args.data).resolve()
    if not data_yaml.exists():
        print(f"[train] dataset yaml not found: {data_yaml}")
        return 2
    resolved = resolve_dataset_yaml(data_yaml)
    resolved_path = write_resolved_yaml(
        resolved, ML_DIR / "runs" / ".resolved" / f"{data_yaml.stem}.resolved.yaml"
    )
    dataset_root = Path(resolved["path"])
    if not dataset_root.is_dir():
        print(f"[train] resolved dataset path does not exist: {dataset_root}")
        print("[train] generate demo data (make demo-data) or place real data — see README.")
        return 2

    ds_version = hash_dataset(dataset_root)
    ds_version["yaml"] = str(data_yaml)
    manifest_path = json_artifact(ds_version, "dataset_manifest.json", artifact_path="dataset")

    run_name = args.run_name or f"{Path(args.model).stem}-e{args.epochs}-{int(time.time())}"
    run = None
    mlflow = None
    if not args.no_mlflow:
        mlflow = start_rg_run(run_name, tags={
            "stage": "train", "model": args.model, "dataset_hash": ds_version["dataset_hash"],
        })
        run = mlflow.active_run()
        print(f"[train] MLflow run: {run.info.run_id}  (tracking URI: {mlflow.get_tracking_uri()})")

    from ultralytics import YOLO

    model = YOLO(args.model)

    epoch_state: Dict[str, int] = {"step": -1}

    def on_fit_epoch_end(trainer) -> None:
        """Log whitelisted metrics every (validation) epoch."""
        if mlflow is None:
            return
        epoch = int(getattr(trainer, "epoch", epoch_state["step"] + 1))
        epoch_state["step"] = epoch
        payload = {}
        for src, dst in METRIC_ALIASES.items():
            if src in trainer.metrics:
                value = trainer.metrics[src]
                try:
                    payload[dst] = float(value)
                except (TypeError, ValueError):
                    continue
        if payload:
            mlflow.log_metrics(payload, step=epoch)

    def on_train_end(trainer) -> None:
        if mlflow is None:
            return
        save_dir = Path(getattr(trainer, "save_dir", ML_DIR / "runs" / "unknown"))
        artifacts = [
            save_dir / "weights" / "best.pt",
            save_dir / "weights" / "last.pt",
            save_dir / "results.png",
            save_dir / "results.csv",
            save_dir / "confusion_matrix.png",
            save_dir / "confusion_matrix_normalized.png",
            save_dir / "labels.jpg",
            save_dir / "labels_correlogram.jpg",
        ]
        artifacts += sorted(p for p in save_dir.glob("*_curve.png"))       # PR/F1/P/R curves
        artifacts += sorted(p for p in save_dir.glob("val_batch*_pred.jpg"))
        artifacts += sorted(p for p in save_dir.glob("train_batch*.jpg"))
        for art in artifacts:
            if art.exists():
                mlflow.log_artifact(str(art), artifact_path="training")

    if not args.no_mlflow:
        model.add_callback("on_fit_epoch_end", on_fit_epoch_end)
        model.add_callback("on_train_end", on_train_end)

    overrides = dict(
        data=str(resolved_path),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        workers=args.workers,
        seed=args.seed,
        patience=args.patience,
        project=str(args.project or (ML_DIR / "runs")),
        name=run_name,
        exist_ok=True,
        plots=True,
        verbose=True,
    )
    print(f"[train] starting: {args.model} | data={resolved_path} | overrides={ {k: v for k, v in overrides.items() if k != 'data'} }")
    results = model.train(**overrides)

    save_dir = Path(model.trainer.save_dir) if getattr(model, "trainer", None) else ML_DIR / "runs" / run_name
    best_pt = save_dir / "weights" / "best.pt"

    final_metrics: Dict[str, float] = {}
    try:  # results is a DetMetrics-like object (or None when epochs=0)
        if results is not None:
            box = getattr(results.box, "map50", None)
            if box is not None:
                final_metrics = {
                    "mAP50": float(results.box.map50),
                    "mAP50_95": float(results.box.map),
                    "precision": float(results.box.mp),
                    "recall": float(results.box.mr),
                }
    except Exception:  # noqa: BLE001 — metric shape varies across versions
        pass

    if not args.no_copy_weights and best_pt.exists():
        models_dir = ML_DIR / "models"
        models_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(best_pt, models_dir / "best.pt")
        print(f"[train] best weights copied -> {models_dir / 'best.pt'}")

    summary = {
        "run_name": run_name,
        "mlflow_run_id": run.info.run_id if run else None,
        "git_sha": get_git_sha(),
        "model": args.model,
        "dataset": str(data_yaml),
        "dataset_hash": ds_version["dataset_hash"],
        "overrides": {k: v for k, v in overrides.items()},
        "best_weights": str(best_pt),
        "final_metrics": final_metrics,
        "classes": list(model.names.values()) if hasattr(model, "names") else [],
    }
    json_artifact(summary, "train_summary.json", artifact_path="reports")
    if run:
        mlflow.set_tag("best_weights", str(best_pt))
        mlflow.log_param("dataset_hash", ds_version["dataset_hash"])
        mlflow.log_metrics({f"final_{k}": v for k, v in final_metrics.items()})
        mlflow.end_run(status="FINISHED")
    print(f"[train] done. best={best_pt}")
    print(f"[train] summary -> {ML_DIR / 'reports' / 'train_summary.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
