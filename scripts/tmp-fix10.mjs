import fs from 'node:fs';
const p='scripts/patch-assetv.mjs';
let s=fs.readFileSync(p,'utf8');
s=s.replace("`      ttl: 86400, browser: 604800, sMaxAge: 86400, swr: 604800`","`  return { ttl: 86400, browser: 604800, sMaxAge: 86400, swr: 604800 };`");
s=s.replace("`      ttl: 86400, browser: 300, sMaxAge: 86400, swr: 604800`","`  return { ttl: 86400, browser: 300, sMaxAge: 86400, swr: 604800 };`");
fs.writeFileSync(p,s,'utf8'); console.log('anchors fixed');
