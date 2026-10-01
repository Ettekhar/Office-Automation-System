/**
 * Entry-point shim that installs the src/sheets.js redirect for a CHILD process.
 *
 * Passing the hooks file straight to `node --import` does not register it: the
 * file is merely executed, and nothing tells Node to treat its exported
 * `resolve` as a module-customization hook. Without this shim the child quietly
 * reads the LIVE Google Sheets, which is how a fixture suite ends up mailing
 * decisions derived from real client data.
 *
 * `module.register()` is the supported way, so the shim calls it and then the
 * real entry point runs as usual:
 *
 *   node --import ./scratch/register-sheets-redirect.mjs src/index.js --account=CW
 */
import { register } from 'node:module';

register('./redirect-sheets-module.mjs', import.meta.url);
