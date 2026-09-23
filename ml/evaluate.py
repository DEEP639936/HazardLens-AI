#!/usr/bin/env python3
"""Evaluate a trained road-hazard detector on the test split.

Loads ``best.pt`` (or any YOLO weights), runs Ultralytics validation for
mAP@50 / mAP@50-95 / per-class precision, recall and AP, renders the confusion
matrix and PR curves as PNGs, benchmarks single-image latency (p50/p95/p99 ms
on CPU by default), and writes everything to ``metrics.json``.

Optional ``--register`` publishes the weights to the MLflow model registry
(uri from ``MLFLOW_TRACKING_URI``, name from ``MLFLOW_REGISTERED_MODEL``).

Example:
    python3 evaluate.py --data dataset/road_hazards.yaml \
        --weights models/best.pt --split test --device cpu \
        --report reports/metrics.json [--register]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hazard_domain import HAZARD_CLASSES  # noqa: E402
from mlflow_utils import (  # noqa: E402
    get_git_sha,
    hash_dataset,
    json_artifact,
    log_per_class_table,
    resolve_dataset_yaml,
    start_rg_run,
)
from vision_utils import letterbox  # noqa: E402

ML_DIR = Path(__file__).resolve().parent


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--data", default="dataset/road_hazards.yaml")
    ap.add_argument("--weights", default="models/best.pt")
    ap.add_argument("--split", default="test", choices=["train", "val", "test"])
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--iou", type=float, default=0.45)
    ap.add_argument("--report", default="reports/metrics.json")
    ap.add_argument("--benchmark-runs", type=int, default=20, help="latency timing iterations")
    ap.add_argument("--register", action="store_true", help="log + register the model in MLflow")
    ap.add_argument("--no-mlflow", action="store_true", help="skip MLflow tracking")
    ap.add_argument("--name", default=None, help="evaluation run name")
    return ap.parse_args()


def latency_benchmark(model, images: List[np.ndarray], imgsz: int, conf: float,
                      iou: float, device: str, runs: int) -> Dict:
    """End-to-end single-image latency (letterbox + forward + NMS), wall-clock."""
    if not images:
        return {"error": "no sample images found for benchmark"}
    sample = images[0]
    for _ in range(3):  # warmup (threads, kernels, allocator)
        model.predict(sample, imgsz=imgsz, conf=conf, iou=iou, device=device,
                      verbose=False, save=False)
    times = []
    for i in range(runs):
        img = images[i % len(images)]
        t0 = time.perf_counter()
        model.predict(img, imgsz=imgsz, conf=conf, iou=iou, device=device,
                      verbose=False, save=False)
        times.append((time.perf_counter() - t0) * 1000.0)
    import torch

    arr = np.asarray(times, dtype=np.float64)
    return {
        "device": device,
        "torch_threads": int(torch.get_num_threads()),
        "warmup_runs": 3,
        "timed_runs": runs,
        "p50_ms": round(float(np.percentile(arr, 50)), 2),
        "p95_ms": round(float(np.percentile(arr, 95)), 2),
        "p99_ms": round(float(np.percentile(arr, 99)), 2),
        "mean_ms": round(float(arr.mean()), 2),
        "images_per_sec": round(1000.0 / float(arr.mean()), 2),
    }


def collect_benchmark_images(dataset_root: Path, split: str, limit: int = 8) -> List[np.ndarray]:
    import cv2

    img_dir = dataset_root / "images" / split
    out = []
    if not img_dir.is_dir():
        return out
    for p in sorted(img_dir.iterdir()):
        if p.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
            continue
        img = cv2.imread(str(p))
        if img is not None:
            out.append(img)
        if len(out) >= limit:
            break
    return out


def register_in_mlflow(weights: Path, run, payload: Dict) -> Optional[str]:
    """Log the model to the MLflow registry; returns version string or None."""
    try:
        import mlflow
        import torch

        name = __import__("os").environ.get("MLFLOW_REGISTERED_MODEL", "roadguard-yolo")
        # Log the raw torch module as a pyfunc model + the .pt as an artifact.
        yolo = __import__("ultralytics").YOLO(str(weights))
        mlflow.pytorch.log_model(
            yolo.model, artifact_path="model", registered_model_name=name,
            pip_requirements=["torch", "ultralytics", "numpy", "opencv-python-headless"],
        )
        client = mlflow.tracking.MlflowClient()
        versions = client.get_latest_versions(name, stages=["None"])
        version = versions[0].version
        client.set_model_version_tag(name, version, "mAP50", str(payload["overall"]["mAP50"]))
        client.set_model_version_tag(name, version, "mAP50_95", str(payload["overall"]["mAP50_95"]))
        client.set_model_version_tag(name, version, "git_sha", payload["git_sha"])
        client.set_model_version_tag(name, version, "dataset_hash", payload["dataset_hash"])
        return f"{name}@v{version}"
    except Exception as exc:  # noqa: BLE001 — registry may be unavailable
        print(f"[evaluate] MLflow registration skipped: {exc}")
        return None


def main() -> int:
    args = parse_args()
    weights = Path(args.weights).resolve()
    if not weights.exists():
        print(f"[evaluate] weights not found: {weights} — run `make train` first.")
        return 2

    data_yaml = Path(args.data).resolve()
    if not data_yaml.exists():
        print(f"[evaluate] dataset yaml not found: {data_yaml}")
        return 2
    resolved = resolve_dataset_yaml(data_yaml)
    dataset_root = Path(resolved["path"])
    ds_version = hash_dataset(dataset_root, splits=(args.split,))

    run = None
    if not args.no_mlflow:
        run = start_rg_run(args.name or f"eval-{weights.parent.parent.name}", tags={
            "stage": "evaluate", "weights": str(weights), "dataset_hash": ds_version["dataset_hash"],
        })

    from ultralytics import YOLO

    model = YOLO(str(weights))
    print(f"[evaluate] validating {weights.name} on split={args.split} ...")
    metrics = model.val(
        data=resolve_dataset_yaml_file(data_yaml, resolved),
        split=args.split, imgsz=args.imgsz, batch=args.batch, device=args.device,
        conf=args.conf, iou=args.iou, plots=True, verbose=False,
        project=str(ML_DIR / "runs"), name=f"eval_{args.split}_{int(time.time())}",
        exist_ok=True,
    )

    box = metrics.box
    overall = {
        "mAP50": round(float(box.map50), 4),
        "mAP50_95": round(float(box.map), 4),
        "precision": round(float(box.mp), 4),
        "recall": round(float(box.mr), 4),
    }

    per_class: List[Dict] = []
    idx = getattr(box, "ap_class_index", None)
    if idx is not None:
        ap50 = getattr(box, "ap50", None)
        ap = getattr(box, "ap", None)
        p = getattr(box, "p", None)
        r = getattr(box, "r", None)
        for row, cid in enumerate(idx):
            cid = int(cid)
            per_class.append({
                "class_id": cid,
                "class": HAZARD_CLASSES[cid] if cid < len(HAZARD_CLASSES) else str(cid),
                "precision": round(float(p[row]), 4) if p is not None and row < len(p) else None,
                "recall": round(float(r[row]), 4) if r is not None and row < len(r) else None,
                "ap50": round(float(ap50[row]), 4) if ap50 is not None and row < len(ap50) else None,
                "ap50_95": round(float(ap[row].mean()), 4) if ap is not None and row < len(ap) else None,
            })

    save_dir = Path(getattr(metrics, "save_dir", ML_DIR / "runs" / "eval"))
    cm_png = save_dir / "confusion_matrix.png"
    pr_pngs = sorted(save_dir.glob("*PR_curve*")) + sorted(save_dir.glob("*F1_curve*"))

    images = collect_benchmark_images(dataset_root, args.split)
    latency = latency_benchmark(model, images, args.imgsz, args.conf, args.iou, args.device, args.benchmark_runs)

    payload: Dict = {
        "model": weights.name,
        "weights": str(weights),
        "dataset": str(data_yaml),
        "dataset_hash": ds_version["dataset_hash"],
        "split": args.split,
        "imgsz": args.imgsz,
        "conf": args.conf,
        "iou": args.iou,
        "overall": overall,
        "per_class": per_class,
        "latency": latency,
        "git_sha": get_git_sha(),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mlflow_run_id": run.info.run_id if run else None,
    }

    # Report + artifacts
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"[evaluate] overall: {overall}")
    print(f"[evaluate] latency: {latency}")
    print(f"[evaluate] per class: {[(c['class'], c['ap50']) for c in per_class]}")
    print(f"[evaluate] report -> {report_path}")

    if run:
        import mlflow

        mlflow.log_metrics({f"overall_{k}": v for k, v in overall.items()})
        mlflow.log_metrics({
            f"latency_{k.replace('_ms', '_ms')}": v for k, v in latency.items()
            if isinstance(v, (int, float))
        })
        mlflow.log_params({"weights": str(weights), "split": args.split,
                           "imgsz": args.imgsz, "conf": args.conf, "iou": args.iou,
                           "dataset_hash": ds_version["dataset_hash"]})
        for art in [report_path, cm_png, *pr_pngs]:
            if Path(art).exists():
                mlflow.log_artifact(str(art), artifact_path="evaluation")
        log_per_class_table(
            {c["class"]: {k: v for k, v in c.items() if k not in ("class", "class_id") and v is not None}
             for c in per_class}
        )
        if args.register:
            reg = register_in_mlflow(weights, run, payload)
            if reg:
                mlflow.set_tag("registered_model", reg)
                payload["registered_model"] = reg
                report_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        mlflow.end_run(status="FINISHED")
    elif args.register:
        print("[evaluate] --register requires MLflow tracking (remove --no-mlflow).")
    return 0


def resolve_dataset_yaml_file(data_yaml: Path, resolved: Dict) -> str:
    """Materialize a resolved yaml (absolute paths) for Ultralytics val()."""
    from mlflow_utils import write_resolved_yaml

    out = ML_DIR / "runs" / ".resolved" / f"{data_yaml.stem}.eval.resolved.yaml"
    return str(write_resolved_yaml(resolved, out))


if __name__ == "__main__":
    raise SystemExit(main())
