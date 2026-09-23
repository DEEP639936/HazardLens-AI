// /api/openapi.json — polished OpenAPI 3.1 description of the HazardLensAI API.
// Rendered with Swagger UI inside the in-app Documentation page; the production FastAPI
// service exposes its own interactive /docs (same schema, see backend/).
import { NextResponse } from "next/server";
import { HAZARD_CLASSES, WO_STATUSES } from "@/lib/rg/constants";

export const runtime = "nodejs";

const hazardExample = {
  referenceCode: "HL-7K2M4P",
  hazardClass: "pothole",
  severity: 4,
  status: "VERIFIED",
  lat: 12.9172,
  lng: 77.6229,
  ward: "BTM Layout",
  roadName: "Hosur Road",
  detections: [
    { hazardClass: "pothole", confidence: 0.91, bbox: [0.31, 0.42, 0.22, 0.15], severity: 4, engine: "glm-vision" },
  ],
  priority: { score: 78.4, band: "HIGH" },
};

export function GET() {
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "HazardLensAI API",
      version: "1.0.0",
      description:
        "Road hazard detection (vision), geospatial clustering and maintenance prioritization. " +
        "Authentication: JWT bearer tokens (also issued as httpOnly cookies). Admin endpoints require the ADMIN role.",
      contact: { name: "HazardLensAI", url: "/#/docs" },
      license: { name: "MIT" },
    },
    servers: [{ url: "/", description: "Current deployment" }],
    tags: [
      { name: "auth" }, { name: "users" }, { name: "reports" }, { name: "hazards" },
      { name: "map" }, { name: "clusters" }, { name: "work-orders" }, { name: "analytics" },
      { name: "uploads" }, { name: "inference" }, { name: "admin" }, { name: "export" }, { name: "ops" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        cookieAuth: { type: "apiKey", in: "cookie", name: "rg_access" },
      },
      schemas: {
        Hazard: {
          type: "object",
          properties: {
            referenceCode: { type: "string", example: "HL-7K2M4P" },
            hazardClass: { type: "string", enum: HAZARD_CLASSES },
            severity: { type: "integer", minimum: 1, maximum: 5 },
            status: { type: "string", enum: ["REPORTED", "AI_VERIFIED", "PENDING_REVIEW", "VERIFIED", "ASSIGNED", "IN_PROGRESS", "RESOLVED", "CLOSED", "REJECTED", "MERGED", "FLAGGED"] },
            lat: { type: "number" },
            lng: { type: "number" },
            priority: {
              type: "object",
              properties: {
                score: { type: "number", example: 78.4 },
                band: { type: "string", enum: ["CRITICAL", "HIGH", "MODERATE", "LOW"] },
              },
            },
          },
        },
        Detection: {
          type: "object",
          properties: {
            hazardClass: { type: "string", enum: HAZARD_CLASSES },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            bbox: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "x, y, w, h normalized to 0..1" },
            severity: { type: "integer", minimum: 1, maximum: 5 },
          },
        },
        WorkOrderStatus: { type: "string", enum: WO_STATUSES },
      },
    },
    paths: {
      "/api/auth/register": { post: { tags: ["auth"], summary: "Create a citizen account", responses: { "201": { description: "Registered" }, "409": { description: "Email exists" } } } },
      "/api/auth/login": { post: { tags: ["auth"], summary: "Sign in (JWT access + refresh)", responses: { "200": { description: "Session established" }, "401": { description: "Invalid credentials" } } } },
      "/api/auth/refresh": { post: { tags: ["auth"], summary: "Rotate refresh token", responses: { "200": { description: "New session" }, "401": { description: "Invalid refresh token" } } } },
      "/api/auth/logout": { post: { tags: ["auth"], summary: "Revoke session", responses: { "200": { description: "Signed out" } } } },
      "/api/auth/me": { get: { tags: ["auth"], summary: "Current session user", responses: { "200": { description: "User or null" } } } },
      "/api/auth/forgot-password": { post: { tags: ["auth"], summary: "Issue password reset token", responses: { "200": { description: "Always ok (no account enumeration)" } } } },
      "/api/auth/reset-password": { post: { tags: ["auth"], summary: "Complete password reset", responses: { "200": { description: "Password updated" } } } },
      "/api/users/me": {
        get: { tags: ["users"], summary: "Profile", security: [{ cookieAuth: [] }], responses: { "200": { description: "Profile" }, "401": { description: "Unauthenticated" } } },
        patch: { tags: ["users"], summary: "Update profile & privacy settings", security: [{ cookieAuth: [] }], responses: { "200": { description: "Updated" } } },
      },
      "/api/users/me/notifications": {
        get: { tags: ["users"], summary: "Notification center", security: [{ cookieAuth: [] }], responses: { "200": { description: "Items + unread count" } } },
        post: { tags: ["users"], summary: "Mark read / read-all", security: [{ cookieAuth: [] }], responses: { "200": { description: "Ok" } } },
      },
      "/api/reports": {
        get: { tags: ["reports"], summary: "List own reports (admin: all)", security: [{ cookieAuth: [] }], responses: { "200": { description: "Reports" } } },
        post: {
          tags: ["reports"],
          summary: "Submit a hazard report (public, rate-limited 5/hour/IP)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                example: {
                  mediaIds: ["cuid-of-uploaded-media"],
                  detectionIds: ["cuid-of-detection"],
                  hazardClass: "pothole",
                  lat: 12.9172,
                  lng: 77.6229,
                  notes: "Deep pothole near bus stop, two-wheelers swerve into traffic.",
                  geoConsent: true,
                  ward: "BTM Layout",
                  roadName: "Hosur Road",
                },
              },
            },
          },
          responses: {
            "201": { description: "Created", content: { "application/json": { example: { report: hazardExample } } } },
            "400": { description: "Validation error" },
            "429": { description: "Rate limited" },
          },
        },
      },
      "/api/reports/{id}": { get: { tags: ["reports"], summary: "Report detail (owner/admin)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Report" }, "403": { description: "Forbidden" } } } },
      "/api/hazards": {
        get: {
          tags: ["hazards"],
          summary: "Public filterable hazard feed",
          parameters: [
            { name: "classes", in: "query", schema: { type: "string" }, example: "pothole,crack", description: "comma-separated hazard classes" },
            { name: "severityMin", in: "query", schema: { type: "integer", minimum: 1, maximum: 5 } },
            { name: "severityMax", in: "query", schema: { type: "integer", minimum: 1, maximum: 5 } },
            { name: "statuses", in: "query", schema: { type: "string" }, example: "PENDING_REVIEW,VERIFIED" },
            { name: "bands", in: "query", schema: { type: "string" }, example: "CRITICAL,HIGH" },
            { name: "from", in: "query", schema: { type: "string", format: "date" } },
            { name: "to", in: "query", schema: { type: "string", format: "date" } },
            { name: "bbox", in: "query", schema: { type: "string" }, example: "77.55,12.90,77.70,13.05", description: "minLng,minLat,maxLng,maxLat" },
            { name: "q", in: "query", schema: { type: "string" }, description: "free text over reference/ward/address/road" },
            { name: "limit", in: "query", schema: { type: "integer", default: 300, maximum: 1000 } },
          ],
          responses: { "200": { description: "Hazards + count" } },
        },
      },
      "/api/hazards/{id}": { get: { tags: ["hazards"], summary: "Hazard detail", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Hazard" }, "404": { description: "Not found" } } } },
      "/api/hazards/{id}/review": {
        post: {
          tags: ["hazards"],
          summary: "Moderate a hazard (admin): approve | reject | flag | merge",
          security: [{ bearerAuth: [] }, { cookieAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            content: {
              "application/json": {
                example: {
                  action: "approve",
                  note: "Confirmed on site inspection.",
                  edits: { severity: 4, roadClass: "arterial" },
                  manualScore: 82,
                },
              },
            },
          },
          responses: { "200": { description: "Updated hazard" }, "403": { description: "Admin required" } },
        },
      },
      "/api/hazards/{id}/priority-explanation": {
        get: {
          tags: ["hazards"],
          summary: "Explain-this-priority breakdown (transparent factors + contributions)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Factor breakdown with formula and disclaimer" } },
        },
      },
      "/api/map": { get: { tags: ["map"], summary: "Hazards + clusters for interactive map", responses: { "200": { description: "MapResponse" } } } },
      "/api/clusters": { get: { tags: ["clusters"], summary: "List clusters", responses: { "200": { description: "Clusters" } } } },
      "/api/clusters/recompute": {
        post: {
          tags: ["clusters"],
          summary: "Re-run DBSCAN (admin) for configurable area/time",
          security: [{ bearerAuth: [] }, { cookieAuth: [] }],
          requestBody: { content: { "application/json": { example: { epsM: 60, minPts: 3, sinceDays: 90, bbox: [77.55, 12.9, 77.75, 13.05] } } } },
          responses: { "200": { description: "Recompute summary" } },
        },
      },
      "/api/work-orders": {
        get: { tags: ["work-orders"], summary: "Board (auth)", security: [{ cookieAuth: [] }], responses: { "200": { description: "Work orders" } } },
        post: { tags: ["work-orders"], summary: "Open work order (admin)", security: [{ bearerAuth: [] }], responses: { "201": { description: "Created" } } },
      },
      "/api/work-orders/{id}": {
        get: { tags: ["work-orders"], summary: "Detail", security: [{ cookieAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Work order" } } },
        patch: { tags: ["work-orders"], summary: "Transition status (admin)", security: [{ bearerAuth: [] }], requestBody: { content: { "application/json": { example: { status: "IN_REPAIR", note: "Crew dispatched, lane closed 10:00-13:00." } } } }, responses: { "200": { description: "Updated" } } },
      },
      "/api/work-orders/{id}/evidence": {
        post: { tags: ["work-orders"], summary: "Attach before/after repair evidence (assigned field worker)", security: [{ bearerAuth: [] }], requestBody: { content: { "application/json": { example: { beforeMediaId: "m_1", afterMediaId: "m_2", resolutionNotes: "Patched with hot mix, compacted and reopened." } } } }, responses: { "200": { description: "Order auto-advances to VERIFICATION_PENDING" } } },
      },
      "/api/work-orders/{id}/verify": {
        post: { tags: ["work-orders"], summary: "Resolution verification — ADMIN only (approve → VERIFIED, reject+reason → IN_PROGRESS rework)", security: [{ bearerAuth: [] }], requestBody: { content: { "application/json": { example: { decision: "approve" } } } }, responses: { "200": { description: "Verification recorded, reporter notified, audit-logged" }, "403": { description: "Only the main administrator may verify resolutions" } } },
      },
      "/api/analytics": { get: { tags: ["analytics"], summary: "Dashboard analytics aggregate (admin)", security: [{ bearerAuth: [] }], responses: { "200": { description: "AnalyticsDTO" } } } },
      "/api/uploads": {
        post: {
          tags: ["uploads"],
          summary: "Upload media (multipart; images ≤12MB jpg/png, video ≤60MB mp4/webm/mov; EXIF GPS only with consent; metadata stripped)",
          requestBody: { content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" }, geoConsent: { type: "string", example: "true" } } } } } },
          responses: { "201": { description: "mediaId + optional EXIF-suggested location" }, "415": { description: "Unsupported or unverifiable media" }, "429": { description: "Rate limited" } },
        },
      },
      "/api/media/{id}": { get: { tags: ["uploads"], summary: "Stream media asset", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Bytes" } } } },
      "/api/inference": {
        post: {
          tags: ["inference"],
          summary: "Run detection engine chain on uploaded media (images sync; video → async job 202)",
          requestBody: { content: { "application/json": { example: { mediaId: "cuid" } } } },
          responses: {
            "200": { description: "Detections", content: { "application/json": { example: { engine: "glm-vision", modelVersion: "glm-4.5v", inferenceMs: 2310, detections: [{ hazardClass: "pothole", confidence: 0.91, bbox: [0.31, 0.42, 0.22, 0.15], severity: 4 }] } } } },
            "202": { description: "Video job accepted" },
          },
        },
      },
      "/api/inference/jobs/{id}": { get: { tags: ["inference"], summary: "Poll video job", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Job status + result" } } } },
      "/api/admin/overview": { get: { tags: ["admin"], summary: "KPI overview (admin)", security: [{ bearerAuth: [] }], responses: { "200": { description: "KPIs" } } } },
      "/api/admin/audit-logs": { get: { tags: ["admin"], summary: "Audit trail (admin)", security: [{ bearerAuth: [] }], responses: { "200": { description: "Audit entries" } } } },
      "/api/admin/settings": {
        get: { tags: ["admin"], summary: "System settings (admin)", security: [{ bearerAuth: [] }], responses: { "200": { description: "Settings" } } },
        put: { tags: ["admin"], summary: "Update priority weights / clustering params (weights must sum to 1)", security: [{ bearerAuth: [] }], responses: { "200": { description: "Updated" }, "400": { description: "Invalid weights" } } },
      },
      "/api/admin/model-versions": {
        get: { tags: ["admin"], summary: "Model registry", security: [{ bearerAuth: [] }], responses: { "200": { description: "Versions" } } },
        post: { tags: ["admin"], summary: "Register model version (MLflow metadata)", security: [{ bearerAuth: [] }], responses: { "201": { description: "Registered" } } },
      },
      "/api/export/hazards.csv": { get: { tags: ["export"], summary: "CSV export (admin)", security: [{ bearerAuth: [] }], responses: { "200": { description: "text/csv" } } } },
      "/api/export/hazards.geojson": { get: { tags: ["export"], summary: "GeoJSON export (admin)", security: [{ bearerAuth: [] }], responses: { "200": { description: "application/geo+json" } } } },
      "/api/health": { get: { tags: ["ops"], summary: "Liveness + dependency checks", responses: { "200": { description: "Health" } } } },
      "/api/metrics": { get: { tags: ["ops"], summary: "Prometheus metrics", responses: { "200": { description: "text/plain metrics" } } } },
      "/api/geocode": { get: { tags: ["ops"], summary: "Nominatim geocoding proxy (?q= or ?lat=&lng=)", responses: { "200": { description: "Results / address" } } } },
    },
  };
  return NextResponse.json(spec, { headers: { "Cache-Control": "public, max-age=300" } });
}
