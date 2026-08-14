/**
 * The clock-in WINDOW + override PIN, in one place so the field page (client),
 * the /api/f/clock enforcement (server), and the admin setting all agree.
 *
 * Karan 2026-08-14: a crew member can't clock in until 10 minutes before their
 * scheduled start — stops early/accidental punches on a job that hasn't begun.
 * Alex overrides with a PIN (default 2026, settable in admin settings) for the
 * legitimate "start early today" case.
 *
 * No `server-only` here — the client field page imports the constants too.
 */

export const CLOCK_OVERRIDE_PIN_KEY = "field_ops_clock_override_pin";
export const DEFAULT_CLOCK_OVERRIDE_PIN = "2026";
/** Minutes before the scheduled start that clock-in opens. */
export const CLOCK_WINDOW_MINUTES = 10;
