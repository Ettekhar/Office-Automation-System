import { getDailyReview, getUserByName, getSites, getUsers } from '../src/db.js';

const taionUser = getUserByName('Taion');
console.log('Taion User:', taionUser ? { id: taionUser.id, name: taionUser.name, role: taionUser.role, email: taionUser.email } : 'NOT FOUND');

const allRows = getDailyReview({ userId: taionUser?.id, userName: taionUser?.name });
console.log('Rows for Taion (by id+name):', allRows.length);

const allRowsNameOnly = getDailyReview({ userName: 'Taion' });
console.log('Rows for Taion (name only):', allRowsNameOnly.length);

const allRowsNoFilter = getDailyReview();
console.log('Total rows (no filter):', allRowsNoFilter.length);

const byUser = {};
allRowsNoFilter.forEach(r => { byUser[r.userName] = (byUser[r.userName] || 0) + 1; });
console.log('By userName:', byUser);

// Check sites
const sites = getSites({});
console.log('Total sites:', sites.length);

if (allRows.length > 0) {
  const firstRow = allRows[0];
  console.log('First row preview:', { siteId: firstRow.siteId, userId: firstRow.userId, userName: firstRow.userName, siteUrl: firstRow.siteUrl });
  
  // Check siteId match
  const siteById = sites.find(s => s.id === firstRow.siteId);
  console.log('Site found by siteId:', siteById ? siteById.url : 'NOT FOUND');
}

// Check all users
const users = getUsers();
console.log('All users:', users.map(u => ({ id: u.id, name: u.name, role: u.role })));
