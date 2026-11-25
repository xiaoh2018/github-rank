import fs from 'node:fs';
const p='worker.js';
let raw=fs.readFileSync(p,'utf8');
const crlf=/\r\n/.test(raw);
let s=raw.replace(/\r\n/g,'\n');
function rep(label, find, repl){
  const n=s.split(find).length-1;
  if(n!==1) throw new Error(label+' hits='+n);
  s=s.replace(find,()=>repl); console.log('ok '+label);
}
rep('asset-v', `const NAV_FILE = 'data/nav.json';`,
`const NAV_FILE = 'data/nav.json';
// 静态资源版本：HTML 里的 /js/*.js 都会被加上 ?v=<这里>，于是能给浏览器一年 immutable；
// 改了前端就把它 +1（不然用户浏览器会抱着一周的旧 bundle，界面上去点了没反应）
const ASSET_V = 'v48';`);

rep('version-js', `      const html = applySeo(await r.text(), (await loadSiteRaw(env)).seo);`,
`      let html = applySeo(await r.text(), (await loadSiteRaw(env)).seo);
      html = html.replace(/(["'])(\\/js\\/[\\w.-]+\\.js)(["'])/g, function (m, q1, p1, q2) {
        return q1 + p1 + '?v=' + ASSET_V + q2;
      });`);

rep('shell-cache', `  return { ttl: 86400, browser: 604800, sMaxAge: 86400, swr: 604800 };`,
`  return { ttl: 86400, browser: 300, sMaxAge: 86400, swr: 604800 };`);

fs.writeFileSync(p, crlf ? s.split('\n').join('\r\n') : s, 'utf8');
