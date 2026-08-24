# Failed Salesforce write alerts — how it works

Answer to Kate's R4.32 / R5 item 07: *"Confirm how this is intended to work."*
Written from the code, not from memory — file references included so it can be
re-checked rather than trusted.

## When it fires

Only when Salesforce **rejects a write that the Command Center already
accepted**. The entry is saved here; Salesforce doesn't have it. That gap is the
whole reason the alert exists.

Trigger: `writesFailedInfo` is set after the write batch in
`app/api/customer-form/submit/[token]/route.ts:829`. It covers a rejection *and*
a thrown batch (connection dead, OAuth token expired) — an earlier version only
caught the first, so an expired token failed silently.

It fires for **every** kind of colour submission: a customer submitting their
own form, an AM doing Internal Entry, and a re-edit. Internal entry matters
particularly: the routine "your form was submitted" notification is deliberately
suppressed there — an AM doesn't need an email saying they submitted their own
form — which used to mean the one person who could fix it was told nothing.

## Who gets it

Two groups, in one email:

1. **The person who was saving.** Resolved from the token's
   `created_by_user_id`, so on a customer submission this is the staffer who
   *sent* the form, not the customer. A homeowner should never receive a
   Salesforce error, and doesn't.
2. **The ops recipients** in `PPP_SF_FAILURE_ALERT_EMAILS` — Kate and Katie.
   Env-driven so PPP can change it without a deploy.

Confirmed set in Vercel for **Production and Preview**. Vercel encrypts
sensitive values one-way, so nobody — including us — can read the addresses back
from the dashboard or the CLI. **Settings → Health** now prints the parsed
recipients so it can be self-checked. That check also catches a value that is
"set" but delivers to nobody: a typo'd domain, or smart quotes pasted from an
email, would show as set in Vercel and silently match no one.

If the variable is unset the alert still reaches the saver, and a warning is
logged. If it is set but nothing in it parses as an address, Health shows a
warning rather than an OK.

## What the email contains

- What failed, in plain terms: *"3 of 14 writes were rejected for the Smith job
  (WO #00306643). It is saved in the Command Center, but Salesforce does not
  have it."*
- **Everything that was entered** — every room, surface, colour, finish and
  note. This is the point of the email: the work is recoverable without
  starting over.
- What Salesforce actually said (error code + message), plus the three usual
  causes: the integration user missing Edit permission, Field Service Lightning
  holding the record locked, or a validation rule blocking the update.
- A link straight to the work order.

The send is **awaited**, unlike the routine notifications. A floating promise
can be killed when a serverless response returns, and this is the one message
whose entire job is making sure the entry isn't lost.

## What it does NOT cover — worth a decision

A failed **supplier-order send** does not alert anyone. That path marks the row
`status: "failed"` with a `failure_reason`
(`app/api/admin/supplier-order/send/route.ts:365`) and returns the error to the
admin on screen, so the person sending it knows immediately — but ops is not
told, and there is no recovery email with the order contents.

The alert already supports `kind: "order"` and would render the right wording;
nothing calls it that way. Covering it is small. Flagged rather than built,
because it is new scope rather than something on the list.

## Files

| Path | What |
|---|---|
| `lib/customer-form/sf-failure-alert.ts` | Recipients, email body, send |
| `app/api/customer-form/submit/[token]/route.ts:829` | The trigger |
| `app/api/admin/health/route.ts` | Reports the parsed recipients |
