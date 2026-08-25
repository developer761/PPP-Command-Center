import { describe, it, expect } from "vitest";
import { postCommercialSlack, commercialSlackConfigured } from "@/lib/commercial/slack-notify";

/**
 * A REAL post to the configured channel, for confirming the webhook works.
 *
 * Skips itself when COMMERCIAL_SLACK_WEBHOOK is unset, so it never fires during
 * a normal `npm test` run and never breaks CI.
 *
 * To send one:
 *   COMMERCIAL_SLACK_WEBHOOK='https://hooks.slack.com/services/…' \
 *     npx vitest run __tests__/commercial/slack-live-send.test.ts
 *
 * It calls the SAME postCommercialSlack the platform calls. A script that
 * rebuilt the payload by hand would prove the script works and tell you nothing
 * about whether an approval request will actually arrive.
 */
describe("live Slack send", () => {
  it.skipIf(!commercialSlackConfigured())("posts a sample of each message the channel will get", async () => {
    // The three shapes, so the formatting, colour bar and button can all be
    // judged at a glance rather than waiting for a real proposal to happen.
    await postCommercialSlack({
      text: "*Approval needed* — R2 · $30,000.00 for *Alta Construction East Inc.*",
      context:
        "JD Sports — 37-38 Junction Blvd · requested by Stephanie · it can't go to the customer until an approver approves it",
      url: "/commercial/proposals",
      urlLabel: "Review & approve",
      tone: "needs_action",
    });
    await postCommercialSlack({
      text: "*Proposal approved* — R2 for *Alta Construction East Inc.*",
      context: "JD Sports — 37-38 Junction Blvd · approved by Brendan Dwyer · ready to send to the customer",
      url: "/commercial/proposals",
      urlLabel: "Send it",
      tone: "good",
    });
    await postCommercialSlack({
      text: "*New bid request* — *Alta Construction East Inc.*",
      context: "JD Sports — 37-38 Junction Blvd · from Bryon · bryon@altaconstruction-inc.net",
      url: "/commercial/opportunities",
      urlLabel: "Open the opportunity",
      tone: "needs_action",
    });
    expect(commercialSlackConfigured()).toBe(true);
  }, 30_000);
});
