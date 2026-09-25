// 全库 CPU/GPU 双侧编译对照（issue #4 待办②要求的工具）。
//
// 目的: 把"哪些 shader 在 CPU 解释器能跑、GPU(WebGL) 也能编译"一次性摊开 —— 任何
// shim 归一改动都能立刻看出"多了/少了哪些可 GPU 化的效果"。
//
// 用法:
//   node scripts/gpu-compile-audit.mjs                 # 扫本机全部 workshop 场景
//   node scripts/gpu-compile-audit.mjs <scene.pkg> ...  # 只扫指定场景
//   node scripts/gpu-compile-audit.mjs --verbose        # 打印每个失败原因
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SceneRenderer } from '../src/scene-renderer.js';
import { locateWeAssets, steamRootCandidates } from '../src/render.js';
import { toWebGLSource } from '../src/we-renderer/gpu-gl/gl-shim.js';
import { runEffectOnGL, disposeGPU } from '../src/we-renderer/gpu-gl/gl-effect.js';

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const explicit = argv.filter((a) => !a.startsWith('--'));

function findScenes() {
  if (explicit.length) return explicit;
  const root = process.env.WE_SF_WORKSHOP_ROOT;
  const roots = root ? [root] : steamRootCandidates().map((r) => join(r, 'steamapps', 'workshop', 'content', '431960'));
  for (const base of roots) {
    if (!existsSync(base)) continue;
    return readdirSync(base).map((id) => join(base, id, 'scene.pkg')).filter((p) => existsSync(p));
  }
  return [];
}

const A = locateWeAssets();
const scenes = findScenes();
if (!scenes.length) { console.log('SKIP: 未找到场景'); process.exit(0); }

const seen = new Set();
let nCpu = 0, nGpu = 0, nBothFail = 0;
const gpuOnlyFail = [];
const cpuOnlyFail = [];

for (const scene of scenes) {
  let r;
  try { r = new SceneRenderer(scene, { width: 64, height: 64, time: 2.5, weAssetsDir: A, gpuAccel: false, log: () => {} }); }
  catch { continue; }
  for (const o of r.objects || []) {
    for (const ef of o.effects || []) {
      const name = String(ef.file || '').split(/[\\/]/).slice(-2)[0];
      const pass0 = (ef.passes || [])[0] || {};
      const key = String(ef.file) + '|' + JSON.stringify(pass0.combos || null) + '|' + JSON.stringify(pass0.constantshadervalues || null);
      if (seen.has(key)) continue;
      seen.add(key);

      // CPU: 编译器能否产出 fragPre
      let compiled = null;
      try { compiled = r._compileWorkshopEffect(ef); } catch { compiled = null; }
      const cpuOk = !!(compiled && compiled.fragPre);

      // GPU: 归一后能否真正编译+链接（用 1x1 空纹理实跑一次）
      let gpuOk = false, gpuErr = null;
      if (cpuOk) {
        try {
          const img = { width: 8, height: 8, rgba: new Uint8Array(8 * 8 * 4).fill(128) };
          const out = runEffectOnGL({
            fragPre: compiled.fragPre, vertPre: compiled.vertPre,
            u: { g_Texture0: img }, width: 8, height: 8,
          });
          gpuOk = !!(out && out.rgba);
        } catch (e) { gpuErr = String(e && e.message || e).split('\n')[0].slice(0, 120); }
      }

      if (cpuOk) nCpu++;
      if (gpuOk) nGpu++;
      if (cpuOk && !gpuOk) { nBothFail++; gpuOnlyFail.push({ scene: scene.split(/[\\/]/).slice(-2)[0], name, err: gpuErr }); }
      if (!cpuOk) cpuOnlyFail.push({ name, file: ef.file });
    }
  }
}

console.log('扫描场景 ' + scenes.length + ' 个, 去重效果实例 ' + seen.size + ' 个');
console.log('  CPU 可编译(出 fragPre): ' + nCpu);
console.log('  GPU 可编译+链接:        ' + nGpu);
console.log('  CPU 行 / GPU 不行:      ' + nBothFail + '   ← 这些效果在 GPU 路径会回退 CPU');
console.log('  CPU 都不行:             ' + cpuOnlyFail.length);

if (gpuOnlyFail.length) {
  const byName = new Map();
  for (const f of gpuOnlyFail) byName.set(f.name, (byName.get(f.name) || 0) + 1);
  console.log('\nGPU 侧失败效果（按名，前 20）:');
  for (const [k, v] of [...byName].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log('  ' + k.padEnd(30) + ' ×' + v);
  if (verbose) {
    console.log('\n失败原因（去重前 20）:');
    const seenErr = new Set();
    for (const f of gpuOnlyFail) {
      const k = f.name + ' :: ' + f.err;
      if (seenErr.has(k)) continue;
      seenErr.add(k);
      console.log('  [' + f.scene + '] ' + f.name + ': ' + f.err);
      if (seenErr.size >= 20) break;
    }
  }
}
disposeGPU();
