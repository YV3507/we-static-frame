// 单场景分阶段耗时剖析 (配合 DSH_WE_PROFILE=1)。
//
// 用法:
//   node scripts/profile-scene.mjs <scene.pkg|场景目录> [--w 960] [--h 540] [--t 2.5] [--gpu]
//   node scripts/profile-scene.mjs <scene> --w 480 --h 270          # 不开 GPU
//   node scripts/profile-scene.mjs <scene> --gpu                    # 效果链走 WebGL
//
// 为什么带 PNG 编码: renderFrame 的 ms 含 encodePng 与 sampleFrame, 只看"阶段:*"会漏掉它们。
import { renderFrame, locateWeAssets } from '../src/render.js';

const argv = process.argv.slice(2);
const opt = { w: 960, h: 540, t: 2.5, gpu: false, input: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--w') opt.w = Number(next());
  else if (a === '--h') opt.h = Number(next());
  else if (a === '--t') opt.t = Number(next());
  else if (a === '--gpu') opt.gpu = true;
  else if (!a.startsWith('-')) opt.input = a;
  else { process.stderr.write('未知参数: ' + a + '\n'); process.exit(2); }
}
if (!opt.input) { process.stderr.write('用法: node scripts/profile-scene.mjs <scene.pkg> [--w N] [--h N] [--t S] [--gpu]\n'); process.exit(2); }

process.env.DSH_WE_PROFILE = '1';
const { profFormat, profReset } = await import('../src/we-renderer/profile.js');
const { encodePng, sampleFrame } = await import('../src/scene-renderer.js');

profReset();
const t0 = Date.now();
let res = null, wall = 0, err = null;
try {
  res = await renderFrame({
    input: opt.input, width: opt.w, height: opt.h, time: opt.t,
    weAssetsDir: locateWeAssets(), warm: false, gpu: opt.gpu ? 'auto' : 'off',
    log: () => {},
  });
} catch (e) { err = e; }
wall = Date.now() - t0;

// 剖析报告**先打**（即使后面出问题也别把已测到的数据丢了）
process.stdout.write(profFormat(wall) + '\n');

if (err) {
  process.stdout.write('\nrenderFrame 抛错: ' + (err && err.message ? err.message : err) + '\n');
  process.exit(1);
}

// sampleFrame 的抽样成本（renderFrame 里也调了一次）
const t2 = Date.now();
sampleFrame(new Uint8Array(res.width * res.height * 4), res.width, res.height);
const sampleMs = Date.now() - t2;

process.stdout.write('\n── 未被 profTime 覆盖的部分 ──\n');
process.stdout.write('  renderFrame 返回的 ms        ' + String(res.ms).padStart(8) + 'ms\n');
process.stdout.write('  整帧墙钟 (含预热/编码/收尾)   ' + String(wall).padStart(8) + 'ms\n');
process.stdout.write('  PNG 体积 ' + (res.png.length / 1024).toFixed(1) + 'KB\n');
process.stdout.write('  sampleFrame 抽样             ' + String(sampleMs).padStart(8) + 'ms\n');
process.stdout.write('  GPU: ' + JSON.stringify(res.gpuStats) + '\n');
process.stdout.write('  降级 ' + res.degraded.length + ' 条\n');
