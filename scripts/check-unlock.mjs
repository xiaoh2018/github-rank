// 加密文章端到端：新建带锁文章 → 前台错误密码 → 正确密码 → 正文解密 → 删除。
// 这条链路（PBKDF2 + AES-GCM + /api/article）之前只手工点过一次，这里固化成门禁。
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:8123';
const PW = 'dev';
const ARTICLE_PW = 'gate-pass-123';
const TITLE = '__gate__加密文章';
const SECRET = '机密正文-XYZ-123';
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra) => { results.push({ name, ok }); console.log((ok ? 'OK    ' : 'FAIL  ') + name + (extra ? '  ' + extra : '')); };

const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
};

let artId = null;
try {
  // ---------- 1) 建一篇带锁文章 ----------
  const add = await post('/api/articles', {
    password: PW, action: 'add',
    article: { title: TITLE, body: SECRET + '\n\n第二段。', summary: '门禁用加密文章', locked: true, password: ARTICLE_PW, category: 'gate' },
  });
  const added0 = add.body && Array.isArray(add.body.articles) ? add.body.articles.filter((a) => a && a.title === TITLE)[0] : null;
  artId = added0 ? added0.id : null;
  const added = add.status === 200 && add.body && add.body.ok === true && !!artId;
  check('新建加密文章', added, `status=${add.status} id=${artId}${add.body && add.body.error ? ' err=' + add.body.error : ''}`);

  const listed = await fetch(BASE + '/data/articles.json?v=' + Date.now()).then((r) => r.json()).catch(() => null);
  const hit = Array.isArray(listed) ? listed.find((a) => a && String(a.id) === String(artId)) : null;
  check('公开列表里能看到它但没有正文', !!hit && !hit.body && hit.locked === true, hit ? `locked=${hit.locked} 有正文=${!!hit.body}` : '列表里没有');

  if (added) {
    // ---------- 2) 浏览器里解锁 ----------
    const port = 9500 + Math.floor(Math.random() * 90);
    const dir = 'C:\\Windows\\Temp\\cdpunlock' + Date.now();
    const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + port, '--user-data-dir=' + dir, '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
    let target = null;
    for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); target = l.find((t) => t.type === 'page'); } catch (e) {} }
    if (!target) throw new Error('headless Chrome 10 秒内没起来（端口 ' + port + '）');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0; const waiting = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
    await new Promise((r) => ws.addEventListener('open', r));
    const send = (m, p) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : null; };
    try {
      await send('Page.enable'); await send('Runtime.enable');
      await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await send('Page.navigate', { url: BASE + '/articles' });
      await sleep(3000);
      const click = await ev("(function(){var cs=document.querySelectorAll('#cards .acard'); for(var i=0;i<cs.length;i++){ if((cs[i].textContent||'').indexOf(" + JSON.stringify(TITLE) + ")>=0){ cs[i].click(); return 'hit'; } } return 'miss';})()");
      await sleep(1200);
      const opened = await ev("!!document.getElementById('pwDlg') && document.getElementById('pwDlg').open === true");
      check('点加锁文章弹出密码框', click === 'hit' && opened === true, `卡片命中=${click}`);

      await ev("(function(){document.getElementById('pwIn').value='wrong-pw'; document.getElementById('pwGo').click(); return 'ok';})()");
      await sleep(2500);
      const errText = await ev("(document.getElementById('pwErr')||{}).textContent || ''");
      const stillOpen = await ev("document.getElementById('pwDlg').open === true");
      check('错误密码留在弹窗并提示', String(errText).trim().length > 0 && stillOpen === true, `提示「${String(errText).trim().slice(0, 24)}」`);

      await ev("(function(){document.getElementById('pwIn').value=" + JSON.stringify(ARTICLE_PW) + "; document.getElementById('pwGo').click(); return 'ok';})()");
      await sleep(3000);
      const okState = await ev("JSON.stringify({open: document.getElementById('pwDlg').open, body: (document.getElementById('rBody')||{}).textContent || ''})");
      const st = JSON.parse(okState);
      check('正确密码解密出正文', st.open === false && String(st.body).indexOf(SECRET) >= 0, `正文含机密=${String(st.body).indexOf(SECRET) >= 0}`);
    } finally {
      try { await send('Browser.close'); } catch (e) {}
      proc.kill();
    }
  }
} catch (e) {
  check('加密文章流程未抛异常', false, String(e && e.message).slice(0, 80));
} finally {
  if (artId) {
    const del = await post('/api/articles', { password: PW, action: 'remove', id: artId }).catch(() => null);
    const ok = del && del.body && del.body.ok === true;
    const after = await fetch(BASE + '/data/articles.json?v=' + Date.now()).then((r) => r.json()).catch(() => []);
    const gone = Array.isArray(after) && !after.some((a) => a && String(a.id) === String(artId));
    check('测试文章已清理', ok && gone, `删除=${ok} 列表已无=${gone}`);
  }
}

const bad = results.filter((r) => !r.ok);
console.log('');
if (bad.length) { console.log(bad.length + ' 项失败'); process.exit(1); }
console.log('加密文章端到端通过（' + results.length + ' 项）');
