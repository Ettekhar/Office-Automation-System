import { safeExternalUrl } from '../src/reportUtils.js';

const url = 'https://docs.google.com/document/d/1vNak3uzHcUO9GBb4mME0vkxuqZJXwyeCBfJf8rP2fpc/edit?usp=sharing...';
console.log('Result with ...:', safeExternalUrl(url));

const url2 = 'https://docs.google.com/document/d/1vNak3uzHcUO9GBb4mME0vkxuqZJXwyeCBfJf8rP2fpc/edit?usp=sharing';
console.log('Result without ...:', safeExternalUrl(url2));
