// 提交失败要说清「原因 + 下一步 + 能不能只重试这一项」
// 本地：node scripts/check-submit-diag.mjs（离线验映射 + 真浏览器验渲染）
// 线上：PROBE_BASE=https://github.661026.xyz node scripts/check-submit-diag.mjs（只跑 UI 段）
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openCdp } from './lib/cdp.mjs';

const BASE = (process.env.PROBE_BASE || 'http://127.0.0.1:8123').replace(/\/+$/, '');
const PW = process.env.ADMIN_PW || 'dev';
const REMOTE = !!process.env.PROBE_BASE;
let bad = 0;
const rows = [];
const ok = (name, cond, detail) => {
  rows.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
  if (!cond) bad++;
};

if (!REMOTE) {
  // worker.js 在模块作用域就取 caches.default，Node 里要先给个桩（不碰网络）
  const store = new Map();
  const keyOf = (k) => String(k && k.url ? k.url : k);
  globalThis.caches = {
    default: {
      match: async (k) => store.get(keyOf(k)),
      put: async (k, v) => { store.set(keyOf(k), v); },
      delete: async (k) => { const key = keyOf(k); const had = store.has(key); store.delete(key); return had; },
    },
  };

  // 1) 映射本身：不联网，直接问 worker 里的纯函数
  const mod = await import(pathToFileURL(path.resolve('worker.js')).href);
  const diag = mod.default && mod.default.__diag;
  ok('worker 暴露了 __diag（纯映射函数）', typeof diag === 'function', typeof diag);
  if (typeof diag === 'function') {
    const D = (key, r) => diag(key, r) || {};
    const i202 = D('indexNow', { ok: true, status: 202 });
    ok('IndexNow 收下 → ok 级', i202.level === 'ok', i202.level);
    const i429 = D('indexNow', { ok: false, status: 429 });
    ok('429 → 警告级 + 可重试', i429.level === 'warn' && i429.retry === true, JSON.stringify({ l: i429.level, r: i429.retry }));
    ok('429 的下一步是「等 10 分钟」', /10 分钟/.test(i429.next || ''), i429.next);
    const i422 = D('indexNow', { ok: false, status: 422 });
    ok('422 提到 key 校验', /key/i.test(i422.reason || ''), i422.reason);
    const i0 = D('indexNow', { ok: false, status: 0 });
    ok('连不上 → 失败级但可重试', i0.level === 'fail' && i0.retry === true, JSON.stringify({ l: i0.level, r: i0.retry }));
    const iSkip = D('indexNow', { ok: false, skipped: true, status: 0 });
    ok('同批跳过 → 警告级', iSkip.level === 'warn', iSkip.level);

    const bNoTok = D('baidu', { ok: false, status: 0, note: '没填百度准入密钥：请在后台填写，或配置 BAIDU_TOKEN' });
    ok('百度没配密钥 → 失败级', bNoTok.level === 'fail', bNoTok.level);
    ok('百度没配密钥 → 不可重试（重试也没用）', bNoTok.retry === false, bNoTok.retry);
    ok('百度没配密钥 → 指到填密钥的地方', /翻译与密钥|BAIDU_TOKEN/.test(bNoTok.next || ''), bNoTok.next);
    const b401 = D('baidu', { ok: false, status: 0, note: '百度返回错误码 401' });
    ok('百度错误码 401 → 说「准入密钥不对」', /准入密钥/.test(b401.reason || ''), b401.reason);
    const b402 = D('baidu', { ok: false, status: 0, note: '百度返回 HTTP 502' });
    ok('其他状态也有话说（不是空白）', !!(b402.reason && b402.next), JSON.stringify({ r: b402.reason, n: b402.next }));
    ok('未知平台 → null（不瞎猜）', diag('nope', { ok: true, status: 200 }) === null, '');
  }

  // 2) 鉴权仍然在最前面
  const wrong = await fetch(BASE + '/api/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'nope', action: 'baidu' }),
  });
  ok('口令错 → 403（诊断不绕过鉴权）', wrong.status === 403, wrong.status);
}

