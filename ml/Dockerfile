# RoadGuard Atlas — ML inference service image.
# Build from the ml/ directory:  docker build -t roadguard-ml -f ml/Dockerfile ml/
#
# python:3.11-slim + libgl1/libglib2.0 (OpenCV runtime) + ffmpeg (video sampling).
# CPU-only torch keeps the image reasonable; swap the torch index for CUDA if needed.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DEVICE=cpu \
    CONF_THRESHOLD=0.25 \
    IOU_NMS=0.45 \
    IMG_SIZE=640 \
    MODEL_PATH=/app/models/best.pt

# libgl1 + libglib2.0-0: OpenCV runtime deps. ffmpeg: frame sampling for /infer_video.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Torch first (CPU index) so pip doesn't pull the CUDA wheel.
COPY requirements.txt /app/requirements.txt
RUN pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu \
    && pip install -r requirements.txt

# Application code.
COPY hazard_domain.py vision_utils.py mlflow_utils.py inference_service.py /app/

# Application code + models baked in.
# NOTE: `models/` is gitignored — train first (`make train`) or mount the dir at
# runtime instead: docker run -v $PWD/ml/models:/app/models roadguard-ml
# (if you have no weights yet, comment the next line out and set MODEL_PATH/ONNX_PATH).
COPY models /app/models

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
    CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["python3", "inference_service.py", "--host", "0.0.0.0", "--port", "8000"]
