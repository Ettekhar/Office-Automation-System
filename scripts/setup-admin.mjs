#!/usr/bin/env node
/**
 * scripts/setup-admin.mjs
 *
 * One-time setup script: creates or updates a superadmin user with an
 * email + password so you can sign in to OfficeOS via the login page.
 *
 * Usage:
 *   node scripts/setup-admin.mjs
 *   node scripts/setup-admin.mjs --email admin@example.com --password MySecret123
 *
 * Safe to run multiple times: if the user already exists, it only updates
 * the password and ensures the role is "superadmin".
 */

import { createInterface } from 'readline';
import * as db from '../src/db.js';

// ── Parse CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf('--' + name);
  return idx !== -1 ? args[idx + 1] : null;
}

let email = getArg('email');
let password = getArg('password');
let name = getArg('name');

// ── Interactive prompts if args not provided ────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });
function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║    OfficeOS Login System — Admin Account Setup   ║');
console.log('╚══════════════════════════════════════════════════╝\n');

try {
  // Check existing users
  const allUsers = db.getUsers();
  const superadmins = allUsers.filter(u => u.role === 'superadmin');
  if (superadmins.length > 0) {
    console.log(`ℹ️  Existing superadmin accounts: ${superadmins.map(u => u.name + ' <' + (u.email || 'no email') + '>').join(', ')}\n`);
  }

  if (!email) {
    email = await ask('📧 Admin email address: ');
  }
  email = email.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    console.error('❌ Invalid email address.');
    process.exit(1);
  }

  if (!name) {
    const suggested = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    name = await ask(`👤 Display name [${suggested}]: `);
    if (!name.trim()) name = suggested;
  }

  if (!password) {
    password = await ask('🔒 Password (min 8 chars): ');
  }
  if (!password || password.length < 8) {
    console.error('❌ Password must be at least 8 characters.');
    process.exit(1);
  }

  rl.close();

  // Create or update the user
  let existingByEmail = db.getUserByEmail(email);
  let existingByName  = db.getUserByName(name.trim());
  let user = existingByEmail || existingByName;

  if (user) {
    console.log(`\n✏️  Updating existing user: ${user.name} (id: ${user.id})`);
    db.updateUser(user.id, {
      email,
      name: name.trim(),
      role: 'superadmin',
      active: true,
    });
    db.setUserPassword(user.id, password);
    user = db.getUserById(user.id);
  } else {
    console.log(`\n➕ Creating new superadmin user: ${name.trim()}`);
    user = db.createUser({ name: name.trim(), email, role: 'superadmin', active: true });
    db.setUserPassword(user.id, password);
  }

  console.log('\n✅ Admin account ready!');
  console.log('   Name:  ', user.name);
  console.log('   Email: ', user.email);
  console.log('   Role:  ', user.role);
  console.log('\n🌐 Sign in at:  http://localhost:3000/login.html');
  console.log('   (use the Email & Password tab)\n');

} catch (err) {
  rl.close();
  console.error('❌ Error:', err.message);
  process.exit(1);
}
