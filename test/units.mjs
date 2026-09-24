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
