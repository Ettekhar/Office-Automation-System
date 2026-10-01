/** Resolve hook: redirect the real src/sheets.js to a fixture module. */
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

// Already a file:// URL, passed through untouched — wrapping it again produces
// a "file:\C:\..." path that cannot be opened.
const FAKE = process.env.MM_FAKE_SHEETS;

export async function resolve(specifier, context, next) {
  if (specifier === './sheets.js' || specifier.endsWith('/sheets.js')) {
    // Only intercept the project's own sheets module, not anything else.
    if (context.parentURL && context.parentURL.includes('/src/')) {
      return { url: FAKE, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
