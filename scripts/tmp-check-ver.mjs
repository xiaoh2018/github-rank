import fs from 'node:fs';
const s = fs.readFileSync('worker.js', 'utf8');
const m = /ASSET_V\s*=\s*'([^']+)'/.exec(s);
console.log('local ASSET_V', m && m[1]);
const t = await (await fetch('https://github.661026.xyz/?cb=' + Date.now())).text();
const v = /js\/bundle\.js\?v=([^"']+)/.exec(t);
console.log('live asset v', v && v[1], 'len', t.length, 'has comment', t.includes('深链进来时历史里没有 art 状态'));
