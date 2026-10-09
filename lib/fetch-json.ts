/**
 * ROADMAP.md #19 — every frontend call site was doing `await response.json()`
 * with no guard against the server ever returning something that isn't
 * valid JSON (a platform-level timeout page, a crash before our own route
 * handler's try/catch could even respond). That surfaces as a raw
 * "Unexpected end of JSON input"-style error straight to the customer
 * instead of a readable message — this wraps fetch so every call site gets
 * the same defensive handling instead of repeating it three different ways.
 */
export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A 413 (Payload Too Large) never reaches our own route handlers at
    // all — the platform itself rejects the request before any of our
    // code runs, so there's no JSON error body to parse, just this
    // generic failure. Worth a specific, readable message rather than
    // the raw status-code fallback below: it's also the one case where
    // this used to be a real possibility for a large file upload (see
    // app/api/create-upload-url/route.ts's own docstring) before uploads
    // moved to going directly to Supabase Storage.
    if (response.status === 413) {
      throw new Error("File is too large or the upload failed, please try again.");
    }
    throw new Error(
      response.ok
        ? "The server sent back something unexpected. Please try again."
        : `The server returned an error (status ${response.status}) without a readable message. Please try again.`
    );
  }

  if (!response.ok) {
    throw new Error(isErrorBody(body) ? body.error : `Request failed (status ${response.status}).`);
  }

  return body as T;
}

function isErrorBody(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value && typeof (value as { error: unknown }).error === "string";
}
