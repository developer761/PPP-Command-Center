# Tests

Vitest pure-logic suite. Runs in ~1 second, zero database, zero credentials.

## Run

```bash
npm run test                 # one-shot
npm run test:watch           # interactive
npm run test:coverage        # HTML report at coverage/index.html
```

## What's covered

Pure-logic surfaces that the audits have repeatedly flagged as risk
spots — every test exists because a real bug was once shipped (or
nearly shipped) in that area:

- `commercial/email-archive/address.test.ts` — HMAC roundtrip,
  parse/verify symmetry, display-name + angle-bracket parsing,
  spoofing rejection, wrong-domain rejection. (Stage 2 audit caught
  4 bugs here that would have killed the feature.)
- `commercial/email-archive/sanitize.test.ts` — XSS bypass cases
  (entity-encoded URL schemes, `<svg onload=…>`, inline `style=`),
  HTML-to-text fallback. (Stage 2 recheck caught the
  `java&#x09;script:` bypass.)
- `commercial/notifications/dedup.test.ts` — `hasRecentNotification`
  window math. (Stage 1+2 recheck caught a CRITICAL bug where the
  dedup window at exact cadence boundary would have made every
  daily reminder fire ONCE total instead of once-per-day.)
- `commercial/opportunities/status-dag.test.ts` — `isTransitionAllowed`
  enforcement, terminal-state routing.
- `commercial/opportunities/notes-mention.test.ts` —
  `extractMentionTokens` regex injection resistance, email/uuid
  recognition.
- `commercial/cron/date-math.test.ts` — DATE-vs-TIMESTAMPTZ
  comparison correctness. (Stage 1 audit caught two CRITICAL date-
  comparison bugs that would have either flagged today's tasks as
  overdue at midnight UTC or silently excluded past-due hot deals.)
- `lib/observability.test.ts` — never-throws guarantee, dedup
  window correctness, PII-safe payload shape.

## What's NOT covered

- Supabase queries (would need a test DB; skip cost > benefit)
- Server actions (require Next.js request context)
- React components (manual + Playwright cover this)
- Salesforce integration (mocking jsforce is high-cost low-value)

## When a bug ships

When an audit catches a real bug in a pure-logic surface, add a
regression test FIRST (red), then ship the fix (green). The next
time someone touches that code, the test will catch the regression
within 1 second on the next `npm run test`.

## Coverage gate

CI fails the build if coverage on the covered surfaces drops below
60% (statements/functions/lines) or 55% (branches). Adjust in
`vitest.config.ts`.
