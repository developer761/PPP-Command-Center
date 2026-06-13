/**
 * Account Manager → team roster.
 *
 * Hardcoded mapping from team member name → their Account Manager (AM).
 * Katie sent this list 2026-06-12 by email. It's not in Salesforce yet —
 * lives in code until PPP IT wires a User field for it. Authoritative
 * source of truth in the meantime.
 *
 * Match is case-insensitive on the FULL rep name. PPP names are stable
 * (no Jr/Sr suffix collisions), so a string-equal match is safe.
 *
 * Surfaces using this:
 *   - Rep profile header — shows "AM: Macarena Alario" next to the rep's name
 *   - Account / customer references — shows AM badge so PPP staff know
 *     who internally owns the relationship
 *   - Materials WO list (future) — admin can filter "show me Trish's team"
 *
 * To add / update: edit the AM blocks below. Future move once Katie's
 * SF field lands: swap this constant for a derive() that reads
 * SFDC_Staff__c.Account_Manager__c (or whatever Katie ships).
 */

export type AccountManager = {
  name: string;
  team: string[];
};

export const ACCOUNT_MANAGERS: AccountManager[] = [
  {
    name: "Macarena Alario",
    team: ["Dave An", "John Kelly", "Michael Adler"],
  },
  {
    name: "Trish Gates",
    team: [
      "Stephen Sandoval",
      "Al Solomon",
      "Paulo Oliveira",
      "Dayne Rasmussen",
      "Sean Cunningham",
    ],
  },
  {
    name: "Amy Mariano",
    team: [
      "Andres Grajales",
      "Brendan Dwyer",
      "Brandon Hanson",
      "James Telesco",
    ],
  },
];

/**
 * Build a reverse-lookup map (team member name → their AM's name).
 * Module-level computed once; constant after first import.
 */
const TEAM_MEMBER_TO_AM: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const am of ACCOUNT_MANAGERS) {
    for (const member of am.team) {
      m.set(member.toLowerCase(), am.name);
    }
    // Also map the AM to themselves so "find AM for Macarena" returns her.
    m.set(am.name.toLowerCase(), am.name);
  }
  return m;
})();

/**
 * Look up the AM for a given rep name. Returns null when the rep isn't on
 * any roster (new hires before Katie's next roster update; reps outside the
 * sales side of the business). Returns the rep themselves if they ARE an AM.
 */
export function getAccountManagerFor(repName: string | null | undefined): string | null {
  if (!repName) return null;
  return TEAM_MEMBER_TO_AM.get(repName.trim().toLowerCase()) ?? null;
}

/**
 * True when the rep IS an Account Manager (not just on someone's team).
 */
export function isAccountManager(repName: string | null | undefined): boolean {
  if (!repName) return false;
  const target = repName.trim().toLowerCase();
  return ACCOUNT_MANAGERS.some((am) => am.name.toLowerCase() === target);
}

/**
 * Get the full team for an AM (returns empty array when not an AM).
 */
export function getTeamFor(amName: string | null | undefined): string[] {
  if (!amName) return [];
  const target = amName.trim().toLowerCase();
  const am = ACCOUNT_MANAGERS.find((a) => a.name.toLowerCase() === target);
  return am?.team ?? [];
}
