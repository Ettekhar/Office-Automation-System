/**
 * A stand-in for src/mailer.js, used ONLY by scratch/verify-agent-email.mjs.
 *
 * The point is to observe what localMailAgent.js hands to the mailer without a
 * single message leaving the machine. `buildEmail` is re-exported from the REAL
 * module, so the email body under test is still produced by the product's own
 * template — only the SMTP call is intercepted.
 *
 * This file lives in scratch/, and the redirect hook only intercepts imports whose
 * parent is inside src/, so the `../src/mailer.js` specifier below resolves to the
 * real thing rather than to this file.
 */

export * from '../src/mailer.js';

import { sendReportEmail as realSend } from '../src/mailer.js';

export const CALLS = [];

export async function sendReportEmail(args) {
  CALLS.push({
    to: args.to,
    subject: args.subject,
    html: args.html,
    dryRun: args.dryRun,
    accountKey: args.accountKey,
  });
  // A nodemailer-shaped success, so the agent's own bookkeeping is exercised for
  // real. No transport is ever constructed.
  if (realSend === undefined) throw new Error('the real mailer did not load');
  return { messageId: `test-message-${CALLS.length}@example.invalid`, accepted: args.to };
}

export function reset() {
  CALLS.length = 0;
}
