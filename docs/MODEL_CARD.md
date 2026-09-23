# HazardLensAI — Model Card

**Hazard detection model: `roadguard-yolo-v1.2.0`** (YOLOv8s baseline, Ultralytics framework)
Companion documents: [SYSTEM_CARD.md](SYSTEM_CARD.md) (deployment), [FINAL_REPORT.md](FINAL_REPORT.md) (evaluation protocol), [ADMIN_GUIDE.md](ADMIN_GUIDE.md) (reviewer overrides).

This card follows the model-card convention: it documents the model's details, training data provenance and licenses, intended use and explicit out-of-scope uses, measured performance, known biases, characteristic failure modes, and the maintenance plan that governs retraining and versioning.

> **Transparency note on the registered metrics.** The values in §6 (mAP@50 0.847, mAP@50-95 0.571, precision 0.862, recall 0.794, latency 41 ms) are **illustrative demo-registry values** seeded into the live demo's `model_versions` table (version `roadguard-yolo-v1.2.0`, MLflow run `d41f0a2c7c1943b8ab52e91d0c3a7f11`) so the full governance workflow can be demonstrated end-to-end. Real production metrics are produced exclusively by the `ml/` training pipeline (train → evaluate → export-onnx → register) and must be re-measured per deployment city before any operational reliance.

---

## 1. Model Details

| Property | Value |
|---|---|
| Architecture | YOLOv8s (single-stage detector, Ultralytics) |
| Task | Object detection + 7-class classification of road-surface hazards from citizen photos and video frames |
| Classes | `pothole` · `crack` · `erosion` · `waterlogging` · `marking` (broken road marking) · `debris` · `edge_damage` (road-edge damage) |
| Output | Normalized bounding boxes `[x, y, w, h]` ∈ [0,1], per-class confidence ∈ [0,1], class label; `area_ratio` derived from the box; operational severity 1–5 derived by the platform heuristic (§2) |
| Serving | Dedicated `yolo-service` container (GPU in production; ONNX export path for CPU edge nodes) |
| Engine chain (fallbacks) | 1) **yolo-service** (primary, when `YOLO_SERVICE_URL` configured) → 2) **glm-vision** (GLM-4.5V multimodal call, backend-only key, zero-shot label/bbox extraction) → 3) **demo-engine-v2** (deterministic heuristic engine so the demo never hard-fails). The engine actually used is stored on every detection row (`engine` field) and surfaced in the AI preview |
| Latency (demo registry) | 41 ms per image (YOLO path); video is processed as sampled frames (ffmpeg) via async job |
| Input constraints | Images JPEG/PNG/WebP ≤ 12 MB; video MP4/WebM/MOV ≤ 60 MB; EXIF stripped before inference |

### 2. Severity heuristic (downstream of the detector)

The detector produces confidence + box extent; the platform converts these into an operational 1–5 severity using a **transparent, documented heuristic** (not a learned head):

```
score100 = 100 × (0.45·confidence + 0.35·min(areaRatio/0.25, 1) + 0.20·classWeight)
severity = clamp( ceil(score100 / 20) + duplicateBoost, 1, 5 ),  duplicateBoost = 0.125 × min(duplicates, 4)  (≤ +0.5)
classWeight: waterlogging 0.70 · pothole 0.62 · edge_damage 0.60 · erosion 0.55 · debris 0.50 · crack 0.45 · marking 0.40
```

Design intent: heavier classes (standing water, potholes) reach higher severities at equal visual evidence; duplicate citizen reports of the same defect within 75 m nudge severity upward (community corroboration). Reviewers can always override severity manually — the heuristic is an operational aid, not ground truth.

## 3. Training Data

