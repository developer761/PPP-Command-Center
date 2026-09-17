/**
 * The walkthrough — "How everything works", read on screen and by role.
 *
 * Karan 2026-09-16: "make this a tab instead of just a PDF, where it gives
 * them a full detailed walkthrough and they can go as Brendan / Stephanie /
 * Mary and it gives them their tabs and what they do and what each button
 * does, and an overview one where it goes through everything with a bit less
 * detail."
 *
 * WHY BY PERSON AND NOT BY FEATURE
 *
 * A handbook organised by feature makes everybody read everything to find the
 * three pages that are theirs. Mary does not need submittals and Stephanie does
 * not need sales tax. So the top-level choice is WHO YOU ARE, and each role
 * gets only its own surfaces, in the order it meets them on a normal day.
 *
 * `overview` is the exception: the whole platform at a shallower depth, for
 * somebody new, or for Alex, who wants to know what exists rather than how to
 * work it.
 *
 * THE DETAIL LEVEL IS THE POINT. "Go to Receivables and record the payment" is
 * not a walkthrough — the person is already on Receivables and cannot see which
 * control to press. So a surface lists its CONTROLS by their exact on-screen
 * label, which is also what makes this file checkable: the labels are quoted
 * from the components, and a test holds the routes to real pages.
 *
 * KEEP IT HONEST: if a surface changes, change it here. A walkthrough that
 * names a button which is no longer there costs somebody their afternoon and
 * their trust in the rest of the page.
 */

export type RoleKey = "overview" | "mary" | "brendan" | "stephanie";

/** One control on a surface — a button, a field, a filter. */
export type Control = {
  /** Exactly what it says on screen. Quoted from the component, not invented. */
  label: string;
  /** What pressing it does. One sentence, plain words. */
  does: string;
  /** A field the person fills in rather than a button they press. */
  kind?: "button" | "field" | "filter" | "link";
  /** Fields only: is it required to save? */
  required?: boolean;
  /**
   * The `data-tour` value on this control, when it has one.
   *
   * THIS is what makes the walkthrough a walkthrough. Karan, on the first
   * version: "it should bring them to individual items, not just bring them to
   * the page." A step per PAGE tells somebody where to stand; a step per
   * CONTROL points at the box they type in and the button they press.
   */
  tourTarget?: string;
};

/** A drawn tab strip, showing where on the row this surface sits. */
export type Strip = { boxes: string[]; at: number };

export type Surface = {
  /** The name on screen. */
  name: string;
  /** Where it is, as a real route — checked by the tests. */
  href: string;
  /** The trail somebody reads out loud: "Accounting › Receivables". */
  path: string;
  /** What you come here to do. */
  purpose: string;
  strip?: Strip;
  /** The main job, in order. */
  steps?: string[];
  /** What each thing on the page does. */
  controls?: Control[];
  /** The thing that bites. */
  watchOut?: string;
  /**
   * What the walkthrough spotlights on the real page — the value of a
   * `data-tour` attribute, without the selector syntax.
   *
   * Optional on purpose. A surface with no hook still gets a walkthrough step:
   * it navigates there and explains the page with a centred card. Requiring a
   * hook everywhere would mean either touching every page in the platform
   * before any of this shipped, or quietly dropping the surfaces that had none.
   */
  tourTarget?: string;
};

export type Chapter = {
  /** Anchor id, used by the left-hand rail. */
  id: string;
  title: string;
  blurb: string;
  surfaces: Surface[];
};

export type RoleGuide = {
  key: RoleKey;
  /** The name on the switcher. */
  label: string;
  /** What this person does, for the card under the switcher. */
  tagline: string;
  /** The one-line answer to "what is my job in here". */
  intro: string;
  chapters: Chapter[];
};

/**
 * The controls worth listing UNDER the steps.
 *
 * A form surface names every field in its steps, in order — "Click Invoice",
 * "Type the Amount", "Pick the Method" — and then the table underneath said all
 * of it again. Twice the words, twice the height, and the reader has to notice
 * they are the same list before they can skip it.
 *
 * So a control the steps already walk you through is dropped, and the table
 * keeps only what the steps do not cover: the buttons around the edge (Export,
 * Print / PDF, Send) and the things you only reach later. On Receivables that
 * is eleven rows down to six.
 */
export function extraControls(su: Surface): Control[] {
  const walked = (su.steps ?? []).join(" ").toLowerCase();
  return (su.controls ?? []).filter((c) => !walked.includes(c.label.toLowerCase()));
}

/** One step of a guided tour. */
export type Step = { route: string; target?: string; title: string; body: string };

/**
 * A surface, as the steps of a guided tour.
 *
 * ONE STEP PER CONTROL, not one per page. The surface itself is the first step
 * — arrive, and hear what the page is for — and then every control that
 * declares a hook gets its own, pointing at the actual box or button.
 *
 * A control with no hook is folded into the arrival step's body rather than
 * given a step of its own: a card that says "press Record payment" while
 * spotlighting nothing is the failure this replaced.
 */
export function surfaceSteps(su: Surface): Step[] {
  const hooked = (su.controls ?? []).filter((c) => c.tourTarget);
  const numbered = (su.steps ?? []).map((t, i) => `${i + 1}. ${t}`).join("  ");

  const arrival: Step = {
    route: su.href,
    target: su.tourTarget ? `[data-tour="${su.tourTarget}"]` : undefined,
    title: su.name,
    // When the controls get their own steps, the arrival card does not repeat
    // them — it says what the page is for and then hands over.
    body: hooked.length > 0 ? su.purpose : numbered ? `${su.purpose}\n\n${numbered}` : su.purpose,
  };

  return [
    arrival,
    ...hooked.map((c) => ({
      route: su.href,
      target: `[data-tour="${c.tourTarget}"]`,
      title: c.label,
      body: c.required ? `${c.does}\n\nThis one is required.` : c.does,
    })),
  ];
}

/** A whole role's day, in order, as one tour. */
export function roleTour(role: RoleGuide): Step[] {
  return role.chapters.flatMap((c) => c.surfaces.flatMap(surfaceSteps));
}

/** Every route the walkthrough points at — for the test that keeps it honest. */
export function walkthroughRoutes(roles: RoleGuide[]): string[] {
  const out: string[] = [];
  for (const r of roles) for (const c of r.chapters) for (const su of c.surfaces) out.push(su.href);
  return [...new Set(out)];
}
