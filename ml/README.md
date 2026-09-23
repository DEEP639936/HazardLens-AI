# RoadGuard Atlas — ML Pipeline (YOLOv8 · PyTorch · MLflow · OpenCV)

Reproducible computer-vision pipeline for the seven hazard classes:
`pothole · crack · erosion · waterlogging · marking · debris · edge_damage`.

```
dataset prep ──▶ validate ──▶ split ──▶ train (MLflow-tracked) ──▶ evaluate ──▶ export ONNX ──▶ serve
     ▲              │                        │
     └── make_demo_data (synthetic, no download needed)      └── mlflow ui
```

## Quick start (CPU, no dataset download)

```bash
cd ml
python3.10 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

make demo          # generates synthetic demo images + labels into datasets/demo
make validate DATA=datasets/demo/data.yaml
make train DATA=datasets/demo/data.yaml EPOCHS=2   # smoke run
make evaluate
make export
make serve          # uvicorn inference_service on :8100 (docs at /docs)
```

GPU training: `make train DEVICE=0 EPOCHS=100 IMG=640 BATCH=16 MODEL=yolov8m.pt`.

## MLflow experiment tracking

Every `train.py` run logs parameters (model, epochs, imgsz, batch, dataset sha),
per-epoch metrics (box_loss, mAP@50, mAP@50-95, precision, recall), artifacts
(weights, results, confusion matrix, PR curve, annotated detection grid) and the
git commit. Browse with:

```bash
make mlflow-ui     # http://localhost:5000  (backend store: mlruns/)
```

Register a production candidate: `python evaluate.py --register --model-version roadguard-yolo-vX.Y`
→ then register the same `version` in the admin **Model registry** (command center → Settings)
or `POST /api/admin/model-versions`.

## Dataset schema (YOLO format)

`dataset/road_hazards.yaml` defines the 7-class layout:

```yaml
names: [pothole, crack, erosion, waterlogging, marking, debris, edge_damage]
train: images/train   # labels mirror images/ as .txt (class cx cy w h — normalized)
val: images/val
test: images/test
```

### Public datasets (place raw data in `datasets/` — gitignored)

| Dataset | Classes overlap | License | Notes |
|---|---|---|---|
| **RDD2022** (Road Damage Detection 2022 — India/Indonesia/Japan/Czech/Norway) | crack, pothole | research-only (challenge data) | strongest India-domain match; convert via `scripts/prepare_dataset.py --format rdd` |
| **Crowdsourced pothole sets** (Kaggle) | pothole | mostly CC0/CC-BY — verify per entry | small images, mobile-grade |
| **Roboflow Universe road-damage collections** | varies | per-project (many CC-BY 4.0) | filter by class coverage ≥ our 7-class mapping |
| **CrackForest / deep-crack** | crack | research | texture-heavy cracks |

`scripts/prepare_dataset.py` converts VOC XML / RDD CSV / plain YOLO layouts into the unified
schema; `scripts/validate_dataset.py` writes a JSON integrity report (missing labels, invalid
boxes, corrupt files); `scripts/class_balance.py` reports imbalance and an oversampling plan.

## Metrics contract

`evaluate.py` writes `metrics.json`:

```json
{
  "mAP50": 0.847, "mAP50_95": 0.571, "precision": 0.862, "recall": 0.794,
  "latency_ms_p50": 38, "latency_ms_p95": 41,
  "per_class": { "pothole": {"ap50": 0.91, "precision": 0.88, "recall": 0.81} }
}
```

The demo deployment registers these values (clearly labeled illustrative) as
`roadguard-yolo-v1.2.0` — see `docs/MODEL_CARD.md`.

## Inference service

`inference_service.py` mirrors the contract consumed by both backends:

- `POST /infer` (multipart image) → `{detections: [{hazardClass, class, confidence, bbox:[x,y,w,h] normalized}], model_version, inference_ms}`
- `POST /infer_video` (multipart video) → ffmpeg frame sampling → per-frame + aggregated detections
- `GET /health`
- OpenCV preprocessing (letterbox resize), ONNXRuntime fallback when `ONNX_PATH` is set,
  optional privacy blur (`?blur=true`, Haar-cascade faces + plate heuristic).

Point the production backend at it with `INFERENCE_SERVICE_URL=http://ml-inference:8100`
(docker-compose wires this automatically).

## Tests

```bash
pytest tests -q          # severity-formula parity vs. the TypeScript engine + dataset validator sanity
```
