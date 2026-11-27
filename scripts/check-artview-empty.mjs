// 门禁：SPA 文章视图的空态要把「为什么空」和「怎么回去」说清楚
import { openCdp, runner } from './lib/cdp.mjs';

const base = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

const cdp = await openCdp({ width: Number(process.env.W || 1440), height: 1000 });
await cdp.init();
await cdp.goto(base + '/?page=articles&cb=' + Date.now(), 2200);
const js = cdp.js;

// 数据里到底有几篇、第一个分类是什么，从页面状态读，不猜
const meta = await js(`(() => {
  const box = document.querySelector('#artViewList');
  const chips = [...document.querySelectorAll('#artChips [data-artcat]')].map((b) => ({ v: b.getAttribute('data-artcat'), t: b.textContent.trim() }));
  return { cards: box ? box.querySelectorAll('.artcard').length : -1, chips };
})()`);
push('文章视图有卡片、有分类胶囊', meta && meta.cards > 0 && meta.chips.length > 1, JSON.stringify(meta && { cards: meta.cards, chips: meta.chips.map((c) => c.t) }));

const cat = meta && meta.chips.find((c) => c.v !== 'all');
// 1) 只输关键词
const k1 = await js(`(() => {
  const q = document.querySelector('#artSearch');
  q.value = 'zzzz-no-such'; q.dispatchEvent(new Event('input', { bubbles: true }));
  return new Promise((r) => setTimeout(() => {
    const box = document.querySelector('#artViewList');
    const t = box.textContent.replace(/\\s+/g, ' ').trim();
    r({ cards: box.querySelectorAll('.artcard').length, txt: t,
        btns: [...box.querySelectorAll('[data-avf]')].map((b) => b.getAttribute('data-avf')) });
  }, 400));
})()`);
push('只输关键词：空态出现、卡片归零', k1 && k1.cards === 0 && /没有匹配的文章/.test(k1.txt), k1 && k1.txt.slice(0, 60));
push('说明里点到了「关键词」', /关键词「zzzz-no-such」/.test(k1.txt), '');
push('有一条「只清关键词」，没有「改回全部」', k1 && k1.btns.join(',') === 'q,all', k1 && k1.btns.join(','));

// 2) 点「只清关键词」→ 恢复
const r1 = await js(`(() => {
  document.querySelector('[data-avf="q"]').click();
  return new Promise((r) => setTimeout(() => {
    const box = document.querySelector('#artViewList');
    r({ cards: box.querySelectorAll('.artcard').length, q: document.querySelector('#artSearch').value });
  }, 400));
})()`);
push('点「只清关键词」后列表恢复、输入框清空', r1 && r1.cards > 0 && r1.q === '', JSON.stringify(r1));

// 3) 关键词 + 分类同时命中零结果
const k2 = await js(`(() => {
  const q = document.querySelector('#artSearch');
  q.value = 'zzzz-no-such'; q.dispatchEvent(new Event('input', { bubbles: true }));
  const chip = document.querySelector('#artChips [data-artcat="${cat ? cat.v : 'all'}"]');
  if (chip) chip.click();
  return new Promise((r) => setTimeout(() => {
    const box = document.querySelector('#artViewList');
    const t = box.textContent.replace(/\\s+/g, ' ').trim();
    r({ cards: box.querySelectorAll('.artcard').length, txt: t,
        btns: [...box.querySelectorAll('[data-avf]')].map((b) => b.getAttribute('data-avf')) });
  }, 400));
})()`);
push('关键词+分类都为 0 时仍显示空态', k2 && k2.cards === 0 && /没有匹配的文章/.test(k2.txt), '');
push('说明里两个条件都点到', /分类「/.test(k2.txt) && /关键词「/.test(k2.txt), k2 && k2.txt.slice(0, 80));
push('三个出口都在（清关键词 / 改回全部 / 清空全部）', k2 && k2.btns.join(',') === 'q,cat,all', k2 && k2.btns.join(','));

// 4) 点「清空全部筛选」→ 全恢复、胶囊回到「全部」
const r2 = await js(`(() => {
  document.querySelector('[data-avf="all"]').click();
  return new Promise((r) => setTimeout(() => {
    const box = document.querySelector('#artViewList');
    const on = document.querySelector('#artChips .chip.is-on');
    r({ cards: box.querySelectorAll('.artcard').length, q: document.querySelector('#artSearch').value,
        onCat: on ? on.getAttribute('data-artcat') : null });
  }, 400));
})()`);
push('点「清空全部筛选」后：卡片回来、输入框空、分类回「全部」',
  r2 && r2.cards > 0 && r2.q === '' && r2.onCat === 'all', JSON.stringify(r2));

// 5) 窄屏不溢出
const of = await js(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
push('不横向溢出', of && of.sw === of.cw, JSON.stringify(of));

await cdp.close();
const bad = runner(rows);
process.exit(bad === 0 ? 0 : 1);