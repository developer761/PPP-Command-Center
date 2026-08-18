"use client";

import { useEffect } from "react";

/**
 * Last-resort error boundary.
 *
 * Segment boundaries (app/commercial/error.tsx, app/dashboard/error.tsx) catch
 * anything thrown inside their own segment — but they render INSIDE the root
 * layout, so they can't catch a failure in the root layout itself, and they
 * don't cover the login and platform-picker pages that sit outside both.
 *
 * This one does, which is why it has to supply its own <html> and <body>: at
 * this point the layout that normally provides them is the thing that failed.
 *
 * Deliberately dependency-free — no shared components, no design tokens, no
 * fonts. Anything imported here is another thing that can throw on the screen
 * whose entire job is to survive a throw. Inline styles for the same reason.
 *
 * Shared by both platforms, so the wording stays platform-neutral.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global] fatal render error", {
      digest: error.digest,
      message: error.message,
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#FBFAF7",
          color: "#17223A",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          padding: "1.5rem",
        }}
      >
        <div
          style={{
            maxWidth: "26rem",
            width: "100%",
            background: "#FFFFFF",
            border: "1px solid #E5E1DA",
            borderRadius: "14px",
            padding: "2rem 1.75rem",
            textAlign: "center",
            boxShadow: "0 10px 30px rgba(23,34,58,0.08)",
          }}
        >
          <h1 style={{ fontSize: "1.15rem", fontWeight: 700, margin: "0 0 0.6rem" }}>
            Something went wrong
          </h1>
          <p
            style={{
              fontSize: "0.9rem",
              lineHeight: 1.6,
              color: "#46506A",
              margin: "0 0 1.2rem",
            }}
          >
            The app hit an error it couldn&rsquo;t recover from. Reloading usually
            fixes it. If it keeps happening, send the reference below to Karan.
          </p>

          {error.digest && (
            <p
              style={{
                fontSize: "0.7rem",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                color: "#6E6A66",
                margin: "0 0 1.3rem",
                wordBreak: "break-all",
              }}
            >
              Ref: {error.digest}
            </p>
          )}

          <button
            type="button"
            onClick={() => reset()}
            style={{
              minHeight: "44px",
              padding: "0.7rem 1.4rem",
              borderRadius: "9px",
              border: "none",
              background: "#EE662E",
              color: "#FFFFFF",
              fontSize: "0.9rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
