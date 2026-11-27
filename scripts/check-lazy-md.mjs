// 门禁：md.js 是否真的按需加载
// 用共享 CDP 启动器（scripts/lib/cdp.mjs）—— 这段样板以前在 120 个门禁里各复制一份。
import fs from 'node:fs';
import { openCdp, runner } from './lib/cdp.mjs';

const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 900);
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

const src = fs.readFileSync('index.html', 'utf8');
push('首页不再急加载 md.js', !/<script[^>]+src="\/?js\/md\.js"/.test(src), '');
push('源码里有 ensureMd() 按需加载', src.includes('function ensureMd()') && src.includes("el.src = '/js/md.js'"), '');

const hits = [];
const cdp = await openCdp({ width: W, height: H, onEvent: (m) => { if (m.method === 'Network.requestWillBeSent') hits.push(m.params.request.url); } });
const mdCount = () => hits.filter((u) => /\/js\/md\.js/.test(u)).length;

try {
  await cdp.init();
  hits.length = 0;
  await cdp.goto(BASE + '/?page=articles&cb=' + Date.now(), 2000);
  push('首屏（文章视图）不请求 md.js', mdCount() === 0, 'md.js 请求 ' + mdCount() + ' 次');
  push('首屏 window.KeeMd 未定义（确实没加载）', (await cdp.js('typeof window.KeeMd')) === 'undefined', await cdp.js('typeof window.KeeMd'));

  const opened = await cdp.js(`(async function(){
    var arts = [];
    try { arts = await (await fetch('/data/articles.json?cb=' + Date.now())).json(); } catch (e) { arts = []; }
    if (!Array.isArray(arts)) arts = [];
    var target = arts.filter(function(it){ return String(it.body||'').length > 0; })[0];
    if (!target) return 'no-article-with-body';
    var cards = Array.prototype.slice.call(document.querySelectorAll('.artcard'));
    var hit = cards.filter(function(c){
      return (c.querySelector('h3')||{textContent:''}).textContent.trim() === String(target.title||'').trim();
    })[0];
    var a = hit ? hit.querySelector('a[data-artpost]') : null;
    if (!a) return 'no-card-for-target';
    a.click();
    return 'clicked:' + target.title;
  })()`);
  await sleep(1400);
  push('点开的是有正文的那篇（按数据挑，不猜）', String(opened).indexOf('clicked:') === 0, opened);
  push('点开文章后触发 md.js 加载', mdCount() >= 1, 'md.js 请求 ' + mdCount() + ' 次');
  push('md.js 到位后 KeeMd 可用', ['object', 'function'].includes(await cdp.js('typeof window.KeeMd')), await cdp.js('typeof window.KeeMd'));

  const body = await cdp.js(`(function(){ var b=document.querySelector('#artDlg .adl-body'); return b ? { html: b.innerHTML.slice(0,60), hasH: /<h[2-4]/.test(b.innerHTML), busy: b.getAttribute('aria-busy') } : null; })()`);
  push('弹窗正文已渲染成 HTML（不是纯文本）', !!(body && body.hasH && !body.busy), JSON.stringify(body));

  hits.length = 0;
  await cdp.goto(BASE + '/articles/tech/4.html?cb=' + Date.now(), 1800);
  push('静态文章页仍直接加载 md.js（首屏就要正文）', mdCount() >= 1, 'md.js 请求 ' + mdCount() + ' 次');
  const abody = await cdp.js(`(function(){ var ab=document.querySelector('#reader .abody'); return ab ? { hasH: /<h[2-4]/.test(ab.innerHTML), len: ab.innerHTML.length } : null; })()`);
  push('静态页正文渲染正常', !!(abody && abody.hasH && abody.len > 50), JSON.stringify(abody));
  const ov = await cdp.js(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
  push('静态页不横向溢出', ov && Math.abs(ov.sw - ov.cw) <= 1, JSON.stringify(ov));
} finally {
  await cdp.close();
}

const bad = runner(rows);
console.log(bad === 0 ? 'ALL OK  @' + W + 'px' : '');
process.exit(bad === 0 ? 0 : 1);