#!/usr/bin/env node
/**
 * CPU/GPU 逐效果对拍 —— 用下游决策接口（policy）把 GPU 路径的能力边界测出来。
 *
 * 做法（同一场景渲染两次）：
 *   A. `gpu:'off'`                      → CPU 参考图
 *   B. `gpu:'auto'` + 所有效果 `gpu-only` → 强制"GPU 做不了就跳过"，于是
 *      `decisions[]` 里 `backend=gpu-only` 且 `action=skip` 的条目就是
 *      **GPU 路径当前无法处理的效果清单**（reason 直接给出原因），
 *      而 action=apply 的是 GPU 能跑通的。
 *
 * 输出：人读表格 + `--out report.json`；退出码 0（这是普查工具，不是门禁）。
 *
 * 用法：
 *   node test/gpu-parity.mjs                       # 自动找场景
 *   node test/gpu-parity.mjs --only 3641860575,3655429099 --w 320 --h 180
 *   node test/gpu-parity.mjs --out parity.json
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderFrame, locateWeAssets, sampleFrame, steamRootCandidates } from '../src/render.js';

const argv = process.argv.slice(2);
const opt = { w: 320, h: 180, t: 2.5, only: null, out: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--w') opt.w = Number(next());
  else if (a === '--h') opt.h = Number(next());
  else if (a === '--t') opt.t = Number(next());
  else if (a === '--only') opt.only = String(next()).split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--out') opt.out = next();
  else if (a === '-h' || a === '--help') {
    process.stdout.write('用法: node test/gpu-parity.mjs [--w N] [--h N] [--t S] [--only id1,id2] [--out report.json]\n');
    process.exit(0);
  } else { process.stderr.write('未知参数: ' + a + '\n'); process.exit(2); }
}

function findScenes() {
  const single = process.env.WE_SF_SCENE;
  if (single && existsSync(single)) return [single];
  if (process.env.WE_SF_WORKSHOP_ROOT) {
    const base = process.env.WE_SF_WORKSHOP_ROOT;
    if (!existsSync(base)) return [];
    return readdirSync(base).map((id) => join(base, id, 'scene.pkg')).filter((p) => existsSync(p) && statSync(p).size > 4096);
  }
  const out = [];
  for (const r of steamRootCandidates()) {
    const base = join(r, 'steamapps', 'workshop', 'content', '431960');
    if (!existsSync(base)) continue;
    for (const id of readdirSync(base)) {
      const p = join(base, id, 'scene.pkg');
      if (existsSync(p) && statSync(p).size > 4096) out.push(p);
    }
    if (out.length) break;
  }
  return out;
}

let scenes = findScenes();
if (opt.only) scenes = scenes.filter((p) => opt.only.includes(p.split(/[\\/]/).slice(-2)[0]));
if (!scenes.length) { console.log('SKIP: 未找到本地 WE 场景（WE_SF_SCENE / WE_SF_WORKSHOP_ROOT）'); process.exit(0); }

const A = locateWeAssets();
if (!A) console.log('⚠ 未定位到 WE assets（效果链会退化）\n');
const base = { width: opt.w, height: opt.h, time: opt.t, weAssetsDir: A, warm: false, log: () => {} };

const rows = [];
const gpuUnsupported = new Map();   // 效果名 → 原因
for (const scene of scenes) {
  const id = scene.split(/[\\/]/).slice(-2)[0];
  const rec = { id, scene };
  try {
    const cpu = await renderFrame({ ...base, input: scene, gpu: 'off' });
    const gpu = await renderFrame({
      ...base, input: scene, gpu: 'auto',
      // 所有效果强制 gpu-only：GPU 做不了就跳过并被记录，从而"测出"GPU 能力边界
      policy: { decideBackend: () => 'gpu-only' },
    });
    const cpuPix = cpu.png.length, gpuPix = gpu.png.length;
    const skipped = gpu.decisions.items.filter((d) => d.action === 'skip' && d.backend === 'gpu-only');
    for (const d of skipped) if (!gpuUnsupported.has(d.effect)) gpuUnsupported.set(d.effect, d.reason);
    const applied = gpu.decisions.items.filter((d) => d.action === 'apply');
    rec.cpuMs = cpu.ms; rec.gpuMs = gpu.ms;
    rec.cpuKB = +(cpuPix / 1024).toFixed(1); rec.gpuKB = +(gpuPix / 1024).toFixed(1);
    rec.sameSize = cpuPix === gpuPix;
    rec.gpuState = gpu.gpuStats.state; rec.gpuUsed = gpu.gpuStats.used; rec.gpuFailed = gpu.gpuStats.failed;
    rec.effectsAppliedOnGpu = applied.length; rec.effectsGpuUnsupported = skipped.length;
    rec.unsupported = skipped.map((d) => ({ effect: d.effect, reason: d.reason }));
    rows.push(rec);
    console.log('=== ' + id + '  ' + rec.cpuMs + 'ms(cpu) / ' + rec.gpuMs + 'ms(gpu)'
      + '  png ' + rec.cpuKB + 'KB → ' + rec.gpuKB + 'KB'
      + '  gpu: state=' + rec.gpuState + ' used=' + rec.gpuUsed + ' failed=' + rec.gpuFailed
      + '  可GPU=' + rec.effectsAppliedOnGpu + ' 不可GPU=' + rec.effectsGpuUnsupported);
    for (const u of rec.unsupported) console.log('    ✗ ' + u.effect + ' — ' + String(u.reason).slice(0, 110));
  } catch (e) {
    rec.error = String(e && e.message ? e.message : e).slice(0, 200);
    rows.push(rec);
    console.log('=== ' + id + '  失败: ' + rec.error);
  }
}

console.log('\n--- GPU 路径不支持的效果汇总 ---');
if (!gpuUnsupported.size) console.log('  （无：所有被引用的效果都能走 GPU）');
for (const [name, reason] of gpuUnsupported) console.log('  · ' + name + ' — ' + String(reason).slice(0, 120));

if (opt.out) {
  writeFileSync(opt.out, JSON.stringify({ when: new Date().toISOString(), weAssets: A, opt, rows, gpuUnsupported: [...gpuUnsupported].map(([effect, reason]) => ({ effect, reason })) }, null, 1));
  console.log('\nJSON → ' + opt.out);
}
