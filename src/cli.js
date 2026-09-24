#!/usr/bin/env node
/**
 * we-sf —— 独立 CLI：把 Wallpaper Engine 场景（scene.pkg / 场景目录）渲染成一张 PNG。
 *
 * 用法：
 *   we-sf render <scene.pkg|场景目录> -o out.png [--w 3840] [--h 2160] [--t 2.5]
 *               [--we-assets <WE>/assets] [--gpu] [--no-warm] [--json] [--log]
 *   we-sf locate                 # 只打印自动定位到的 WE assets 路径
 *
 * `--log` 会把渲染器的诊断（效果编译失败 / include 未解析 / 粒子精灵缺失 / 降级上报）
 * 打到 stderr —— 排查"画面缺效果 / 部件乱"时先开它。
 *
 * 无子命令时等价于 `render`。输出走 `process.stdout.write` + 显式退出码
 * （console.log 在某些 Windows shell 自然退出时会丢，实测）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderFrame, locateWeAssets, resolveSceneMainFile } from './render.js';

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'render';
const rest = cmd === argv[0] ? argv.slice(1) : argv;

const opt = { width: 3840, height: 2160, time: 2.5, weAssets: null, gpu: false, warm: true, out: null, json: false, logOn: false, input: null };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  const next = () => rest[++i];
  if (a === '-o' || a === '--out') opt.out = next();
  else if (a === '--w' || a === '--width') opt.width = Number(next());
  else if (a === '--h' || a === '--height') opt.height = Number(next());
  else if (a === '--t' || a === '--time') opt.time = Number(next());
  else if (a === '--we-assets') opt.weAssets = next();
  else if (a === '--gpu') opt.gpu = true;
  else if (a === '--no-warm') opt.warm = false;
  else if (a === '--json') opt.json = true;
  else if (a === '--log') opt.logOn = true;
  else if (a.startsWith('-')) { process.stderr.write('未知参数: ' + a + '\n'); process.exit(2); }
  else opt.input = a;
}

if (cmd === 'locate') {
  const p = locateWeAssets();
  process.stdout.write((p || '(未找到；请用 --we-assets 指定 <WE 安装目录>/assets)') + '\n');
  process.exit(p ? 0 : 1);
}

if (!opt.input) {
  process.stderr.write('缺少输入：we-sf render <scene.pkg|场景目录> -o out.png\n');
  process.exit(2);
}
const out = resolve(opt.out || 'frame.png');
const weAssets = opt.weAssets || locateWeAssets();
const log = opt.logOn ? (m) => process.stderr.write('[we-sf] ' + m + '\n') : () => {};

const t0 = Date.now();
try {
  const res = await renderFrame({
    input: opt.input,
    width: opt.width, height: opt.height, time: opt.time,
    weAssetsDir: weAssets, gpuAccel: opt.gpu, warm: opt.warm, log,
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, res.png);
  const info = {
    ok: true, out, bytes: res.png.length, width: res.width, height: res.height,
    time: res.time, ms: res.ms, totalMs: Date.now() - t0,
    sceneSrc: resolveSceneMainFile(opt.input), weAssets: weAssets || null, gpu: opt.gpu,
  };
  process.stdout.write((opt.json
    ? JSON.stringify(info)
    : `✓ ${out}  ${res.width}x${res.height}  ${(res.png.length / 1024).toFixed(0)} KB  ${res.ms}ms`
      + (weAssets ? '' : '  ⚠ 未定位到 WE assets（效果链会退化）')) + '\n');
  process.exit(0);
} catch (e) {
  const err = { ok: false, error: String(e && e.message ? e.message : e) };
  if (opt.json) process.stdout.write(JSON.stringify(err) + '\n');
  else process.stderr.write('✗ 渲染失败: ' + err.error + '\n');
  process.exit(1);
}
