import fs from 'node:fs';
const html = fs.readFileSync('articles.html', 'utf8');
const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
let m, i = 0;
while ((m = re.exec(html))) {
  i++;
  const attrs = m[1] || '';
  if (/type\s*=\s*["'][^"']*json/i.test(attrs)) {
    console.log('#' + i + ' 跳过 JSON-LD');
    continue;
  }
  try {
    new Function(m[2]);
    console.log('#' + i + ' OK (' + m[2].length + ' 字符)');
  } catch (e) {
    console.log('#' + i + ' FAIL: ' + e.message);
  }
}
console.log('bytes', Buffer.byteLength(html, 'utf8'));
