#!/usr/bin/env node
/**
 * 单元测试（不需要 WE 场景，只需要 node）。`npm run units`
 *
 * 约定：每个修复都要在这里留一条**可复现**的断言；依赖真实 WE assets/场景的用例在缺少
 * 环境变量时标记 SKIP（不假红）。运行时环境的 WE assets 可用 WE_ASSETS=<WE>/assets 指定。
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { normalizeWeAssetsDir } from '../src/scene-renderer.js';
import { applySceneScripts, createScriptCache } from '../src/scene-scripts.js';
import { renderFrame, sampleFrame, locateWeAssets } from '../src/render.js';

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

/** 找一个本地场景（与 smoke.mjs 同一套来源）；找不到返回 null → 相关用例 SKIP。 */
function findOneScene() {
  if (process.env.WE_SF_SCENE && existsSync(process.env.WE_SF_SCENE)) return process.env.WE_SF_SCENE;
  const roots = [];
  if (process.env.WE_SF_WORKSHOP_ROOT) roots.push(process.env.WE_SF_WORKSHOP_ROOT);
  for (const d of ['C', 'D', 'E', 'F', 'G']) roots.push(`${d}:\\SteamLibrary`, `${d}:\\Steam`);
  for (const r of roots) {
    const base = process.env.WE_SF_WORKSHOP_ROOT ? r : join(r, 'steamapps', 'workshop', 'content', '431960');
    if (!existsSync(base)) continue;
    for (const id of readdirSync(base)) {
      const p = join(base, id, 'scene.pkg');
      if (existsSync(p) && statSync(p).size > 4096) return p;
    }
  }
  return null;
}

// ── P0: weAssetsDir 语义归一 ────────────────────────────────────────────────
// 回归背景：内部按 <root>/assets/... 拼路径，而对外 API 传的是 <WE>/assets ⇒
// 曾静默拼成 <WE>/assets/assets/... 导致所有引擎资产回退落空。
const WE_ASSETS = process.env.WE_ASSETS || null;
const HAVE_ASSETS = !!(WE_ASSETS && existsSync(join(WE_ASSETS, 'shaders')));

test('normalizeWeAssetsDir: <WE>/assets → <WE>', () => {
  if (!HAVE_ASSETS) return 'SKIP';
  assert.equal(normalizeWeAssetsDir(WE_ASSETS), dirname(WE_ASSETS));
});

test('normalizeWeAssetsDir: <WE> 根保持不变（幂等）', () => {
  if (!HAVE_ASSETS) return 'SKIP';
  const root = dirname(WE_ASSETS);
  assert.equal(normalizeWeAssetsDir(root), root);
  assert.equal(normalizeWeAssetsDir(normalizeWeAssetsDir(WE_ASSETS)), root);
});

test('normalizeWeAssetsDir: null / 空 / 不存在的路径原样返回', () => {
  assert.equal(normalizeWeAssetsDir(null), null);
  assert.equal(normalizeWeAssetsDir(undefined), null);
  assert.equal(normalizeWeAssetsDir(''), null);
  const bogus = join(process.cwd(), '__no_such_we_dir__');
  assert.equal(normalizeWeAssetsDir(bogus), bogus);
});

// ── P1-2: 场景脚本的 console 不得污染宿主 stdout ──────────────────────────────
// 回归背景：沙箱直接把宿主 console 交给 vm，工坊脚本 console.log 会写进程 stdout，
// CLI `--json` 的首行变成 `Vec3 { x: … }` ⇒ JSON.parse 失败。
test('scene-scripts: console.log 转投 log 回调且不写宿主 stdout', () => {
  const scene = {
    objects: [{ name: 'probe', script: 'export function update(v){ console.log("hello", 1, {x:1,y:2,z:3}); return v; }', value: '7' }],
  };
  const seen = [];
  const realWrite = process.stdout.write;
  let stray = 0;
  process.stdout.write = () => { stray++; return true; };
  try {
    applySceneScripts(scene, 0, { scriptCache: createScriptCache(), log: (m) => seen.push(String(m)) });
  } finally {
    process.stdout.write = realWrite;
  }
  assert.equal(stray, 0, '脚本输出写到了宿主 stdout');
  assert.ok(seen.some((m) => m.includes('hello') ), 'log 回调没有收到脚本 console 输出: ' + JSON.stringify(seen));
  assert.ok(seen.some((m) => m.includes('1 2 3')), 'Vec3 未按 "x y z" 格式化: ' + JSON.stringify(seen));
});

