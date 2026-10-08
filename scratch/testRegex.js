const key = 'a11y';
const cell = 'a11y: https://docs.google.com/document/d/1vNak3uzHcUO9GBb4mME0vkxuqZJXwyeCBfJf8rP2fpc/edit?usp=sharing';
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reg = new RegExp(`^${escapeRegExp(key)}(?:\\s*:\\s*(.*))?$`, 'i');
console.log(cell.match(reg));
