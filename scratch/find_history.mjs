import cp from 'child_process';

const commits = cp.execSync('git rev-list --all', { encoding: 'utf8' }).trim().split('\n');
console.log('Total commits to inspect:', commits.length);

const terms = ['dev-main-switcher', 'recent-updates', 'recent-update-card', 'dev-qv-container', 'filter by date', 'two different style'];

for (const term of terms) {
  console.log(`\n=== Searching for "${term}" ===`);
  for (const c of commits) {
    try {
      const res = cp.execSync(`git grep -n -i "${term}" ${c}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      if (res.trim()) {
        console.log(`Commit ${c.slice(0, 7)}:`, res.trim().split('\n')[0]);
      }
    } catch (e) {}
  }
}
