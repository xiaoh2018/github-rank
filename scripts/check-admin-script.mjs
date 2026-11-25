// 检查 /admin 内联脚本能否解析（模板字面量里的 \n 会被吃成换行，正则就断了）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const url = process.argv[2] || 'http://127.0.0.1:8123/admin';
const res = await fetch(url);
const html = await res.text();
const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m, i = 0, bad = 0;
while ((m = re.exec(html))) {
  i++;
  const code = m[1];
  if (!code.trim()) continue;
  const f = path.join(os.tmpdir(), `adm-inline-${i}.js`);
  fs.writeFileSync(f, code, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`#${i} OK (${code.length})`);
  } catch (e) {
    bad++;
    const msg = String(e.stderr || e.message).split('\n').slice(0, 6).join('\n');
    console.log(`#${i} FAIL (${code.length})\n${msg}`);
  }
}
console.log(bad ? `共 ${bad} 段有语法错` : '全部内联脚本可解析');