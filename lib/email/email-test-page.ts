/**
 * The confirm page GET /api/admin/email-test renders instead of sending.
 *
 * That GET used to send. It now shows the parameters, editable, with one
 * button that POSTs them — Karan's bookmarked link still works with one extra
 * click, and a link clicked anywhere else can no longer mail anyone.
 */

export const EMAIL_TEST_PARAMS = ["to", "kind", "name", "wo"] as const;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The confirm page's HTML: the parameters, editable, and one POST button. */
export function emailTestConfirmPage(params: URLSearchParams): string {
  const v = (k: string) => escapeHtml(params.get(k) ?? "");
  const kind = params.get("kind") === "confirmation" ? "confirmation" : "invite";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Send test email</title>
<style>body{font-family:Roboto,system-ui,sans-serif;color:#172B4D;background:#fff;max-width:28rem;margin:2rem auto;padding:0 16px}label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}input,select{width:100%;box-sizing:border-box;font-size:16px;padding:10px;border:1px solid #c1c7d0;border-radius:8px}button{margin-top:20px;width:100%;min-height:44px;font-size:15px;font-weight:600;color:#fff;background:#172B4D;border:0;border-radius:8px}p{font-size:13px;color:#505f79}</style></head>
<body><h1 style="font-size:20px">Send test email</h1>
<p>Sends a [TEST] copy of the customer email using the live templates. Nothing is sent until you press the button.</p>
<form method="post" action="/api/admin/email-test">
<label for="to">To</label><input id="to" name="to" type="email" required value="${v("to")}">
<label for="kind">Email</label><select id="kind" name="kind"><option value="invite"${kind === "invite" ? " selected" : ""}>Color form invite</option><option value="confirmation"${kind === "confirmation" ? " selected" : ""}>Submission receipt</option></select>
<label for="name">Customer name</label><input id="name" name="name" value="${v("name")}" placeholder="Test Customer">
<label for="wo">Work order</label><input id="wo" name="wo" value="${v("wo")}" placeholder="00099999-TEST">
<button type="submit">Send test email</button></form></body></html>`;
}
