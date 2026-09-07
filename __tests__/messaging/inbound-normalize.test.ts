import { describe, it, expect } from "vitest";
import { normalizeInbound, reactionResponse } from "@/lib/messaging/inbound-normalize";

describe("iPhone reactions", () => {
  it("reads every verb Apple sends", () => {
    const cases: [string, string][] = [
      ['Liked "Would around 12 or 2 work?"', "liked"],
      ['Loved "Thanks! Checking our schedule now."', "loved"],
      ['Laughed at "We can text you a quote"', "laughed at"],
      ['Emphasized "Our earliest slot is usually 10 AM"', "emphasised"],
      ['Questioned "Is 42 Elm St the correct address?"', "questioned"],
      ['Disliked "We have openings next week"', "disliked"],
    ];
    for (const [raw, verb] of cases) {
      const n = normalizeInbound(raw);
      expect(n.kind, raw).toBe("reaction");
      expect(n.reaction?.verb).toBe(verb);
    }
  });

  it("describes the reaction in words, never raw platform syntax", () => {
    // What the model sees. "Liked "..."" is gibberish to it; this is not.
    const n = normalizeInbound('Liked "Would around 12 or 2 work?"');
    expect(n.description).toBe('The customer liked the message: "Would around 12 or 2 work?"');
  });

  it("keeps the raw text, because a reaction is evidence", () => {
    const raw = 'Liked "Would around 12 or 2 work?"';
    expect(normalizeInbound(raw).raw).toBe(raw);
  });

  it("does NOT treat a sentence starting with a verb as a reaction", () => {
    // "Liked the colour you picked" is a customer talking. Swallowing it and
    // replying "Got it." would drop what they actually said.
    for (const s of [
      "Liked the colour you suggested",
      "Loved working with your team last time",
      "Questioned whether we need primer",
    ]) {
      const n = normalizeInbound(s);
      expect(n.kind, s).toBe("text");
      expect(n.text).toBe(s);
    }
  });

  it("handles curly quotes, which is what phones actually send", () => {
    expect(normalizeInbound('Liked “Is that correct?”').kind).toBe("reaction");
  });

  it("truncates a long target so the description stays readable", () => {
    const long = "a".repeat(200);
    const n = normalizeInbound(`Liked "${long}"`);
    expect(n.description.length).toBeLessThan(120);
    expect(n.reaction?.target).toBe(long); // full text still kept
  });
});

describe("Android reactions", () => {
  it("reads the emoji-to-quote form", () => {
    const n = normalizeInbound('👍 to "Would around 12 or 2 work?"');
    expect(n.kind).toBe("reaction");
    expect(n.reaction?.sentiment).toBe("positive");
    expect(n.description).toContain("thumbs up");
  });

  it("reads a negative one as negative", () => {
    expect(normalizeInbound('👎 to "We have openings next week"').reaction?.sentiment).toBe("negative");
  });
});

describe("emoji and photos", () => {
  it("treats an emoji-only reply as a reaction, not as text", () => {
    const n = normalizeInbound("👍");
    expect(n.kind).toBe("emoji_only");
    expect(n.description).toContain("thumbs up");
  });

  it("treats emoji WITH words as ordinary text", () => {
    // "👍 sounds good" is an answer. Classifying it as a bare reaction would
    // throw away "sounds good".
    const n = normalizeInbound("👍 sounds good");
    expect(n.kind).toBe("text");
    expect(n.text).toBe("👍 sounds good");
  });

  it("does not lose a photo sent with no words", () => {
    // An MMS with a photo and no text is not an empty message. Emily's prompt
    // has a whole branch about forwarding photos to the estimator.
    const n = normalizeInbound("", 2);
    expect(n.kind).toBe("media");
    expect(n.description).toContain("2 photos");
    // And the sentence has to END, not trail off. The first version of this
    // test only checked kind and "2 photos", so it passed even when the
    // captionless branch was removed and the fallback produced "...and wrote: "
    // with nothing after it — a broken sentence going straight into the prompt.
    expect(n.description).toBe("The customer sent 2 photos with no message.");
    expect(n.description).not.toMatch(/wrote:\s*$/);
  });

  it("says 'photo' not 'photos' for a single one", () => {
    expect(normalizeInbound("", 1).description).toBe("The customer sent 1 photo with no message.");
  });

  it("keeps both the photo and the words", () => {
    const n = normalizeInbound("here's the deck", 1);
    expect(n.kind).toBe("media");
    expect(n.text).toBe("here's the deck");
    expect(n.description).toContain("1 photo");
  });

  it("reports a genuinely empty message as empty", () => {
    expect(normalizeInbound("   ").kind).toBe("empty");
  });
});

describe("reactionResponse — Emily's rule, and the bug it prevents", () => {
  const liked = normalizeInbound('Liked "Is 42 Elm St the correct address?"');
  const likedInfo = normalizeInbound('Liked "Thanks! Checking our schedule now."');

  it("a reaction to a QUESTION is not an answer", () => {
    // The bug. Treating a thumbs-up on "what's your address?" as an answer
    // loses the address and moves the flow on without it.
    const r = reactionResponse(liked, true);
    expect(r.treatAs).toBe("not_an_answer");
    expect(r.guidance).toContain("Rephrase");
    expect(r.guidance).toContain('Do not say "Got it"');
  });

  it("a reaction to an INFORMATIONAL message confirms it", () => {
    const r = reactionResponse(likedInfo, false);
    expect(r.treatAs).toBe("confirmation");
    expect(r.guidance).toContain("Got it.");
  });

  it("a NEGATIVE reaction is never a confirmation, whatever it followed", () => {
    // Reading a thumbs-down on "checking our schedule" as agreement is worse
    // than reading it as nothing.
    const disliked = normalizeInbound('Disliked "Thanks! Checking our schedule now."');
    const r = reactionResponse(disliked, false);
    expect(r.treatAs).toBe("not_an_answer");
    expect(r.guidance).toContain("negatively");
  });

  it("emoji-only follows the same rule as a reaction", () => {
    expect(reactionResponse(normalizeInbound("👍"), true).treatAs).toBe("not_an_answer");
    expect(reactionResponse(normalizeInbound("👍"), false).treatAs).toBe("confirmation");
  });

  it("ordinary text is left alone", () => {
    expect(reactionResponse(normalizeInbound("42 Elm St"), true).treatAs).toBe("normal");
  });
});
