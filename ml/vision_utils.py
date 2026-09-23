"""Shared computer-vision utilities for the RoadGuard Atlas ML pipeline.

Contains the geometry primitives that must stay consistent between the
PyTorch (Ultralytics) engine and the ONNXRuntime engine:

* :func:`letterbox` — Ultralytics-compatible resize + padding (color 114),
* :func:`nms` — class-aware NumPy NMS,
* :func:`decode_onnx_detections` — decode the raw ``[1, 4+nc, N]`` YOLO export
  output into ``(boxes_xyxy, scores, class_ids)``,
* :func:`iou_xyxy` — pairwise IoU,
* drawing helpers (:func:`draw_detections`, :func:`tile_grid`) used to build
  MLflow artifact previews.
"""

from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

import cv2
import numpy as np

PAD_COLOR = (114, 114, 114)
PALETTE = (
    (106, 0, 244),   # pothole       (Ultra Violet)
    (139, 61, 255),  # crack
    (180, 83, 9),    # erosion
    (14, 116, 144),  # waterlogging
    (101, 93, 115),  # marking
    (200, 62, 77),   # debris
    (22, 130, 102),  # edge_damage
)


def palette_color(class_id: int) -> Tuple[int, int, int]:
    return PALETTE[class_id % len(PALETTE)]


def letterbox(
    img: np.ndarray,
    new_shape: int = 640,
    color: Tuple[int, int, int] = PAD_COLOR,
) -> Tuple[np.ndarray, float, Tuple[float, float]]:
    """Resize image to fit ``new_shape`` with aspect ratio preserved.

    Returns the padded image, the scale factor ``s`` and the ``(dw, dh)``
    padding in pixels — exactly the geometry Ultralytics applies, so boxes
    mapped back through ``s`` and ``(dw, dh)`` align between engines.
    """
    h, w = img.shape[:2]
    r = min(new_shape / h, new_shape / w)
    new_w, new_h = int(round(w * r)), int(round(h * r))
    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    dw, dh = (new_shape - new_w) / 2.0, (new_shape - new_h) / 2.0
    top, bottom = int(round(dh - 0.1)), int(round(dh + 0.1))
    left, right = int(round(dw - 0.1)), int(round(dw + 0.1))
    out = cv2.copyMakeBorder(
        resized, top, bottom, left, right, cv2.BORDER_CONSTANT, value=color
    )
    return out, r, (dw, dh)


def scale_boxes_back(
    boxes_xyxy: np.ndarray,
    scale: float,
    pad: Tuple[float, float],
    orig_shape: Tuple[int, int],
) -> np.ndarray:
    """Map letterboxed-space xyxy boxes back to original image pixels."""
    dw, dh = pad
    out = boxes_xyxy.copy().astype(np.float64)
    out[:, [0, 2]] -= dw
    out[:, [1, 3]] -= dh
    out /= max(scale, 1e-9)
    h, w = orig_shape[:2]
    out[:, [0, 2]] = out[:, [0, 2]].clip(0, w - 1)
    out[:, [1, 3]] = out[:, [1, 3]].clip(0, h - 1)
    return out


def iou_xyxy(a: np.ndarray, b: np.ndarray) -> float:
    """IoU between two xyxy boxes (plain Python float, safe for scalars)."""
    ax1, ay1, ax2, ay2 = float(a[0]), float(a[1]), float(a[2]), float(a[3])
    bx1, by1, bx2, by2 = float(b[0]), float(b[1]), float(b[2]), float(b[3])
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return float(inter / union) if union > 0 else 0.0


