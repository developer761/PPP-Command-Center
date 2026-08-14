/**
 * Direct-to-Storage transport for OPPORTUNITY ATTACHMENTS (browser only).
 *
 * Same three-step dance as `directUploadDocument` (sign → PUT to Storage →
 * finalize), but against the opportunity /attachments endpoints and carrying an
 * optional `submittal_id` so a plan can be uploaded AND linked to its submittal
 * in one flow. The bytes go straight to Supabase Storage, never through Vercel's
 * ~4.5 MB serverless body cap — which is what made a >4.5 MB plan 413 at the
 * edge before the route ever ran (audit U1).
 *
 * NOT server-only: imported by client components. Mirrors the signed-upload
 * request shape of @supabase/storage-js exactly, hand-rolled with XHR only to
 * expose real upload-progress the SDK's fetch path doesn't.
 */

export type AttachmentUploadResult =
  | { ok: true; attachment: unknown }
  | { ok: false; error: string; canceled?: boolean };

export type AttachmentUploadHandle = {
  promise: Promise<AttachmentUploadResult>;
  cancel: () => void;
};

export function directUploadOppAttachment(opts: {
  opportunityId: string;
  file: File;
  submittalId?: string | null;
  notes?: string | null;
  onProgress?: (fraction: number) => void;
}): AttachmentUploadHandle {
  const base = `/api/commercial/opportunities/${opts.opportunityId}/attachments`;

  let xhr: XMLHttpRequest | null = null;
  let canceled = false;

  const run = async (): Promise<AttachmentUploadResult> => {
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
      error?: string;
    };
    if (!signRes.ok || !sign.ok || !sign.token || !sign.storage_key || !sign.bucket) {
      return { ok: false, error: sign.detail ?? sign.error ?? "Could not start the upload." };
    }
    if (canceled) return { ok: false, error: "Canceled.", canceled: true };

    // A signed upload URL authorises the PATH, not the CALLER — the insert runs
    // as whoever holds the bearer token against the storage.objects RLS policy,
    // so we send the signed-in user's own access token (migration 137 grants
    // `authenticated` the matching insert). See direct-upload-client.ts.
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
        x.open("POST", url.toString());
        x.setRequestHeader("apikey", process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
        x.setRequestHeader("authorization", `Bearer ${accessToken}`);
        x.setRequestHeader("x-upsert", "false");
        x.upload.onprogress = (e) => {
          if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
        };
        x.onload = () => {
          if (x.status >= 200 && x.status < 300) return resolve();
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
            detail = "the file is larger than the 50 MB limit";
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

    // 3) finalize — server verifies the object head + inserts the metadata row
    const finRes = await fetch(`${base}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storage_key: sign.storage_key,
        file_name: file.name,
        mime_type: mime,
        notes: opts.notes ?? null,
        ...(opts.submittalId ? { submittal_id: opts.submittalId } : {}),
      }),
    });
    const fin = (await finRes.json().catch(() => ({}))) as {
      ok?: boolean;
      attachment?: unknown;
      detail?: string;
      error?: string;
    };
    if (!finRes.ok || !fin.ok) {
      return { ok: false, error: fin.detail ?? fin.error ?? "Could not finish the upload." };
    }
    return { ok: true, attachment: fin.attachment };
  };

  return {
    promise: run(),
    cancel: () => {
      canceled = true;
      xhr?.abort();
    },
  };
}
