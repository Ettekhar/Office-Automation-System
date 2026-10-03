/**
 * auth.js — Authentication API routes for OfficeOS
 *
 * Handles:
 *  - POST /api/auth/login         — email + password login
 *  - POST /api/auth/logout        — revoke session cookie
 *  - GET  /api/auth/me            — current session info
 *  - GET  /api/auth/google        — start Google OAuth flow
 *  - GET  /api/auth/google/callback — OAuth callback, create session
 *  - POST /api/auth/set-password  — superadmin: set user password
 *
 * All routes work identically on the Node.js local server and on the
 * Cloudflare Worker (via the http-shim adapter). The only difference is
 * that the Worker's gate() in dashboard-worker.js is bypassed for all
 * /api/auth/* routes — auth must be publicly reachable so the user can
 * log in before they have a session token.
 */

import * as db from './db.js';

const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.CLOUDFLARE_WORKER;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

// ── Helpers ──────────────────────────────────────────────────────────────────

function cookieOpts(req) {
  // In production (HTTPS) set Secure; skip it on localhost HTTP.
  const host = (req.headers && req.headers.host) || '';
  const isLocal = host.startsWith('localhost') || host.startsWith('127.');
  return { secure: IS_PRODUCTION || !isLocal };
}

function safeUser(user) {
  // Never return passwordHash, googleSub internals to the client.
  const { passwordHash, googleSub, ...safe } = user;
  return safe;
}

/**
 * Resolve the Google OAuth redirect URI from the current request.
 * On Cloudflare Workers the host comes from the request URL.
 */
function oauthRedirectUri(req) {
  const customBase = process.env.APP_BASE_URL || '';
  if (customBase) return customBase.replace(/\/$/, '') + '/api/auth/google/callback';
  const host = (req.headers && req.headers.host) || 'localhost:3000';
  const proto = IS_PRODUCTION ? 'https' : 'http';
  return `${proto}://${host}/api/auth/google/callback`;
}

// ── Route handlers ────────────────────────────────────────────────────────────

/** POST /api/auth/login */
export async function handleLogin(req, res, body) {
  const { email, password } = body || {};
  if (!email || !password) {
    return sendAuthJson(res, 400, { error: 'Email and password are required.' });
  }

  const user = db.getUserByEmail(email);
  if (!user) {
    return sendAuthJson(res, 401, { error: 'Invalid email or password.' });
  }
  if (user.active === false) {
    return sendAuthJson(res, 403, { error: 'This account has been deactivated. Contact your administrator.' });
  }
  if (!user.passwordHash) {
    return sendAuthJson(res, 401, { error: 'No password set for this account. Use Google sign-in or contact your admin.' });
  }
  if (!db.verifyPassword(password, user.passwordHash)) {
    return sendAuthJson(res, 401, { error: 'Invalid email or password.' });
  }

  const token = db.createSession(user.id, {
    userAgent: (req.headers && req.headers['user-agent']) || '',
    ip: (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '')) || '',
    provider: 'email',
  });

  const opts = cookieOpts(req);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': db.buildSessionCookie(token, opts),
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ ok: true, user: safeUser(user) }));
}

/** POST /api/auth/logout */
export function handleLogout(req, res) {
  const cookieHeader = (req.headers && req.headers.cookie) || '';
  const token = db.tokenFromCookieHeader(cookieHeader) || db.tokenFromAuthHeader((req.headers && req.headers.authorization) || '');
  if (token) db.revokeSession(token);

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': db.buildClearSessionCookie(),
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ ok: true }));
}

/** GET /api/auth/me */
export function handleMe(req, res) {
  const user = db.resolveAuthUser(req);
  if (!user) {
    return sendAuthJson(res, 401, { error: 'Not authenticated.' });
  }
  sendAuthJson(res, 200, { user: safeUser(user) });
}

