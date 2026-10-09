import fs from 'node:fs';
import vm from 'node:vm';

const file = 'C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/public/app.js';
const code = fs.readFileSync(file, 'utf8');
// Classic script context: duplicate function declarations are legal here, which
// is exactly how the browser loads this file.
new vm.Script(code, { filename: 'app.js' });
console.log('app.js parses as a classic script: OK');

const html = fs.readFileSync('C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/public/index.html', 'utf8');
console.log('index.html has "Website Sheet" header:', /<th>Website Sheet<\/th>/.test(html));
const th = (html.match(/<th/g) || []).length;
console.log('index.html <th> count:', th);
