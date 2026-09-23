"""RoadGuard Atlas API — FastAPI application factory.

Path convention: routes are mounted WITHOUT an `/api` prefix (documented choice,
AGENT_BRIEF §4). The live Next.js app serves its own /api/*; in production the
gateway (Caddy/nginx) or docker-compose maps this service at the API root. To
serve it under /api directly, front it with a proxy or set
`uvicorn --root-path /api` and adjust the gateway.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.config import settings
from app.routers import (
    admin,
    analytics,
    auth,
    clusters,
    export,
    hazards,
    inference,
    map as map_router,
    ops,
    reports,
    uploads,
    users,
    work_orders,
)
from app.services.ratelimit import limiter

logger = logging.getLogger("roadguard")

OPENAPI_TAGS = [
    {"name": "auth", "description": "Registration, login, JWT refresh rotation, logout, password reset."},
    {"name": "users", "description": "Profile and in-app notifications."},
    {"name": "reports", "description": "Citizen hazard submission (rate-limited) and own reports."},
    {"name": "hazards", "description": "Public hazard feed, detail, admin review workflow, priority explanation."},
    {"name": "map", "description": "GeoJSON-ready map payload (hazards + clusters)."},
    {"name": "clusters", "description": "DBSCAN hazard clusters and admin recomputation."},
    {"name": "work-orders", "description": "Maintenance pipeline kanban (admin writes)."},
    {"name": "analytics", "description": "Aggregate dashboard analytics (admin)."},
    {"name": "uploads", "description": "Validated media upload (EXIF stripped) and streaming."},
    {"name": "inference", "description": "Detection engine chain (image sync / video async)."},
    {"name": "admin", "description": "KPIs, audit trail, system settings, model versions."},
    {"name": "export", "description": "CSV / GeoJSON exports (admin)."},
    {"name": "ops", "description": "Health and Prometheus metrics."},
]


def _install_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(RateLimitExceeded)
    async def ratelimit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
        return JSONResponse(
            status_code=429,
            content={"error": "Rate limit exceeded", "detail": f"Retry later ({exc.detail})"},
            headers={"Retry-After": "60"},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        field = ".".join(str(p) for p in first.get("loc", [])[1:]) or "body"
        return JSONResponse(
            status_code=422,
            content={"error": f"Invalid request: {field}", "detail": str(first.get("msg", "validation failed"))},
        )

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
        headers = getattr(exc, "headers", None)
        detail = exc.detail
        if isinstance(detail, dict):
            content = detail
        else:
            content = {"error": str(detail or "Request failed")}
        return JSONResponse(status_code=exc.status_code, content=content, headers=headers)


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logger.info("RoadGuard Atlas API %s starting (env=%s)", settings.APP_VERSION, settings.ENV)
        yield
        logger.info("RoadGuard Atlas API shutting down")

    app = FastAPI(
        title=settings.APP_NAME,
        version=settings.APP_VERSION,
        description=(
            "RoadGuard Atlas — road-hazard detection (vision), geospatial clustering (DBSCAN) and "
            "explainable maintenance prioritization.\n\n"
            "**Engines.** Priority `0.32·sev + 0.24·density + 0.18·criticality + 0.14·recurrence + 0.12·age` "
            "→ 0–100 with bands CRITICAL ≥80 / HIGH ≥60 / MEDIUM ≥35 / LOW. Severity = operational heuristic "
            "1–5 from confidence, bbox area and hazard class. Clustering = DBSCAN (Haversine, eps 60 m, minPts 3).\n\n"
            "**Auth.** JWT HS256 — access 15 min, refresh 30 d rotate-on-use, bcrypt cost 10. "
            "RBAC: admin-only = review, clusters/recompute, work-orders write, admin/*, export."
        ),
        openapi_tags=OPENAPI_TAGS,
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
        separate_input_output_schemas=True,
    )

    app.state.limiter = limiter
    app.add_middleware(SlowAPIMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    _install_exception_handlers(app)

    for router in (
        ops.router,
        auth.router,
        users.router,
        reports.router,
        hazards.router,
        map_router.router,
        clusters.router,
        work_orders.router,
        analytics.router,
        uploads.router,
        inference.router,
        admin.router,
        export.router,
    ):
        app.include_router(router)

    return app


app = create_app()
