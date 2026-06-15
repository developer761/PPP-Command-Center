/**
 * Shared time/threshold constants for the Commercial Accounts module.
 *
 * Anything that was a bare number sprinkled across overview.ts +
 * documents.ts + the list-page activity logic lives here. Single source
 * of truth so when Alex says "make the warning fire at 45 days, not 30"
 * we change one line.
 *
 * All values are days unless noted.
 */

/** Milliseconds per day — used to turn (Date.now() - createdAt) into a
 *  day count for relative-time displays + filters. */
export const MS_PER_DAY = 86_400_000;

/** Document is "expiring soon" when within this many days of expires_at.
 *  Drives the amber badge on Documents + the Compliance checklist +
 *  the Key Dates card on Info. Used by documents.expiryStatus + the
 *  overview view's expiring_soon_document_count. */
export const EXPIRY_WARNING_DAYS = 30;

/** Activity "fresh" upper bound (in days) — the account has been
 *  touched within this window, surfaces a green tone in the activity
 *  badge / tile. */
export const ACTIVITY_FRESH_DAYS = 14;

/** Activity "stale" upper bound (in days) — beyond fresh but not yet
 *  cold. Amber tone in the activity badge. Beyond this the badge goes
 *  rose ("cold"). Also drives the list-page "Stale > 60 days" chip. */
export const ACTIVITY_STALE_DAYS = 60;

/** Window for the "Recently active" callout on the list page. Only
 *  accounts touched within this many days surface in the top-3 card. */
export const RECENT_WINDOW_DAYS = 7;