// 3) 后台渲染：注入一份「429 限流 + 百度不可重试」，验文案与「只重试」
{
  let captured = null;
  const cdp = await openCdp({
    width: 1440,
    height: 900,
    onEvent: (m) => {
      if (m.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = m.params;
      if (request.method === 'POST') {
        captured = request.postData || '';
        const body = JSON.stringify({ ok: true, urls: 0, root: 'https://example.test', results: {} });
        cdp
          .send('Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'application/json' }],
            body: Buffer.from(body).toString('base64'),
          })
          .catch(() => {});
      } else {
        cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
      }
    },
  });
  try {
    await cdp.send('Page.navigate', { url: BASE + '/admin' });
    await new Promise((r) => setTimeout(r, 1200));
    await cdp.js(`sessionStorage.setItem('adminPw', ${JSON.stringify(PW)}); 'ok'`);
    await cdp.js('location.reload()');
    await new Promise((r) => setTimeout(r, 2500));
    const opened = await cdp.js(`(function(){
      var side=document.querySelector('.side');
      if(side){var n=side.querySelector('[data-tab="submit"]');if(n)n.click();}
      var p=document.getElementById('pane-submit');
      return p? getComputedStyle(p).display : 'none';
    })()`);
    ok('收录与平台面板能打开', opened !== 'none', opened);

    const hasRender = await cdp.js(`typeof window.__subRender === 'function'`);
    ok('页面暴露了 __subRender（渲染入口）', hasRender === true, hasRender);

    const fake = {
      urls: 3,
      root: 'https://example.test',
      summary: { ok: 0, warn: 1, fail: 1, retriable: 1 },
      results: {
        indexNow: {
          ok: false,
          status: 429,
          ms: 120,
          note: '429 请求过多',
          diag: {
            level: 'warn',
            reason: '被限流了（同一批地址推得太勤）',
            next: '等 10 分钟再点「只推 IndexNow」；重复批次本站会自动跳过',
            retry: true,
          },
        },
        baidu: {
          ok: false,
          status: 0,
          note: '没填百度准入密钥',
          diag: { level: 'fail', reason: '没填百度准入密钥', next: '去「翻译与密钥」填准入密钥', retry: false },
        },
      },
    };
    const injected = await cdp.js(`window.__subRender(${JSON.stringify(fake)})`);
    ok('假结果能渲染进结果区', injected === true, injected);
    await new Promise((r) => setTimeout(r, 300));

    const box = await cdp.js(`(function(){ var b=document.getElementById('subOut'); return b? b.textContent : ''; })()`);
    ok('渲染出「原因」与「下一步」', /原因/.test(box) && /下一步/.test(box), String(box).slice(0, 30));
    ok('429 的原因写着「限流」', /限流/.test(box), '');
    ok('下一步写着「10 分钟」', /10 分钟/.test(box), '');
    ok('总览写明几项失败、几项可重试', /1 项失败/.test(box) && /只重试/.test(box), String(box).match(/本次提交[\s\S]{0,80}/) || '');

    const btns = await cdp.js(`(function(){
      var o=document.getElementById('subOut');
      if(!o) return 'no-out';
      var a=o.querySelectorAll('[data-subretry]');
      return a.length + '|' + Array.prototype.map.call(a,function(b){return b.getAttribute('data-subretry')}).join(',');
    })()`);
    ok('限流那项有「只重试这一项」按钮', /indexnow/.test(String(btns)), btns);
    ok('不可重试的百度项没有重试按钮', !/baidu/.test(String(btns)), btns);

    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/submit*', requestStage: 'Request' }] });
    await cdp.js(`(function(){ var b=document.querySelector('#subOut [data-subretry="indexnow"]'); if(b) b.click(); return !!b; })()`);
    await new Promise((r) => setTimeout(r, 900));
    let act = '';
    try {
      act = JSON.parse(captured || '{}').action || '';
    } catch {}
    ok('点重试只推 indexnow（不是整批）', act === 'indexnow', act || captured);
  } finally {
    await cdp.close();
  }
}

for (const r of rows) console.log((r.ok ? '  OK   ' : '  FAIL ') + r.name + (r.detail ? '  → ' + r.detail : ''));
console.log(bad ? `\n${bad} FAILED of ${rows.length}` : `\nALL OK (${rows.length})  @${BASE}`);
process.exit(bad ? 1 : 0);