def nms(
    boxes_xyxy: np.ndarray,
    scores: np.ndarray,
    class_ids: np.ndarray,
    iou_threshold: float = 0.45,
    score_threshold: float = 0.0,
    max_det: int = 300,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Greedy class-aware NMS.

    Returns filtered ``(boxes, scores, class_ids)`` sorted by score desc.
    """
    if len(boxes_xyxy) == 0:
        return boxes_xyxy, scores, class_ids

    x1, y1, x2, y2 = boxes_xyxy[:, 0], boxes_xyxy[:, 1], boxes_xyxy[:, 2], boxes_xyxy[:, 3]
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)

    order = scores.argsort()[::-1]
    keep: List[int] = []
    while order.size > 0 and len(keep) < max_det:
        i = int(order[0])
        if scores[i] < score_threshold:
            break
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        ix1 = np.maximum(x1[i], x1[rest])
        iy1 = np.maximum(y1[i], y1[rest])
        ix2 = np.minimum(x2[i], x2[rest])
        iy2 = np.minimum(y2[i], y2[rest])
        inter = np.maximum(0.0, ix2 - ix1) * np.maximum(0.0, iy2 - iy1)
        same_cls = class_ids[rest] == class_ids[i]
        union = areas[i] + areas[rest] - inter
        iou = np.where(same_cls, inter / np.maximum(union, 1e-9), 0.0)
        order = rest[iou <= iou_threshold]

    keep_arr = np.array(keep, dtype=np.int64)
    return boxes_xyxy[keep_arr], scores[keep_arr], class_ids[keep_arr]


def decode_onnx_detections(
    output: np.ndarray,
    num_classes: int,
    conf_threshold: float,
    iou_threshold: float,
    max_side: Optional[int] = None,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Decode a raw Ultralytics ONNX output into detections.

    Accepts the two layouts produced by ``yolo export format=onnx``:
    ``(1, 4+nc, N)`` (default) or transposed ``(1, N, 4+nc)``. Boxes are cx, cy,
    w, h in letterboxed pixel space; scores are per-class probabilities.
    Returns ``(boxes_xyxy, scores, class_ids)`` after class-aware NMS.
    """
    out = np.asarray(output)
    if out.ndim == 3:
        out = out[0]
    # Normalize to (4+nc, N)
    if out.shape[0] == 4 + num_classes:
        pass
    elif out.shape[-1] == 4 + num_classes:
        out = out.T
    else:
        raise ValueError(
            f"Unexpected ONNX output shape {output.shape}; expected 4+{num_classes} channels"
        )
    boxes_cxcywh = out[:4, :].T.astype(np.float64)
    class_scores = out[4 : 4 + num_classes, :].T.astype(np.float64)

    class_ids = class_scores.argmax(axis=1)
    scores = class_scores.max(axis=1)
    mask = scores > conf_threshold
    if not mask.any():
        return (
            np.zeros((0, 4), dtype=np.float64),
            np.zeros((0,), dtype=np.float64),
            np.zeros((0,), dtype=np.int64),
        )
    boxes_cxcywh, scores, class_ids = boxes_cxcywh[mask], scores[mask], class_ids[mask]

    cx, cy, bw, bh = boxes_cxcywh[:, 0], boxes_cxcywh[:, 1], boxes_cxcywh[:, 2], boxes_cxcywh[:, 3]
    boxes_xyxy = np.stack(
        [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], axis=1
    )
    if max_side is not None:
        boxes_xyxy[:, [0, 2]] = boxes_xyxy[:, [0, 2]].clip(0, max_side)
        boxes_xyxy[:, [1, 3]] = boxes_xyxy[:, [1, 3]].clip(0, max_side)
    return nms(boxes_xyxy, scores, class_ids, iou_threshold=iou_threshold)


def boxes_to_normalized_xywh(
    boxes_xyxy: np.ndarray,
    orig_shape: Tuple[int, int],
) -> np.ndarray:
    """Convert pixel xyxy boxes to normalized x,y,w,h (top-left origin)."""
    h, w = orig_shape[:2]
    out = np.zeros((len(boxes_xyxy), 4), dtype=np.float64)
    if len(boxes_xyxy) == 0:
        return out
    out[:, 0] = boxes_xyxy[:, 0] / w
    out[:, 1] = boxes_xyxy[:, 1] / h
    out[:, 2] = (boxes_xyxy[:, 2] - boxes_xyxy[:, 0]) / w
    out[:, 3] = (boxes_xyxy[:, 3] - boxes_xyxy[:, 1]) / h
    return out


def draw_detections(
    img: np.ndarray,
    boxes_xyxy: np.ndarray,
    class_ids: Sequence[int],
    scores: Sequence[float],
    class_names: Sequence[str],
) -> np.ndarray:
    """Draw detection boxes + labels on a BGR image (returns a copy)."""
    out = img.copy()
    for box, cls_id, score in zip(boxes_xyxy, class_ids, scores):
        cls_id = int(cls_id)
        color = palette_color(cls_id)
        x1, y1, x2, y2 = [int(round(v)) for v in box]
        cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
        name = class_names[cls_id] if 0 <= cls_id < len(class_names) else str(cls_id)
        label = f"{name} {float(score):.2f}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        y1 = max(y1, th + 4)
        cv2.rectangle(out, (x1, y1 - th - 4), (x1 + tw + 4, y1), color, -1)
        cv2.putText(
            out, label, (x1 + 2, y1 - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
            (255, 255, 255), 1, cv2.LINE_AA,
        )
    return out


def tile_grid(images: Sequence[np.ndarray], cols: int, pad: int = 8) -> np.ndarray:
    """Tile BGR images into a grid canvas with ``pad`` spacing (white bg)."""
    if not images:
        return np.full((64, 64, 3), 255, dtype=np.uint8)
    h = max(im.shape[0] for im in images)
    w = max(im.shape[1] for im in images)
    rows = int(math_ceil(len(images) / cols))
    canvas = np.full((rows * h + (rows + 1) * pad, cols * w + (cols + 1) * pad, 3), 255, dtype=np.uint8)
    for idx, im in enumerate(images):
        r, c = divmod(idx, cols)
        y = pad + r * (h + pad)
        x = pad + c * (w + pad)
        canvas[y : y + im.shape[0], x : x + im.shape[1]] = im
    return canvas


def math_ceil(x: float) -> int:
    import math

    return math.ceil(x)


__all__ = [
    "PAD_COLOR",
    "letterbox",
    "scale_boxes_back",
    "iou_xyxy",
    "nms",
    "decode_onnx_detections",
    "boxes_to_normalized_xywh",
    "draw_detections",
    "tile_grid",
    "palette_color",
]
