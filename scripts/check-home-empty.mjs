// 门禁：首页列表的空态要说清「为什么空」并给出出口
import { openCdp, runner } from './lib/cdp.mjs';

const base = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

const cdp = await openCdp({ width: Number(process.env.W || 1440), height: 1000 });
await cdp.init();
await cdp.goto(base + '/?cb=' + Date.now(), 2600);
const js = cdp.js;
const snap = `(() => {
  const li = document.querySelector('#list .empty-item');
  const on = document.querySelector('#cats .cat.on');
  return {
    items: document.querySelectorAll('#list .item:not(.ad-inline):not(.empty-item)').length,
    empty: !!li,
    hint: li ? (li.querySelector('.hint') || {}).textContent.replace(/\\s+/g, ' ').trim() : '',
    btns: li ? [...li.querySelectorAll('button')].map((b) => b.textContent.trim()) : [],
    q: (document.querySelector('#q') || {}).value,
    onCat: on ? on.textContent.trim() : '',
    pressedAll: (document.querySelector('#cats .cat[data-cat=""]') || {}).getAttribute ? document.querySelector('#cats .cat[data-cat=""]').getAttribute('aria-pressed') : '',
  };
})()`;

const s0 = await js(snap);
push('初始有列表项、无空态、分类在「全部」', s0 && s0.items > 0 && !s0.empty && s0.pressedAll === 'true', JSON.stringify({ items: s0.items, on: s0.onCat }));

// 先选一个分类（有数据），再输一个必然命不中的关键词
const cat = await js(`(() => {
  const chip = [...document.querySelectorAll('#cats .cat')].find((c) => c.getAttribute('data-cat'));
  if (!chip) return 'no chip';
  chip.click();
  return chip.textContent.trim();
})()`);
await new Promise((r) => setTimeout(r, 900));
const s1 = await js(snap);
push('选一个分类后仍有列表项', s1 && s1.items > 0, JSON.stringify({ items: s1.items, on: s1.onCat }));
push('选中的分类显示为「按下」', s1 && s1.onCat === cat, s1 && s1.onCat);

await js(`(() => { const q = document.querySelector('#q'); q.value = 'zzzz-no-such'; q.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
await new Promise((r) => setTimeout(r, 800));
const s2 = await js(snap);
push('关键词命不中 → 出现空态、列表归零', s2 && s2.empty && s2.items === 0, JSON.stringify({ empty: s2.empty, items: s2.items }));
push('空态同时写出「分类」与「关键词」，且分类用中文名不是内部 key',
  s2.hint.includes('分类「' + cat + '」') && /关键词「zzzz-no-such」/.test(s2.hint), s2.hint);
push('空态写出总项目数', /这次抓到的 \d+ 个项目/.test(s2.hint), '');
push('两个出口：只清关键词 / 清空全部筛选', s2.btns.join(',') === '只清关键词,清空全部筛选', s2.btns.join(','));

// 只清关键词：列表回来，但分类还在
await js(`(() => { [...document.querySelectorAll('#list .empty-item button')].find((b) => b.textContent.trim() === '只清关键词').click(); return 1; })()`);
await new Promise((r) => setTimeout(r, 900));
const s3 = await js(snap);
push('点「只清关键词」→ 列表恢复、输入框空、分类仍选中', s3 && s3.items > 0 && s3.q === '' && s3.onCat === cat, JSON.stringify({ items: s3.items, q: s3.q, on: s3.onCat }));

// 再来一次，点「清空全部筛选」
await js(`(() => { const q = document.querySelector('#q'); q.value = 'zzzz-no-such'; q.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
await new Promise((r) => setTimeout(r, 800));
const clickedAll = await js(`(() => { const b = [...document.querySelectorAll('#list .empty-item button')].find((x) => x.textContent.trim() === '清空全部筛选'); if (!b) return 'no'; b.click(); return 'ok'; })()`);
await new Promise((r) => setTimeout(r, 900));
const s4 = await js(snap);
push('点「清空全部筛选」→ 列表恢复、输入框空、分类回「全部」',
  clickedAll === 'ok' && s4.items > 0 && s4.q === '' && s4.pressedAll === 'true', JSON.stringify({ items: s4.items, q: s4.q, on: s4.onCat }));

const of = await js(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
push('不横向溢出', of && of.sw === of.cw, JSON.stringify(of));

await cdp.close();
const bad = runner(rows);
process.exit(bad === 0 ? 0 : 1);