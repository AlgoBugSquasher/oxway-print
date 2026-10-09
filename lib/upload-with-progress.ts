/**
 * Uploads a file directly to a Supabase Storage signed-upload URL (from
 * app/api/create-upload-url), with real byte-level progress — the reason
 * this is plain XHR rather than the @supabase/supabase-js SDK's own
 * `uploadToSignedUrl` (which this otherwise mirrors exactly: a PUT with a
 * FormData body carrying `cacheControl` and the file under an unnamed
 * field) is that the SDK calls `fetch` internally, and `fetch` has no
 * upload-progress event — only XHR's `upload.onprogress` does, and that's
 * broadly supported, including iOS Safari, without a new dependency.
 *
 * Deliberately not routed through lib/fetch-json.ts: this isn't a call to
 * our own API (it goes straight to Supabase Storage), and progress/XHR
 * doesn't fit that helper's fetch-based shape.
 */
export function uploadFileWithProgress(signedUrl: string, file: Blob, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append("cacheControl", "3600");
    formData.append("", file);

    const request = new XMLHttpRequest();
    request.open("PUT", signedUrl);

    if (onProgress) {
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
    }

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed (status ${request.status}).`));
      }
    };
    request.onerror = () => reject(new Error("Could not reach the upload server. Check your connection and try again."));
    request.onabort = () => reject(new Error("Upload cancelled."));

    request.send(formData);
  });
}
