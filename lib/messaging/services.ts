/**
 * What this workspace covers, and what it does not.
 *
 * Pure. Given the service list and one workspace's exceptions, works out what
 * is offered there and writes the lines that go into the prompt.
 *
 * THE RULE THAT MAKES THE GLOBAL LIST MEAN "EVERYWHERE": a workspace with no
 * row for a service inherits the default. Only DIFFERENCES are stored, so
 * adding a service to the default reaches every workspace that has not
 * deliberately opted out — which is the opposite of the prose fields this
 * replaces, where giving a workspace its own copy silently froze it.
 *
 * NOT IN HERE: the never-anywhere list. Bathtubs, appliances, vehicles,
 * industrial equipment, pool liners, murals and standalone furniture are
 * enforced in code by the post-filter, and are the same in every workspace. A
 * screen that appears to grant something the code will still block is worse
 * than no screen.
 */

export type Service = {
  key: string;
  label: string;
  phrase: string;
  coveredByDefault: boolean;
  sortOrder: number;
};

export type ServiceException = { serviceKey: string; covered: boolean };

export type ResolvedService = Service & {
  covered: boolean;
  /** True when this workspace differs from the default. */
  isException: boolean;
};

export function resolveServices(
  services: Service[],
  exceptions: ServiceException[]
): ResolvedService[] {
  const byKey = new Map(exceptions.map((e) => [e.serviceKey, e.covered]));
  return [...services]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
    .map((s) => {
      const override = byKey.get(s.key);
      const covered = override ?? s.coveredByDefault;
      return { ...s, covered, isException: override !== undefined && override !== s.coveredByDefault };
    });
}

/** Joined the way a person would say it: "a, b and c". */
export function listPhrase(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The prompt lines.
 *
 * Two of them, and the second is why this is worth generating rather than
 * writing by hand. A workspace that does not do flooring needs the bot to know
 * that explicitly — leaving flooring off a list is a weaker signal than saying
 * we do not do it here, and the model will otherwise happily agree to it
 * because the global prose still mentions it.
 */
export function servicesPrompt(resolved: ResolvedService[]): string {
  const covered = resolved.filter((s) => s.covered);
  const not = resolved.filter((s) => !s.covered);

  const lines: string[] = [];
  if (covered.length) {
    lines.push(
      `WHAT WE DO IN THIS AREA:\n${listPhrase(covered.map((s) => s.phrase))}.\n` +
      `That list is authoritative for which services are offered here.`
    );
  }
  if (not.length) {
    lines.push(
      `WE DO NOT OFFER THESE IN THIS AREA:\n${listPhrase(not.map((s) => s.phrase))}.\n` +
      `Other areas may offer them, but this one does not, so do not agree to them ` +
      `and do not suggest them. Treat a request for one as out of scope.`
    );
  }
  return lines.join("\n\n");
}

/** For a screen: how far this workspace differs from the default. */
export function exceptionSummary(resolved: ResolvedService[]): {
  covered: number; notCovered: number; differsFromDefault: number;
} {
  return {
    covered: resolved.filter((s) => s.covered).length,
    notCovered: resolved.filter((s) => !s.covered).length,
    differsFromDefault: resolved.filter((s) => s.isException).length,
  };
}
