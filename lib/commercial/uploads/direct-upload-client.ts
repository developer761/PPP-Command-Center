/**
 * R6b — client-side direct-to-Storage upload transport (browser only).
 *
 * Uploads a file straight to Supabase Storage using a one-time signed URL, so
 * the bytes never pass through Vercel (whose serverless body cap is ~4.5 MB).
 * Flow: POST /documents/sign → PUT to Storage (real % via XHR) → POST
 * /documents/finalize. Returns a handle with a promise + a cancel() that aborts
 * the in-flight PUT.
 *
 * The signed-upload request shape (URL, FormData body, headers) mirrors
 * @supabase/storage-js `uploadToSignedUrl` exactly — hand-rolled with XHR only
 * to get the upload-progress events the SDK's fetch path doesn't expose.
 *
 * NOT server-only: this is imported by client components. It intentionally
 * avoids importing any `server-only` lib (bucket/limit constants are mirrored
 * on the caller side).
 */

export type DirectUploadResult =
  | { ok: true; document: unknown }
  | { ok: false; error: string; canceled?: boolean };

export type DirectUploadHandle = {
  promise: Promise<DirectUploadResult>;
  cancel: () => void;
};

export function directUploadDocument(opts: {
  parentType: "opportunity" | "project";
  parentId: string;
  file: File;
  category: string;
  notes?: string | null;
  onProgress?: (fraction: number) => void;
}): DirectUploadHandle {
  const base =
    opts.parentType === "opportunity"
      ? `/api/commercial/opportunities/${opts.parentId}/documents`
      : `/api/commercial/projects/${opts.parentId}/documents`;

  let xhr: XMLHttpRequest | null = null;
  let canceled = false;

  const run = async (): Promise<DirectUploadResult> => {
    const { file } = opts;
    const mime = file.type || "application/octet-stream";

    // 1) mint a signed upload URL
    const signRes = await fetch(`${base}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_name: file.name, mime_type: mime, size_bytes: file.size }),
    });
    const sign = (await signRes.json().catch(() => ({}))) as {
      ok?: boolean;
      bucket?: string;
      storage_key?: string;
      token?: string;
      detail?: string;
    };
    if (!signRes.ok || !sign.ok || !sign.token || !sign.storage_key || !sign.bucket) {
      return { ok: false, error: sign.detail ?? "Could not start the upload." };
    }
    if (canceled) return { ok: false, error: "Canceled.", canceled: true };

    // A signed upload URL authorises the PATH, not the CALLER — the insert
    // still runs as whoever holds the bearer token, against the RLS policy on
    // storage.objects. Sending the publishable key made every upload run as
    // `anon`, which no policy covers, so Storage refused the row and reported
    // it as a bare HTTP 400 (Stephanie, 2026-08-13: "Storage rejected the file
    // HTTP400" on an 86 KB set of plans — the size was a red herring).
    //
    // So we send the signed-in user's own access token. Migration 137 grants
    // `authenticated` the matching insert. Server-side uploads never hit this
    // because the service role bypasses RLS — which is exactly why it survived
    // until someone uploaded from a browser.
    const { createClient } = await import("@/lib/supabase/client");
    const { data: { session } } = await createClient().auth.getSession();
    const accessToken = session?.access_token;
    if (!accessToken) {
      return { ok: false, error: "Your session has expired. Reload the page and sign in again, then re-attach the file." };
    }

    // 2) PUT straight to Storage against the signed URL (XHR for progress)
    const supaBase = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const url = new URL(`${supaBase}/storage/v1/object/upload/sign/${sign.bucket}/${sign.storage_key}`);
    url.searchParams.set("token", sign.token);

    try {
      await new Promise<void>((resolve, reject) => {
        const x = new XMLHttpRequest();
        xhr = x;
        // PUT, not POST. On the storage-v1 API the VERB is what distinguishes
        // the two routes at this identical path: POST /object/upload/sign/...
        // MINTS a signed URL, PUT uploads to one. Sending the file with POST
        // therefore hits the create-a-URL route with a multipart body and is
        // rejected outright.
        //
        // Verified against live Storage 2026-08-22 — same bucket, same signed
        // token, same body, only the verb differing:
        //   POST -> HTTP 400, nothing stored
        //   PUT  -> HTTP 200, object stored
        //
        // This is Stephanie's "Storage rejected the file (HTTP 400)" on
        // Documents and Work Orders. Migration 137 fixed the OTHER half of that
        // report (the request ran as `anon` because the client sent the
        // publishable key as its bearer), which is why the error survived a fix
        // that was correct as far as it went. The comment two lines above this
        // one has said "PUT straight to Storage" since the day it shipped.
        x.open("PUT", url.toString());
        x.setRequestHeader("apikey", process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
        x.setRequestHeader("authorization", `Bearer ${accessToken}`);
        x.setRequestHeader("x-upsert", "false");
        x.upload.onprogress = (e) => {
          if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
        };
        x.onload = () => {
          if (x.status >= 200 && x.status < 300) return resolve();
          // Storage returns its real reason in the body and a flat 400 in the
          // status, so reporting only the status throws away the one useful
          // fact. Surface what it said.
          let detail = "";
          try {
            const body = JSON.parse(x.responseText) as { message?: string; error?: string };
            detail = body.message ?? body.error ?? "";
          } catch {
            /* non-JSON body — the status is all we have */
          }
          if (/row-level security|Unauthorized|AccessDenied/i.test(detail)) {
            detail = "this account isn't allowed to upload. Sign out and back in; if it persists, tell Karan the storage policy needs checking";
          } else if (/exceeded the maximum allowed size|Payload too large/i.test(detail)) {
            detail = "the file is larger than the 100 MB limit";
          } else if (/mime type|not supported/i.test(detail)) {
            detail = "that file type isn't accepted here";
          }
          reject(new Error(detail ? `Upload failed — ${detail}.` : `Storage rejected the file (HTTP ${x.status}).`));
        };
        x.onerror = () => reject(new Error("Network error during upload."));
        x.onabort = () => reject(new Error("__aborted__"));
        const fd = new FormData();
        fd.append("cacheControl", "3600");
        fd.append("", file);
        x.send(fd);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "__aborted__") return { ok: false, error: "Canceled.", canceled: true };
      return { ok: false, error: msg };
    }

    // 3) finalize — server verifies the object + inserts the row
    const finRes = await fetch(`${base}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storage_key: sign.storage_key,
        file_name: file.name,
        mime_type: mime,
        category: opts.category,
        notes: opts.notes ?? null,
      }),
    });
    const fin = (await finRes.json().catch(() => ({}))) as {
      ok?: boolean;
      document?: unknown;
      detail?: string;
    };
    if (!finRes.ok || !fin.ok) {
      return { ok: false, error: fin.detail ?? "Could not finish the upload." };
    }
    return { ok: true, document: fin.document };
  };

  return {
    promise: run(),
    cancel: () => {
      canceled = true;
      xhr?.abort();
    },
  };
}
