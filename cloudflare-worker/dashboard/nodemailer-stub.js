/**
 * nodemailer-stub.js  -  stands in for nodemailer inside the dashboard Worker.
 *
 * THE RULE: THE WORKER MUST NOT SEND MAIL.
 *
 * SMTP lives on the operator's machine, and that is deliberate - it is the only
 * thing that authenticates to the real mail provider, and keeping it local means
 * the mail credentials never exist in Cloudflare at all. The mailer Worker
 * (officeos-mailer) plans the run and the local agent (src/localMailAgent.js)
 * is the only process that ever opens an SMTP connection.
 *
 * So this is not a functional shim. Every entry point THROWS. A dashboard
 * route that tries to send mail gets a loud, unambiguous failure instead of a
 * silent success that never delivered anything to a client.
 *
 * src/mailer.js is still in the module graph (server.js reaches it), and it is
 * still byte-for-byte unmodified. It simply cannot be used from here, by design.
 */

function refuse(what) {
  return () => {
    throw new Error(
      `nodemailer-stub: refusing to ${what} from the Cloudflare dashboard. `
      + `SMTP is local by design - run the mail on the operator machine with `
      + `src/localMailAgent.js (npm run relay), which is the only sender.`,
    );
  };
}

export const createTransport = refuse('open an SMTP transport');
export const sendMail = refuse('send mail');
export const createTestAccount = refuse('create a test account');
const nodemailer = { createTransport, sendMail, createTestAccount };
export default nodemailer;
