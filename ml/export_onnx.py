#!/usr/bin/env python3
"""Export a YOLO road-hazard model to ONNX and verify parity with PyTorch.

* exports via Ultralytics (``--simplify`` runs onnxsim; ``--dynamic`` enables
  dynamic batch/axes — see the note in ml/README.md before using dynamic with
  the FastAPI service),
* runs the ONNX graph with onnxruntime on a sample image (letterboxed exactly
  like the inference service does),
* decodes raw ``[1, 4+nc, N]`` output with the shared NMS and compares the top
  detection against PyTorch (IoU + class match) — a regression gate for the
  export,
* writes ``export_report.json``.

Example:
    python3 export_onnx.py --weights models/best.pt --imgsz 640 \
        --out models/roadguard.onnx --verify
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Optional, Tuple

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hazard_domain import HAZARD_CLASSES, NUM_CLASSES  # noqa: E402
from mlflow_utils import get_git_sha, json_artifact  # noqa: E402
from vision_utils import (  # noqa: E402
    decode_onnx_detections,
    letterbox,
    scale_boxes_back,
)

ML_DIR = Path(__file__).resolve().parent


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--weights", default="models/best.pt")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--out", default="models/roadguard.onnx")
    ap.add_argument("--simplify", action="store_true", default=True, help="run onnx-simplifier (default on)")
    ap.add_argument("--no-simplify", dest="simplify", action="store_false")
    ap.add_argument("--dynamic", action="store_true",
                    help="export with dynamic batch/axes (service currently assumes static 1x)")
    ap.add_argument("--opset", type=int, default=12)
    ap.add_argument("--data", default="dataset/road_hazards.yaml", help="dataset yaml to pick a sample image from")
    ap.add_argument("--sample", default=None, help="explicit sample image for the parity check")
    ap.add_argument("--device", default="cpu", help="device for the PyTorch side of the parity check")
    ap.add_argument("--conf", type=float, default=0.10, help="detection threshold used in the parity check")
    ap.add_argument("--min-iou", type=float, default=0.60, help="parity gate: IoU(top onnx det, top torch det)")
    ap.add_argument("--verify", action="store_true", default=True)
    ap.add_argument("--no-verify", dest="verify", action="store_false")
    return ap.parse_args()


def pick_sample_image(dataset_yaml: Path, explicit: Optional[str]) -> Optional[Path]:
    if explicit:
        p = Path(explicit)
        return p if p.exists() else None
    try:
        from mlflow_utils import resolve_dataset_yaml

        resolved = resolve_dataset_yaml(resolve_yaml_path(dataset_yaml))
    except Exception:  # noqa: BLE001
        return None
    for key in ("test", "val", "train"):
        val = resolved.get(key)
        if not val:
            continue
        for path in ([val] if isinstance(val, str) else val):
            d = Path(path)
            if d.is_dir():
                imgs = sorted(p for p in d.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"})
                if imgs:
                    return imgs[len(imgs) // 2]
            elif d.is_file():
                return d
    return None


def resolve_yaml_path(dataset_yaml: Path) -> Path:
    """--data may be a yaml path; keep as-is (resolution happens downstream)."""
    return dataset_yaml


def run_onnx_session(onnx_path: Path, img_bgr: np.ndarray, imgsz: int,
                     conf: float, iou: float) -> Tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    input_name = sess.get_inputs()[0].name
    lb, scale, pad = letterbox(img_bgr, imgsz)
    blob = lb[:, :, ::-1].transpose(2, 0, 1).astype(np.float32) / 255.0
    blob = np.ascontiguousarray(blob[None])
    t0 = time.perf_counter()
    outputs = sess.run(None, {input_name: blob})
    onnx_ms = (time.perf_counter() - t0) * 1000.0
    raw = outputs[0] if isinstance(outputs, (list, tuple)) else outputs
    boxes, scores, clses = decode_onnx_detections(raw, NUM_CLASSES, conf, iou, max_side=imgsz)
    boxes = scale_boxes_back(boxes, scale, pad, img_bgr.shape[:2])
    return boxes, scores, clses, onnx_ms


def run_pytorch(weights: Path, img_bgr: np.ndarray, imgsz: int, conf: float,
                iou: float, device: str) -> Tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    from ultralytics import YOLO

    model = YOLO(str(weights))
    t0 = time.perf_counter()
    res = model.predict(img_bgr, imgsz=imgsz, conf=conf, iou=iou, device=device,
                        verbose=False, save=False)[0]
    torch_ms = (time.perf_counter() - t0) * 1000.0
    boxes = res.boxes.xyxy.cpu().numpy() if len(res.boxes) else np.zeros((0, 4))
    scores = res.boxes.conf.cpu().numpy() if len(res.boxes) else np.zeros((0,))
    clses = res.boxes.cls.cpu().numpy().astype(np.int64) if len(res.boxes) else np.zeros((0,), np.int64)
    return boxes, scores, clses, torch_ms


def main() -> int:
    args = parse_args()
    weights = Path(args.weights).resolve()
    if not weights.exists():
        print(f"[export] weights not found: {weights} — run `make train` first.")
        return 2

    from ultralytics import YOLO

    model = YOLO(str(weights))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"[export] exporting {weights.name} -> ONNX (simplify={args.simplify}, dynamic={args.dynamic}, opset={args.opset})")
    exported = model.export(
        format="onnx", imgsz=args.imgsz, simplify=args.simplify,
        dynamic=args.dynamic, opset=args.opset, half=False, device=args.device,
    )
    produced = Path(str(exported))
    if produced.resolve() != out.resolve():
        import shutil

        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(produced), out)
    onnx_path = out

    report = {
        "weights": str(weights),
        "onnx": str(out.resolve()),
        "imgsz": args.imgsz,
        "opset": args.opset,
        "simplify": args.simplify,
        "dynamic": args.dynamic,
        "dynamic_axes_note": (
            f"ONNX export uses fixed input 1x3x{args.imgsz}x{args.imgsz} by default for maximum runtime "
            "compatibility. --dynamic adds dynamic batch/axes (batch, H, W free); the "
            "FastAPI service currently always feeds batch=1 at the trained imgsz, so "
            "keep --dynamic off unless you deploy batched pipelines."
        ),
        "bytes": out.stat().st_size if out.exists() else None,
        "git_sha": get_git_sha(),
    }

    ok = True
    if args.verify:
        sample = pick_sample_image(Path(args.data), args.sample)
        if sample is None:
            print("[export] no sample image found for verification; skipping parity check")
            report["verify"] = {"skipped": "no sample image"}
        else:
            img = cv2.imread(str(sample))
            print(f"[export] parity check on {sample.name}")
            onnx_boxes, onnx_scores, onnx_clses, onnx_ms = run_onnx_session(
                out, img, args.imgsz, args.conf, args.iou)
            torch_boxes, torch_scores, torch_clses, torch_ms = run_pytorch(
                weights, img, args.imgsz, args.conf, args.iou, args.device)

            from vision_utils import iou_xyxy

            if len(onnx_boxes) and len(torch_boxes):
                iou_top = iou_xyxy(onnx_boxes[0], torch_boxes[0])
                cls_match = int(onnx_clses[0]) == int(torch_clses[0])
            elif not len(onnx_boxes) and not len(torch_boxes):
                iou_top, cls_match = 1.0, True
            else:
                iou_top, cls_match = 0.0, False
            ok = bool(iou_top >= args.min_iou and cls_match)
            report["verify"] = {
                "sample": str(sample),
                "iou_top": round(float(iou_top), 4),
                "class_match": cls_match,
                "min_iou_gate": args.min_iou,
                "passed": ok,
                "onnx_top": {
                    "class": HAZARD_CLASSES[int(onnx_clses[0])] if len(onnx_clses) else None,
                    "conf": round(float(onnx_scores[0]), 4) if len(onnx_scores) else None,
                    "bbox_xyxy": [round(float(v), 1) for v in onnx_boxes[0]] if len(onnx_boxes) else None,
                    "latency_ms": round(onnx_ms, 2),
                    "num_detections": int(len(onnx_scores)),
                },
                "pytorch_top": {
                    "class": HAZARD_CLASSES[int(torch_clses[0])] if len(torch_clses) else None,
                    "conf": round(float(torch_scores[0]), 4) if len(torch_scores) else None,
                    "bbox_xyxy": [round(float(v), 1) for v in torch_boxes[0]] if len(torch_boxes) else None,
                    "latency_ms": round(torch_ms, 2),
                    "num_detections": int(len(torch_scores)),
                },
            }

    report["passed"] = ok
    report_path = json_artifact(report, "export_report.json", artifact_path="reports")
    # Keep a copy next to the model as well
    out.with_suffix(".report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"[export] ONNX written -> {out} ({report['bytes']} bytes)")
    if "verify" in report and not report["verify"].get("skipped"):
        print(f"[export] parity: IoU(top)={report['verify']['iou_top']} "
              f"class_match={report['verify']['class_match']} passed={ok}")
    print(f"[export] report -> {report_path} and {out.with_suffix('.report.json')}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
