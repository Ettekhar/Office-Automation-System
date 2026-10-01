/**
 * Resolve hook: redirect the local agent's ./mailer.js to a recording double.
 *
 * Only src/localMailAgent.js is affected. The CLI under test runs in a separate
 * child process with no hooks registered, so `npm run send` continues to use the
 * real mailer and the comparison stays honest: one side is the product, the other
 * is the agent, and only the agent's SMTP call is intercepted.
 */

const DOUBLE = process.env.MM_FAKE_MAILER;

export async function resolve(specifier, context, next) {
  if (specifier === './mailer.js' || specifier.endsWith('/mailer.js')) {
    if (context.parentURL && context.parentURL.endsWith('/src/localMailAgent.js')) {
      return { url: DOUBLE, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
