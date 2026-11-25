import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';

const backup = fs.readFileSync('data/articles.json', 'utf8');
function restore() { fs.writeFileSync('data/articles.json', backup, 'utf8'); }

function restart() {
  try {
    const out = execSync('netstat -ano | findstr :8123', { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      const m = /LISTENING\s+(\d+)/.exec(line);
      if (m) { try { execSync('taskkill /F /PID ' + m[1] + ' >nul 2>nul'); } catch (e) {} }
    }
  } catch (e) {}
}

async function main() {
  restart();
  const srv = spawn(process.execPath, ['scripts/dev-server.mjs'], { stdio: 'ignore', detached: true });
  srv.unref();
  await new Promise((r) => setTimeout(r, 2500));

  const base = 'http://127.0.0.1:8123';
  const pw = 'dev';
  const add = await fetch(base + '/api/articles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: pw, action: 'add', article: { title: 'Blog Layout Test 2026', summary: '测试 slug 与解锁提示', body: '## 标题\n\n正文内容', slug: '', unlockHint: '加微信 flyfish2026 回复「密码」获取', locked: true, password: 'abcd1234' } }),
  }).then((r) => r.json());
  console.log('add:', JSON.stringify(add).slice(0, 300));
  const list = await fetch(base + '/api/articles').then((r) => r.json());
  const art = (list.articles || []).filter(function(a){return a.title==='Blog Layout Test 2026';})[0] || {};
  console.log('slug=', art && art.slug, 'hint=', art && art.unlockHint);

  const page = await fetch(base + '/articles/' + (art && art.slug || 'x'));
  const html = await page.text();
  console.log('page status', page.status, 'len', html.length, 'hasRoot', html.includes('id="reader"'));

  const sm = await fetch(base + '/sitemap.xml').then((r) => r.text());
  console.log('sitemap has slug url:', sm.includes('/articles/' + (art && art.slug)));
  restore();
  console.log('restored data/articles.json');
  process.exit(0);
}
main().catch((e) => { restore(); console.error(e); process.exit(1); });
