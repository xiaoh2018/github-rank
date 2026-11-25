import fs from 'node:fs';
const p='worker.js';
let raw=fs.readFileSync(p,'utf8'); const crlf=/\r\n/.test(raw); let s=raw.replace(/\r\n/g,'\n');
const find = `      html = html.replace(/(["'])(\\/js\\/[\\w.-]+\\.js)(["'])/g, function (m, q1, p1, q2) {
        return q1 + p1 + '?v=' + ASSET_V + q2;
      });`;
const n=s.split(find).length-1; console.log('hits='+n);
if(n!==1) throw new Error('anchor');
s=s.replace(find,()=>`      html = html.replace(/(["'])(\\/?js\\/[\\w.-]+\\.js)(["'])/g, function (m, q1, p1, q2) {
        return q1 + p1 + '?v=' + ASSET_V + q2;
      });`);
fs.writeFileSync(p, crlf ? s.split('\n').join('\r\n') : s,'utf8');
console.log('patched');
