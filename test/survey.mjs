#!/usr/bin/env node
/**
 * 普查：把本机能找到的 WE 场景逐个渲染一遍，汇总「成功 / 空白帧 / 降级原因 / 耗时」。
 *
 * 与 smoke.mjs 的分工：
 *   smoke.mjs   —— 单场景冒烟，CI 门禁（拿不到场景就 SKIP，不假红）。
 *   survey.mjs  —— 全库普查，输出人读表格 + 机器可读 JSON，用于「本机现状」取证。
 *
 * 用法：
 *   node test/survey.mjs                        # 自动找场景，480x270，t=2.5
 *   node test/survey.mjs --w 960 --h 540 --t 5
 *   node test/survey.mjs --out report.json      # 额外写 JSON
 *   node test/survey.mjs --gpu                  # 效果链走 WebGL
 *   node test/survey.mjs --strict               # 有空白帧/失败时退出码 1
 *
 * 场景来源（按顺序）：
 *   1) WE_SF_SCENE          scene.pkg 路径或场景目录（单个）
 *   2) WE_SF_WORKSHOP_ROOT  其下的 <id>/scene.pkg（全库）
 *   3) 常见 Steam 库路径下的 steamapps/workshop/content/431960
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SceneRenderer, encodePng } from '../src/scene-renderer.js';
import { locateWeAssets } from '../src/render.js';

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = { w: 480, h: 270, t: 2.5, gpu: false, out: null, strict: false, json: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--w' || a === '--width') opt.w = Number(next());
  else if (a === '--h' || a === '--height') opt.h = Number(next());
  else if (a === '--t' || a === '--time') opt.t = Number(next());
  else if (a === '--out') opt.out = next();
  else if (a === '--gpu') opt.gpu = true;
  else if (a === '--strict') opt.strict = true;
  else if (a === '--json') opt.json = true;
  else if (a === '-h' || a === '--help') {
    process.stdout.write('用法: node test/survey.mjs [--w N] [--h N] [--t S] [--gpu] [--out report.json] [--strict] [--json]\n');
    process.exit(0);
  } else { process.stderr.write('未知参数: ' + a + '\n'); process.exit(2); }
}

/** 场景发现（与 smoke.mjs 同一套来源，Windows 盘符只是候选之一）。 */
function findScenes() {
  const single = process.env.WE_SF_SCENE;
  if (single && existsSync(single)) return [single];
  const roots = [];
  if (process.env.WE_SF_WORKSHOP_ROOT) roots.push(process.env.WE_SF_WORKSHOP_ROOT);
  for (const d of ['C', 'D', 'E', 'F', 'G']) roots.push(`${d}:\\SteamLibrary`, `${d}:\\Steam`);
  const out = [];
  for (const r of roots) {
    const base = process.env.WE_SF_WORKSHOP_ROOT ? r : join(r, 'steamapps', 'workshop', 'content', '431960');
    if (!existsSync(base)) continue;
    for (const id of readdirSync(base)) {
      const p = join(base, id, 'scene.pkg');
      if (existsSync(p) && statSync(p).size > 4096) out.push(p);
    }
    if (out.length && !process.env.WE_SF_WORKSHOP_ROOT) continue; // 命中一个 Steam 库就够
  }
  return out;
}

