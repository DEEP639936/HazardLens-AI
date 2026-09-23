// Typed API client — same-origin fetch with cookie auth, JSON helpers and error normalization.
export class ApiError extends Error {
  status: number;
  detail?: string;
  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export async function api<T>(path: string, opts: { json?: unknown; method?: string; headers?: Record<string, string> } = {}): Promise<T> {
  const init: RequestInit = {
    method: opts.method ?? (opts.json !== undefined ? "POST" : "GET"),
    credentials: "include",
    headers: {
      ...(opts.json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
  };
  const res = await fetch(path, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body ?? {}) as { error?: string; detail?: string };
    throw new ApiError(res.status, err.error ?? `Request failed (${res.status})`, err.detail);
  }
  return body as T;
}

export async function uploadFile(file: File, geoConsent: boolean): Promise<{
  mediaId: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  suggestedLocation: { lat: number; lng: number } | null;
  note: string;
}> {
  const form = new FormData();
  form.append("file", file);
  form.append("geoConsent", String(geoConsent));
  const res = await fetch("/api/uploads", { method: "POST", credentials: "include", body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? "Upload failed", (body as { detail?: string }).detail);
  return body as never;
}

export function mediaUrl(id: string): string {
  return `/api/media/${id}`;
}