test('scene-scripts: 未提供 log 时脚本 console 输出被静默丢弃', () => {
  const scene = { objects: [{ name: 'probe', script: 'export function update(v){ console.log("quiet"); return v; }', value: '1' }] };
  const realWrite = process.stdout.write;
  let stray = 0;
  process.stdout.write = () => { stray++; return true; };
  try {
    applySceneScripts(scene, 0, { scriptCache: createScriptCache() });
  } finally {
    process.stdout.write = realWrite;
  }
  assert.equal(stray, 0, '未提供 log 时仍写到了宿主 stdout');
});

// ── P1-1: 空白帧判定 + 降级结构化返回 ────────────────────────────────────────
// 回归背景：视频纹理/缺纹理场景会"成功"输出整帧空白（exit 0），调用方无从判断。
test('sampleFrame: 纯黑/纯色 → blank；渐变 → 非 blank', () => {
  const W = 128, H = 64;
  const black = new Uint8Array(W * H * 4).fill(0);
  for (let i = 3; i < black.length; i += 4) black[i] = 255;
  const b = sampleFrame(black, W, H);
  assert.equal(b.blank, true, '纯黑帧未被判定为空白');
  assert.equal(b.meanLuma, 0);

  const flat = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { flat[i * 4] = 30; flat[i * 4 + 1] = 60; flat[i * 4 + 2] = 90; flat[i * 4 + 3] = 255; }
  assert.equal(sampleFrame(flat, W, H).blank, true, '纯色帧未被判定为空白');

  const grad = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    grad[o] = (x * 2) % 256; grad[o + 1] = (y * 4) % 256; grad[o + 2] = ((x + y) * 2) % 256; grad[o + 3] = 255;
  }
  const g = sampleFrame(grad, W, H);
  assert.equal(g.blank, false, '渐变帧被误判为空白');
  assert.ok(g.meanLuma > 0 && g.meanLuma < 255, 'meanLuma 越界: ' + g.meanLuma);
});

test('renderFrame: 真实场景返回 degraded/blank/meanLuma 结构', async () => {
  const scene = findOneScene();
  if (!scene) return 'SKIP';
  const res = await renderFrame({
    input: scene, width: 200, height: 120, time: 2.5,
    weAssetsDir: locateWeAssets(), warm: false, log: () => {},
  });
  assert.ok(res.png && res.png.length > 1024, 'PNG 过小');
  assert.ok(Array.isArray(res.degraded), 'degraded 不是数组');
  assert.equal(typeof res.blank, 'boolean', 'blank 不是布尔');
  assert.equal(typeof res.meanLuma, 'number', 'meanLuma 不是数字');
});

test('renderFrame: 内嵌视频纹理场景 → blank 且 degraded 含可执行提示', async () => {
  const scene = process.env.WE_SF_VIDEO_SCENE;
  if (!scene || !existsSync(scene)) return 'SKIP';
  const res = await renderFrame({
    input: scene, width: 200, height: 120, time: 2.5,
    weAssetsDir: locateWeAssets(), warm: false, log: () => {},
  });
  assert.equal(res.blank, true, '视频纹理场景未被判定为空白帧');
  assert.ok(res.degraded.some((d) => /视频纹理/.test(d.action)), 'degraded 里没有视频纹理条目');
});

// ── runner ─────────────────────────────────────────────────────────────────
let pass = 0, skip = 0, fail = 0;
for (const { name, fn } of cases) {
  try {
    const r = await fn();
    if (r === 'SKIP') { skip++; console.log('SKIP  ' + name); }
    else { pass++; console.log('ok    ' + name); }
  } catch (e) {
    fail++;
    console.log('FAIL  ' + name + '\n      ' + (e && e.message ? e.message.split('\n')[0] : e));
  }
}
console.log(`\n${pass} passed, ${skip} skipped, ${fail} failed`);
process.exit(fail ? 1 : 0);
