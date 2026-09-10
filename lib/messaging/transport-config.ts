/**
 * Whether anything is actually being delivered, and why not.
 *
 * Split out of transport.ts because gate-is-the-only-path.test.ts caught the
 * dashboard importing that module to show its status, and the test was right
 * to: the guarantee is that nothing outside the gate can reach the module that
 * exports `send`. Weakening the check to allow "harmless" imports would have
 * traded a real invariant for one screen's convenience.
 *
 * So the DECISION lives here, with no sender anywhere near it, and both sides
 * read the same function — transport.ts to choose what to build, the dashboard
 * to say what is happening. One source of truth, and no way for a page to hold
 * a reference to a carrier.
 */
export type TransportChoice =
  | { live: false; why: string }
  | {
      live: true;
      why: string;
      aws: {
        region: string;
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
        configurationSetName?: string;
      };
    };

/**
 * TWO switches, deliberately. Credentials appearing in the environment is not
 * consent to start texting people — a key can arrive for all sorts of reasons,
 * including somebody wiring up an unrelated feature. Delivery needs
 * SMS_LIVE_SENDING to be exactly "true" AS WELL AS a configured carrier.
 */
/**
 * Whether EMAIL is being delivered, on its own switch.
 *
 * Separate from SMS deliberately. Turning on texting must not silently start
 * emailing people as well — they are different channels, different volumes and
 * different opt-outs, and one switch for both is how a campaign nobody meant
 * to run goes out over a channel nobody was watching.
 */
export function emailChoice(env: NodeJS.ProcessEnv = process.env): { live: boolean; why: string } {
  if (env.EMAIL_LIVE_SENDING !== "true") {
    return { live: false, why: "Email sending is switched off. Steps are recorded and nothing is delivered." };
  }
  if (!env.RESEND_API_KEY) {
    return { live: false, why: "No Resend API key, so email steps are recorded only." };
  }
  if (!env.RESEND_FROM_ADDRESS) {
    return { live: false, why: "No sending address is configured, so email steps are recorded only." };
  }
  return { live: true, why: "Emails are being delivered." };
}

export function transportChoice(env: NodeJS.ProcessEnv = process.env): TransportChoice {
  if (env.SMS_LIVE_SENDING !== "true") {
    return { live: false, why: "Live sending is switched off. Everything is recorded and nothing is delivered." };
  }
  if (env.SMS_TRANSPORT !== "aws") {
    return { live: false, why: "No carrier is configured, so sends are recorded only." };
  }
  const region = env.AWS_SMS_REGION;
  const accessKeyId = env.AWS_SMS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SMS_SECRET_ACCESS_KEY;
  if (!region || !accessKeyId || !secretAccessKey) {
    return { live: false, why: "The carrier is selected but its credentials are incomplete, so sends are recorded only." };
  }
  return {
    live: true,
    why: "Messages are being delivered to real phones.",
    aws: {
      region, accessKeyId, secretAccessKey,
      sessionToken: env.AWS_SMS_SESSION_TOKEN,
      configurationSetName: env.AWS_SMS_CONFIGURATION_SET,
    },
  };
}
