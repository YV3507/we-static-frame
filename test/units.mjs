#!/usr/bin/env node
/**
 * 单元测试（不需要 WE 场景，只需要 node）。`npm run units`
 *
 * 约定：每个修复都要在这里留一条**可复现**的断言；依赖真实 WE assets/场景的用例在缺少
 * 环境变量时标记 SKIP（不假红）。运行时环境的 WE assets 可用 WE_ASSETS=<WE>/assets 指定。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { normalizeWeAssetsDir } from '../src/scene-renderer.js';
import { applySceneScripts, createScriptCache } from '../src/scene-scripts.js';

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

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

// ── runner ─────────────────────────────────────────────────────────────────
let pass = 0, skip = 0, fail = 0;
for (const { name, fn } of cases) {
  try {
    const r = fn();
    if (r === 'SKIP') { skip++; console.log('SKIP  ' + name); }
    else { pass++; console.log('ok    ' + name); }
  } catch (e) {
    fail++;
    console.log('FAIL  ' + name + '\n      ' + (e && e.message ? e.message.split('\n')[0] : e));
  }
}
console.log(`\n${pass} passed, ${skip} skipped, ${fail} failed`);
process.exit(fail ? 1 : 0);
