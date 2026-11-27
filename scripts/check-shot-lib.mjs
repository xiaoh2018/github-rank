// 门禁：截图管线（scripts/lib/cdp.mjs 的 shot()）能真的产出 PNG
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shot, runner } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shot-')), 'home.png');
const W = Number(process.env.W || 1024);
const res = await shot({ url: BASE + '/?cb=' + Date.now(), out, width: W, height: 900, waitMs: 1800 });

const buf = fs.readFileSync(out);
push('shot() 产出了文件', fs.existsSync(out) && buf.length > 0, out);
push('文件是 PNG（magic 89 50 4E 47）', buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
  [...buf.slice(0, 4)].map((b) => b.toString(16)).join(' '));
push('截图不是空白（> 10KB）', buf.length > 10 * 1024, Math.round(buf.length / 1024) + 'KB');
push('返回的尺寸与请求一致', res.width === W, res.width + 'x' + res.height);
try { fs.rmSync(path.dirname(out), { recursive: true, force: true }); } catch { }

const bad = runner(rows);
process.exit(bad === 0 ? 0 : 1);