| Source | Content | License / terms | Use tier |
|---|---|---|---|
| RDD2022 (Road Damage Detection 2022, shared task dataset) | ~47k annotated road-damage images from India, Japan, Norway, US; phone/drone captures | Published for the CRDDC/RDD2022 challenge for **research purposes**; redistribution and commercial use restricted — consult the dataset's own license text before any commercial deployment | Research |
| Crowdsourced pothole datasets (public municipal/github compilations, e.g. pothole image collections from civic-tech releases) | Pothole close-ups, varied cameras, weak labels cleaned manually | Mixed — predominantly CC-BY / CC0; each compilation verified individually at ingest; attribution list maintained in `ml/datasets/ATTRIBUTION.md` | Research (CC-BY subsets commercial-usable with attribution) |
| Roboflow Universe road-hazard sets (multiple community projects: potholes, cracks, waterlogging) | Augmented exports (YOLO format), pre-split train/valid/test | Per-project Roboflow license — mixture of **CC BY 4.0** and **Roboflow research-only**; only explicitly commercial-allowed projects are tagged for production use | Mixed — research vs commercial decided per project |
| In-project collection (demo capture, `sample-data/`) | Bengaluru street scenes, re-encoded (EXIF stripped), used for demo evidence, not for baseline training weights | Project-owned | Commercial (project-owned) |

**Data governance notes.** (1) The demo registry's `dataset_ref` is `huggingface:roadguard/road-hazards-in+RDD2022 (see MODEL_CARD.md)` — i.e., the curated India-focused blend of the above. (2) License tiering is deliberate: **the default artifact is research-grade**; a commercial deployment requires a license audit that swaps research-only sources for cleared ones and retrains. (3) All faces/plates incidentally captured in project-collected images are blurred at ingest (`blurRequested` supported end-to-end).

## 4. Intended Use and Out-of-Scope Use

**Intended use.** A **maintenance-prioritization aid**: triage citizen evidence, suggest class/severity, cluster geographically, and rank repair candidates on an explainable 0–100 scale for human moderators and municipal crews. The model's outputs always flow through human review before any work order is created from them; the priority formula is fully explainable factor-by-factor in the UI (`/api/hazards/{id}/priority-explanation`).

**Explicitly OUT of scope:**

1. **Safety-critical engineering decisions.** The severity score is an operational heuristic from image evidence only — it is not a structural assessment and must never replace an engineer's inspection for load-bearing or design decisions.
2. **Accident attribution or litigation.** Detection records are not a forensic record of road state at any past moment; they must not be used to assign fault in accidents.
3. **Punitive ward ranking.** Aggregating hazards to rank wards/officials punitively distorts reporting incentives (reporting density ≠ road quality). Analytics views are designed for resource allocation, not blame.
4. **Autonomous dispatch.** No work order may be auto-executed without moderator approval; the system is human-in-the-loop by design.
5. **Any use beyond road-surface maintenance** (e.g., surveillance of individuals, property assessment) — the media pipeline strips identifying metadata and is purpose-limited.

## 5. Evaluation Protocol (how real numbers are produced)

Real evaluation runs in `ml/`: fixed test split held out **by corridor, not by random frame** (prevents near-duplicate leakage of the same pothole across splits); confidence threshold 0.25; per-class AP reported alongside means; latency measured p50 on the production GPU container with batch size 1. The demo registry row exists so the admin model-registry UI, seed narrative, and this card are consistent — it is labeled `notes: "Registered from MLflow run (demo values)."`.

## 6. Evaluation Metrics (illustrative demo-registry values)

**Model version:** `roadguard-yolo-v1.2.0` · framework `pytorch-ultralytics` · weights ref `ml/runs/detect/v1.2.0/weights/best.pt` · MLflow run `d41f0a2c7c1943b8ab52e91d0c3a7f11` · dataset ref `huggingface:roadguard/road-hazards-in+RDD2022`.

| Metric | Value | Notes |
|---|---|---|
| mAP@50 | **0.847** | IoU 0.5, all 7 classes |
| mAP@50–95 | **0.571** | Box-quality sensitive; gap vs mAP@50 indicates looser localization on irregular hazards (erosion, waterlogging edges) |
| Precision | **0.862** | At demo operating threshold 0.25 |
| Recall | **0.794** | Moderators recover missed hazards via citizen text + map context; recall matters less than precision in a human-in-the-loop loop |
| Latency | **41 ms** | Single image, demo container; excludes upload/network |
| Inference time observed in seed | 38–68 ms | `detections.inference_ms` across the 31 seeded reports |

