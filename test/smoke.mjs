#!/usr/bin/env node
/**
 * 冒烟：能拿到一个真实场景就渲染一张小图并校验 PNG 头；拿不到就跳过（退出码 0），
 * 这样在没有 WE 场景的机器/CI 上不会假红。
 *
 * 场景来源（按顺序）：
 *   1) 环境变量 WE_SF_SCENE（scene.pkg 路径或场景目录）
 *   2) 环境变量 WE_SF_WORKSHOP_ROOT 下的任一 <id>/scene.pkg（默认试几个常见 Steam 库路径）
 */
import { existsSync, readdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToFile, locateWeAssets } from '../src/render.js';

function findScene() {
  if (process.env.WE_SF_SCENE && existsSync(process.env.WE_SF_SCENE)) return process.env.WE_SF_SCENE;
  const roots = [];
  if (process.env.WE_SF_WORKSHOP_ROOT) roots.push(process.env.WE_SF_WORKSHOP_ROOT);
  for (const d of ['C', 'D', 'E', 'F']) roots.push(`${d}:\\SteamLibrary`, `${d}:\\Steam`);
  for (const r of roots) {
    const base = join(r, 'steamapps', 'workshop', 'content', '431960');
    if (!existsSync(base)) continue;
    for (const id of readdirSync(base)) {
      const p = join(base, id, 'scene.pkg');
      if (existsSync(p) && statSync(p).size > 4096) return p;
    }
  }
  return null;
}

const scene = findScene();
if (!scene) {
  console.log('SKIP: 未找到本地 WE 场景（设 WE_SF_SCENE=<scene.pkg> 或 WE_SF_WORKSHOP_ROOT=<.../431960> 后重跑）');
  process.exit(0);
}
const weAssets = locateWeAssets();
const dir = mkdtempSync(join(tmpdir(), 'we-sf-'));
const out = join(dir, 'frame.png');
try {
  const res = await renderToFile(scene, out, { width: 480, height: 270, time: 2.5, weAssetsDir: weAssets });
  const head = (await import('node:fs')).readFileSync(out).subarray(0, 8);
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const ok = isPng && res.width === 480 && res.height === 270 && res.png.length > 1024;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${scene}`);
  console.log(`      ${res.width}x${res.height}  ${(res.png.length / 1024).toFixed(0)} KB  ${res.ms}ms  weAssets=${weAssets ? 'yes' : 'NO'}`);
  process.exit(ok ? 0 : 1);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