/** 空白帧判定：抽样统计亮度分布 + 纯黑占比 + 颜色种类数。 */
function frameStats(rgba, w, h) {
  let min = 255, max = 0, sum = 0;
  const colors = new Map();
  const step = 53; // 质数步长，避免与常见行宽共振
  let n = 0;
  for (let i = 0; i < w * h; i += step) {
    const o = i * 4;
    const lum = (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
    sum += lum;
    n++;
    const key = rgba[o] + ',' + rgba[o + 1] + ',' + rgba[o + 2];
    colors.set(key, (colors.get(key) || 0) + 1);
  }
  const top = [...colors.entries()].sort((a, b) => b[1] - a[1])[0] || ['-', 0];
  const blackShare = top[0] === '0,0,0' ? top[1] / n : 0;
  return {
    mean: +(sum / n).toFixed(1),
    min: Math.round(min), max: Math.round(max),
    colors: colors.size,
    blackShare: +blackShare.toFixed(3),
    blank: blackShare > 0.95 || colors.size <= 4,
  };
}

const scenes = findScenes();
if (!scenes.length) {
  console.log('SKIP: 未找到本地 WE 场景（设 WE_SF_SCENE=<scene.pkg> 或 WE_SF_WORKSHOP_ROOT=<.../431960> 后重跑）');
  process.exit(0);
}
const weAssets = locateWeAssets();
if (!weAssets) console.log('⚠ 未定位到 WE assets（效果链会退化）——可用 WE_ASSETS=<WE>/assets 指定\n');

const rows = [];
for (const pkg of scenes) {
  const id = pkg.split(/[\\/]/).slice(-2)[0];
  const notes = [];
  const rec = { id, pkg, sizeMB: +(statSync(pkg).size / 1048576).toFixed(1) };
  const t0 = Date.now();
  try {
    const renderer = new SceneRenderer(pkg, {
      width: opt.w, height: opt.h, time: opt.t,
      weAssetsDir: weAssets, gpuAccel: opt.gpu,
      log: (m) => {
        const s = String(m);
        // 只留"会让画面与官方不一致"的那几类，避免刷屏
        if (/失败|跳过|回退|降级|不可用|无法|missing|cannot/.test(s)) notes.push(s.slice(0, 160));
      },
      onDegraded: (d) => notes.push(`degraded: ${d.feature} — ${d.action}`.slice(0, 160)),
    });
    const cv = renderer.render();
    const png = encodePng(cv.w, cv.h, cv.data);
    Object.assign(rec, frameStats(cv.data, cv.w, cv.h), {
      ok: true, ms: Date.now() - t0, pngKB: +(png.length / 1024).toFixed(1),
    });
  } catch (e) {
    rec.ok = false;
    rec.ms = Date.now() - t0;
    rec.error = String(e && e.message ? e.message : e).slice(0, 200);
  }
  rec.notes = [...new Set(notes)];
  rec.videoTex = rec.notes.some((n) => /video texture|embedded mp4/i.test(n));
  rows.push(rec);
  const tag = !rec.ok ? 'FAIL ' : rec.blank ? 'BLANK' : '  OK ';
  console.log(`${tag} ${String(rec.id).padStart(10)} ${String(rec.sizeMB).padStart(6)}MB ${String(rec.ms).padStart(6)}ms`
    + ` png=${String(rec.pngKB ?? '-').padStart(8)}KB mean=${String(rec.mean ?? '-').padStart(6)}`
    + ` colors=${String(rec.colors ?? '-').padStart(5)}${rec.videoTex ? ' [video-tex]' : ''}`
    + (rec.error ? ' ERR=' + rec.error : '')
    + (rec.ok && !rec.blank && rec.notes.length ? ` (降级 ${rec.notes.length} 条)` : ''));
}
for (const r of rows) {
  if (r.notes && r.notes.length && !opt.json) for (const n of r.notes) console.log(`      · [${r.id}] ${n}`);
}

const ok = rows.filter((r) => r.ok).length;
const blank = rows.filter((r) => r.blank).length;
const degraded = rows.filter((r) => r.ok && r.notes && r.notes.length).length;
console.log(`\n合计 ${rows.length} 场景：成功 ${ok}，失败 ${rows.length - ok}，空白帧 ${blank}，有降级记录 ${degraded}`);
if (opt.out) {
  writeFileSync(opt.out, JSON.stringify({ when: new Date().toISOString(), weAssets, opt, total: rows.length, ok, blank, degraded, rows }, null, 1));
  console.log('JSON → ' + opt.out);
}
process.exit(opt.strict && (rows.length - ok > 0 || blank > 0) ? 1 : 0);
