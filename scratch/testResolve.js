import { resolveConditionalNotes } from '../src/reportUtils.js';

const rows = [
  ['a11y: https://docs.google.com/document/d/1vNak3uzHcUO9GBb4mME0vkxuqZJXwyeCBfJf8rP2fpc/edit?usp=sharing', '', '', '']
];

const notes = [
  { condition: 'a11y', message: 'Testing testing {{link:here}}', enabled: true }
];

console.log(resolveConditionalNotes(rows, notes));