*These are illustrative demo-registry values (see transparency note). They are internally consistent with the seeded scenario (e.g., 19/31 seeded reports approved, confidence range 0.55–0.93) but are not a claim about a specific production training run.*

**Per-class note.** Aggregate mAP hides the expected spread: large, high-contrast targets (potholes, waterlogging) score highest; thin/faint targets (cracks, faded markings) score lowest and drive the mAP@50–95 gap. The heuristic severity formula compensates by class weight, and reviewers correct residual class errors — both are visible in the review UI.

## 7. Bias, Fairness and Failure Modes

### 7.1 Bias and fairness limitations

- **Image-condition bias.** Training imagery over-represents daytime, dry-weather, handheld-phone captures. Detection quality degrades for night flashes, monsoonal spray, and unusual camera mounts — precisely monsoon-night conditions where hazards are most dangerous.
- **Reporting-density bias.** The platform maps **reports**, not road quality. Affluent, high-smartphone-density corridors generate more reports; quiet wards are under-observed. Priority is computed per hazard, but the *map* can still look "worse" where more people report. Mitigations: per-ward normalization in analytics is flagged, ward ranking is explicitly out of scope, and crew planning should treat silence as missing data, not evidence of good roads.
- **Geographic skew.** RDD2022's India imagery dominates the blend; transfer to other cities (different lane markings, road furniture, vegetation) requires local fine-tuning — new-city onboarding is a formal retrain trigger (§8).
- **Severity heuristic bias.** Area-based severity favors large defects; long thin hazards (edge drops) can look "small" in area ratio. The class-weight term and reviewer overrides are the compensating controls.

### 7.2 Characteristic failure cases (observed categories, with moderator guidance)

| Failure mode | Typical appearance | What reviewers should check |
|---|---|---|
| Night / rain / motion blur | Noisy boxes, low confidence (0.55–0.65 band in the seed's rejected/flagged examples) | Reject when unconfirmable; request re-upload (seeded example: out-of-focus Yeshwanthpur crack, rejected) |
| Shooting angle extremes | Oblique dashcam frames shrink apparent area → severity underestimated | Adjust severity manually; area ratio is only a heuristic input |
| Waterlogging vs shadow confusion | Dark wet asphalt vs deep shadow at underpasses | Confirm standing water cues (reflections, debris line, bus stoppage notes) |
| Faded markings vs occlusion | Paint worn through vs temporarily covered by leaves/queueing traffic | Check multiple frames/time-of-day; occlusion is not a marking defect |
| Patched trench vs pothole | Utility reinstatements read as pothole texture | Seeded example: Banashankari report rejected as "patched utility trench, not a hazard" |
| Storm drains vs road flooding | Water over a drain grate misread as waterlogging | Seeded FLAGGED example on 27th Main Road — kept for manual inspection |

## 8. Maintenance Plan

**Retrain triggers (any one suffices):**

1. **Confidence-distribution drift.** Weekly job compares the live distribution of `detections.confidence` and per-class mix against the training baseline (PSI > 0.2 or per-class share shift > 30% relative opens an investigation ticket).
2. **New city onboarding.** A new city's ward atlas, road-class conventions, and ≥ 500 locally-collected labeled frames trigger a fine-tune before the city goes live.
3. **Quarterly evaluation.** Scheduled re-run of the corridor-held-out test set; regression > 2 points mAP@50 blocks promotion.

**Review-driven active learning.** Every moderator correction (class edit, severity edit, rejection reason) is stored on the report; corrected reports are mined quarterly into the next training set — the human-in-the-loop queue is the labeling pipeline.

**Versioning and governance:**

- Every training run logs params, metrics, and artifacts to **MLflow**; promotion to staging/production happens in the **MLflow model registry**.
- The platform-side registry (`admin/model-versions`, table `model_versions`) records version, framework, weights ref, metrics, dataset ref, MLflow run id, and notes; only admins can write it, and the active version is what `detections.model_version` stamps.
- Rollback = re-activating the previous version in the registry (weights retained in MLflow/MinIO, never overwritten) — see [SYSTEM_CARD.md](SYSTEM_CARD.md) §7.
- A version may not be promoted without: evaluation report, license audit pass (§3), and a failure-case review against §7.2.
