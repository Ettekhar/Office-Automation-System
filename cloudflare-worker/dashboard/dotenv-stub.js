/**
 * dotenv-stub.js  -  stands in for `dotenv/config`.
 *
 * src/server.js line 1 and src/index.js both do `import 'dotenv/config'`,
 * which on a laptop reads .env off disk. There is no disk in a Worker, and
 * there is nothing to read: every secret this Worker needs (ADMIN_TOKEN,
 * GOOGLE_SERVICE_ACCOUNT_JSON) is a Cloudflare secret, injected into the env
 * binding, never a file. So the side effect is correctly a no-op.
 *
 * If .env loading ever mattered here, the answer would be a Worker secret, not
 * a file read.
 */

export default {};
