import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8123';
const rows = [];
const push = (n, ok, extra) => rows.push({ n, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

async function session(w, h, mobile) {
  const port = 9990 + Math.floor(Math.random() * 9);
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-chip-'));
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + udd, 'about:blank'], { stdio: 'ignore' });
  const wsUrl = await (async () => {
    for (let i = 0; i < 60; i++) {
      try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); const p = l.find((t) => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch {}
      await sleep(250);
    }
    throw new Error('no chrome');
  })();
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const waits = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } });
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; waits.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' :: ' + x.slice(0, 80));
    return r.result.result ? r.result.result.value : null;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile });
  return { ws, child, send, ev };
}

// ---------- 桌面：文章视图分类胶囊 ----------
{
  const s = await session(1440, 900, false);
  await s.send('Page.navigate', { url: BASE + '/?page=articles' });
  await sleep(3000);
  const st = await s.ev(`(function(){
    var on=document.querySelector('#artChips .chip.is-on');
    var off=document.querySelector('#artChips .chip:not(.is-on)');
    if(!on||!off) return { miss:true, n:document.querySelectorAll('#artChips .chip').length };
    var co=getComputedStyle(on), cf=getComputedStyle(off);
    return {
      n: document.querySelectorAll('#artChips .chip').length,
      onRadius: co.borderTopLeftRadius, onBg: co.backgroundColor, onColor: co.color,
      offRadius: cf.borderTopLeftRadius, offBg: cf.backgroundColor, offColor: cf.color, offBorder: cf.borderTopColor,
      onH: Math.round(on.getBoundingClientRect().height), offH: Math.round(off.getBoundingClientRect().height),
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    };
  })()`);
  push('文章视图有分类胶囊', !st.miss && st.n >= 2, JSON.stringify({ n: st.n, miss: st.miss }));
  push('胶囊是圆角(≥999 或 >=18px)', parseFloat(st.onRadius) >= 18 && parseFloat(st.offRadius) >= 18, st.onRadius + ' / ' + st.offRadius);
  push('选中项实心（背景不等于未选中底色）', st.onBg !== st.offBg, st.onBg + ' vs ' + st.offBg);
  push('选中项文字为白色', /255,\s*255,\s*255/.test(st.onColor), st.onColor);
  push('未选中项是浅底+描边', st.offBg !== 'rgba(0, 0, 0, 0)' && st.offBorder !== 'rgba(0, 0, 0, 0)', st.offBg + ' / ' + st.offBorder);
  push('胶囊高度 28–44px 之间', st.onH >= 28 && st.onH <= 44, st.onH + 'px');

  // hover 描边变主色
  const rect = await s.ev(`(function(){var r=document.querySelector('#artChips .chip:not(.is-on)').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, buttons: 0 });
  await sleep(120);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + 3, y: rect.y + 3, buttons: 0 });
  await sleep(300);
  const hov = await s.ev(`(function(){
    var el=document.querySelector('#artChips .chip:not(.is-on)');
    var c=getComputedStyle(el);
    return { hovered: el.matches(':hover'), color: c.color, border: c.borderTopColor };
  })()`);
  push('未选中胶囊 hover 有反馈（描边/文字变主色）', hov.hovered === true && hov.border !== st.offBorder, JSON.stringify(hov));

  // 点第二个分类 → 选中态转移且只有一个
  await s.ev(`(function(){ var b=document.querySelectorAll('#artChips .chip')[1]; if(b) b.click(); return 1; })()`);
  await sleep(400);
  const sel = await s.ev(`(function(){
    var all=document.querySelectorAll('#artChips .chip');
    var ons=document.querySelectorAll('#artChips .chip.is-on');
    return { total: all.length, ons: ons.length, txt: ons.length?ons[0].textContent.trim():'' };
  })()`);
  push('点分类后选中态唯一且切换', sel.ons === 1, JSON.stringify(sel));
  s.ws.close(); try { s.child.kill(); } catch {}
}

// ---------- 问答视图 ----------
{
  const s = await session(1440, 900, false);
  await s.send('Page.navigate', { url: BASE + '/?page=faq' });
  await sleep(3000);
  const st = await s.ev(`(function(){
    var on=document.querySelector('#faqChips .chip.is-on');
    var n=document.querySelectorAll('#faqChips .chip').length;
    if(!on) return { miss:true, n:n };
    var c=getComputedStyle(on);
    return { n:n, radius:c.borderTopLeftRadius, bg:c.backgroundColor, color:c.color, h:Math.round(on.getBoundingClientRect().height) };
  })()`);
  push('问答视图胶囊套用同一套样式', !st.miss && parseFloat(st.radius) >= 18 && /255,\s*255,\s*255/.test(st.color), JSON.stringify(st));
  await s.ev(`(function(){ var b=document.querySelectorAll('#faqChips .chip')[1]; if(b) b.click(); return 1; })()`);
  await sleep(300);
  const after = await s.ev(`(function(){ var ons=document.querySelectorAll('#faqChips .chip.is-on'); return {ons:ons.length, txt:ons.length?ons[0].textContent.trim():''}; })()`);
  push('问答标签可切换且选中唯一', after.ons === 1, JSON.stringify(after));
  s.ws.close(); try { s.child.kill(); } catch {}
}

// ---------- 320：单行横滚 + 右缘渐隐 ----------
{
  const s = await session(320, 720, true);
  await s.send('Page.navigate', { url: BASE + '/?page=faq' });
  await sleep(3000);
  const m = await s.ev(`(function(){
    var box=document.getElementById('faqChips');
    var cs=getComputedStyle(box);
    var chips=box.querySelectorAll('.chip');
    var tops=[];
    chips.forEach(function(c){ tops.push(Math.round(c.getBoundingClientRect().top)); });
    var uniq=[]; tops.forEach(function(t){ if(uniq.indexOf(t)<0) uniq.push(t); });
    return {
      flexWrap: cs.flexWrap, overflowX: cs.overflowX, mask: cs.maskImage || cs.webkitMaskImage,
      sw: box.scrollWidth, cw: box.clientWidth, rows: uniq.length,
      chipH: chips.length?Math.round(chips[0].getBoundingClientRect().height):0
    };
  })()`);
  push('320 胶囊单行不换行', m.flexWrap === 'nowrap' && m.rows === 1, JSON.stringify(m));
  push('320 溢出时可横滚', m.overflowX === 'auto', m.sw + ' / ' + m.cw);
  // 不溢出时不该有渐隐（否则右边缘永远像被截断）；溢出时必须有
  const noOverflow = m.sw <= m.cw + 1;
  const maskOk = noOverflow ? String(m.mask) === 'none' : String(m.mask).indexOf('linear-gradient') >= 0;
  push(noOverflow ? '320 不溢出时没有多余渐隐' : '320 溢出时有右缘渐隐', maskOk, 'sw=' + m.sw + ' cw=' + m.cw + ' mask=' + String(m.mask).slice(0, 40));
  push('320 胶囊触控高度 ≥36', m.chipH >= 36, m.chipH + 'px');

  // 造真溢出：塞 4 个超长胶囊，验证渐隐与 x-end
  const wide = await s.ev(`(function(){
    var box=document.getElementById('faqChips');
    for(var i=0;i<4;i++){ var b=document.createElement('button'); b.type='button'; b.className='chip'; b.textContent='这是一个很长的分类名'+(i+1); box.appendChild(b); }
    if(window.__paintChipsForTest) window.__paintChipsForTest(box);
    box.dispatchEvent(new Event('scroll'));
    var cs=getComputedStyle(box);
    return { sw: box.scrollWidth, cw: box.clientWidth, mask: cs.maskImage || cs.webkitMaskImage, xEnd: box.classList.contains('x-end') };
  })()`);
  push('塞满后确实溢出且有右缘渐隐', wide.sw > wide.cw && String(wide.mask).indexOf('linear-gradient') >= 0, 'sw=' + wide.sw + ' cw=' + wide.cw + ' xEnd=' + wide.xEnd);
  s.ws.close(); try { s.child.kill(); } catch {}
}

const bad = rows.filter((r) => !r.ok);
for (const r of rows) console.log((r.ok ? 'OK  ' : 'FAIL') + ' ' + r.n + (r.extra ? ' → ' + r.extra : ''));
console.log(bad.length ? `\n${bad.length} FAILED / ${rows.length}` : `\nALL OK (${rows.length})`);
process.exit(bad.length ? 1 : 0);
