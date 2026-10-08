import { appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, '../src/db.js');

const authCode = `
// ==========================================================================
// AUTHENTICATION — Sessions, Password Hashing, Google OAuth
// ==========================================================================

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Hash a password using PBKDF2. Returns "pbkdf2:<salt>:<hash>" */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
  return 'pbkdf2:' + salt + ':' + hash;
}

/** Verify a plaintext password against a stored hash. */
export function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2:')) return false;
  const parts = stored.split(':');
  const salt = parts[1]; const expected = parts[2];
  if (!salt || !expected) return false;
  try {
    const actual = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) { return false; }
}

/** Look up a user by email (case-insensitive). */
export function getUserByEmail(email) {
  if (!email) return null;
  const e = email.toLowerCase().trim();
  return getUsers().find(u => (u.email || '').toLowerCase() === e) || null;
}

function getSessions() { return ensureArray(dbRead('auth-sessions')); }
function setSessions(data) { dbWrite('auth-sessions', data); }

function pruneExpiredSessions() {
  const nowMs = Date.now();
  const sessions = getSessions().filter(s => s.expiresAt && new Date(s.expiresAt).getTime() > nowMs);
  setSessions(sessions);
  return sessions;
}

/** Create a new session for a user. Returns the session token. */
export function createSession(userId, meta) {
  if (!meta) meta = {};
  pruneExpiredSessions();
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    id: uuid(), token, userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    userAgent: meta.userAgent || '', ip: meta.ip || '',
    provider: meta.provider || 'email',
  };
  const sessions = getSessions();
  sessions.push(session);
  setSessions(sessions);
  return token;
}

/** Look up a valid session by token. Returns {session, user} or null. */
export function getSessionByToken(token) {
  if (!token) return null;
  pruneExpiredSessions();
  const session = getSessions().find(s => s.token === token);
  if (!session) return null;
  const user = getUserById(session.userId);
  if (!user || user.active === false) return null;
  return { session, user };
}

/** Revoke (delete) a session by token. */
export function revokeSession(token) {
  if (!token) return;
  setSessions(getSessions().filter(s => s.token !== token));
}

/** Revoke all sessions for a user. */
export function revokeAllUserSessions(userId) {
  setSessions(getSessions().filter(s => s.userId !== userId));
}

/** Set or update a user's password hash. */
export function setUserPassword(userId, plainPassword) {
  return updateUser(userId, { passwordHash: hashPassword(plainPassword) });
}

/** Link a Google account to an existing user. */
export function linkGoogleAccount(userId, opts) {
  return updateUser(userId, {
    googleSub: opts.googleSub,
    googleEmail: opts.googleEmail || '',
    googleName: opts.googleName || '',
    googlePicture: opts.googlePicture || '',
  });
}

/** Find a user by Google subject ID. */
export function getUserByGoogleSub(sub) {
  if (!sub) return null;
  return getUsers().find(u => u.googleSub === sub) || null;
}

/** Parse the session token from an HTTP Cookie header. */
export function tokenFromCookieHeader(cookieHeader) {
  if (!cookieHeader) return null;
  const match = (cookieHeader + '').match(/(?:^|;\s*)officeos_session=([^;]+)/);
  return match ? match[1] : null;
}

/** Parse the session token from an Authorization: Bearer header. */
export function tokenFromAuthHeader(authHeader) {
  if (!authHeader) return null;
  const m = /^Bearer\\s+(.+)$/i.exec((authHeader + '').trim());
  return m ? m[1].trim() : null;
}

/**
 * Resolve the authenticated user from a request (Node IncomingMessage).
 * Checks Cookie first, then Authorization header.
 */
export function resolveAuthUser(req) {
  const h = req && req.headers ? req.headers : {};
  const cookieToken = tokenFromCookieHeader(h.cookie || '');
  const bearerToken = tokenFromAuthHeader(h.authorization || '');
  const token = cookieToken || bearerToken;
  if (!token) return null;
  const result = getSessionByToken(token);
  return result ? result.user : null;
}

/** Build a Set-Cookie string for the session token. */
export function buildSessionCookie(token, opts) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const secure = (opts && opts.secure === false) ? '' : '; Secure';
  return 'officeos_session=' + token + '; Max-Age=' + maxAge + '; Path=/; HttpOnly; SameSite=Lax' + secure;
}

/** Build a cookie that clears the session. */
export function buildClearSessionCookie() {
  return 'officeos_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax';
}
`;

appendFileSync(dbPath, authCode, 'utf8');
console.log('Auth functions appended to db.js successfully.');