/** GET /api/auth/google  — redirect to Google OAuth */
export function handleGoogleStart(req, res, reqUrl) {
  if (!GOOGLE_CLIENT_ID) {
    // Google OAuth not configured — redirect to login with error
    res.writeHead(302, { Location: '/login.html?error=oauth_not_configured', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  const returnTo = reqUrl.searchParams.get('returnTo') || '/master.html';
  const redirectUri = oauthRedirectUri(req);

  // Store returnTo in the state param (base64-encoded for safety)
  const state = Buffer.from(JSON.stringify({ returnTo, ts: Date.now() })).toString('base64url');

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
    state,
  });

  res.writeHead(302, {
    Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString(),
    'Cache-Control': 'no-store',
  });
  res.end();
}

/** GET /api/auth/google/callback — handle OAuth code from Google */
export async function handleGoogleCallback(req, res, reqUrl) {
  const code = reqUrl.searchParams.get('code');
  const stateParam = reqUrl.searchParams.get('state');
  const errorParam = reqUrl.searchParams.get('error');

  let returnTo = '/master.html';
  try {
    if (stateParam) {
      const parsed = JSON.parse(Buffer.from(stateParam, 'base64url').toString('utf8'));
      if (parsed.returnTo) returnTo = parsed.returnTo;
    }
  } catch {}

  if (errorParam === 'access_denied') {
    res.writeHead(302, { Location: '/login.html?error=access_denied', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  if (!code || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    res.writeHead(302, { Location: '/login.html?error=oauth_failed', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  try {
    const redirectUri = oauthRedirectUri(req);

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.id_token) {
      console.error('[auth] Google token exchange failed:', tokenData);
      res.writeHead(302, { Location: '/login.html?error=oauth_failed', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    // Decode the ID token payload (we trust Google's response — no need to verify sig here as we're the exchange caller)
    const idTokenParts = tokenData.id_token.split('.');
    if (idTokenParts.length < 2) {
      res.writeHead(302, { Location: '/login.html?error=oauth_failed', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const payload = JSON.parse(Buffer.from(idTokenParts[1], 'base64url').toString('utf8'));
    const { sub, email, name, picture } = payload;

    if (!sub || !email) {
      res.writeHead(302, { Location: '/login.html?error=oauth_failed', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    // Find the user: first by Google sub (previously linked), then by email
    let user = db.getUserByGoogleSub(sub);
    if (!user) {
      user = db.getUserByEmail(email);
      if (user) {
        // Link the Google account to this user
        user = db.linkGoogleAccount(user.id, { googleSub: sub, googleEmail: email, googleName: name, googlePicture: picture });
      }
    }

    if (!user) {
      res.writeHead(302, { Location: '/login.html?error=not_registered', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (user.active === false) {
      res.writeHead(302, { Location: '/login.html?error=deactivated', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    const token = db.createSession(user.id, {
      userAgent: (req.headers && req.headers['user-agent']) || '',
      ip: (req.headers && (req.headers['x-forwarded-for'] || '')) || '',
      provider: 'google',
    });

    const opts = cookieOpts(req);
    res.writeHead(302, {
      'Set-Cookie': db.buildSessionCookie(token, opts),
      Location: returnTo.startsWith('/') ? returnTo : '/master.html',
      'Cache-Control': 'no-store',
    });
    res.end();
  } catch (err) {
    console.error('[auth] Google callback error:', err);
    res.writeHead(302, { Location: '/login.html?error=oauth_failed', 'Cache-Control': 'no-store' });
    res.end();
  }
}

/** POST /api/auth/set-password  (superadmin only) */
export function handleSetPassword(req, res, body, authUser) {
  if (!authUser || authUser.role !== 'superadmin') {
    return sendAuthJson(res, 403, { error: 'Superadmin access required.' });
  }
  const { userId, password } = body || {};
  if (!userId || !password || password.length < 8) {
    return sendAuthJson(res, 400, { error: 'userId and a password of at least 8 characters are required.' });
  }
  try {
    db.setUserPassword(userId, password);
    sendAuthJson(res, 200, { ok: true, message: 'Password updated.' });
  } catch (err) {
    sendAuthJson(res, 400, { error: err.message });
  }
}

// ── Shared response helper ────────────────────────────────────────────────────

function sendAuthJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}
