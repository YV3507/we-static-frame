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
import { renderFrame, sampleFrame, locateWeAssets, steamRootCandidates } from '../src/render.js';
import { renameReservedSample, balanceConditionals } from '../src/we-renderer/glsl/preprocess.js';
import { normalizePolicy, isNoopPolicy, decideEffect, gpuAllowsEffect, normalizeBackend, GPU_MODES } from '../src/policy.js';
import { compileGlsl } from '../src/we-renderer/glsl/executor.js';

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

/** 找一个本地场景（与 smoke.mjs 同一套来源）；找不到返回 null → 相关用例 SKIP。 */
function findOneScene() {
  if (process.env.WE_SF_SCENE && existsSync(process.env.WE_SF_SCENE)) return process.env.WE_SF_SCENE;
  const roots = [];
  if (process.env.WE_SF_WORKSHOP_ROOT) roots.push(process.env.WE_SF_WORKSHOP_ROOT);
  for (const r of steamRootCandidates()) roots.push(join(r, 'steamapps', 'workshop', 'content', '431960'));
  for (const base of roots) {
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

// ── P1-3: GLSL 解析/转译失败 ────────────────────────────────────────────────
// 回归背景 1：shaderfrog 把 sample/buffer/shared/patch/precise/subroutine 当保留字
//（GLSL ES 1.0 里合法）⇒ 以它们命名的变量让整个效果被丢弃。
// 回归背景 2：工坊 shader 里有 `00.25`（多余前导零）、`3.14f`（HLSL 后缀）这类
// 非规范字面量，原样进 JS 会 `SyntaxError: Unexpected number`。
test('renameReservedSample: 只改独立保留字标识符，不伤 texSample2D/sampler2D', () => {
  const src = 'vec4 sample; float buffer; float shared; float patch; float precise; float subroutine;\n'
    + 'vec4 c = texSample2D(sampler2D_x, uv); float sampleCount = 1.0;';
  const out = renameReservedSample(src);
  for (const w of ['sample', 'buffer', 'shared', 'patch', 'precise', 'subroutine']) {
    assert.ok(out.includes(w + '__'), '未改名: ' + w);
  }
  assert.ok(out.includes('texSample2D('), 'texSample2D 被误伤');
  assert.ok(out.includes('sampler2D_x'), 'sampler2D 被误伤');
  assert.ok(out.includes('sampleCount'), 'sampleCount 被误伤');
});

test('compileGlsl: 保留字变量 + 00.25/3.14f 字面量可编译（效果不再整条丢弃）', () => {
  const glsl = 'void main(){ vec4 sample; sample = vec4(00.25); float x = 3.14f; gl_FragColor = sample + x; }';
  const r = compileGlsl({ fragSource: glsl });
  assert.equal(typeof r.fragFn, 'function', 'compileGlsl 未返回可执行 fragFn');
});

// ── P3: 跨平台候选路径 ─────────────────────────────────────────────────────
// 回归背景：locateWeAssets / smoke / survey 各自硬编码 Windows 盘符，Linux/macOS 上
// 自动定位必然失败。现在统一走 render.js::steamRootCandidates()。
test('steamRootCandidates: 非空、去重、环境变量优先', () => {
  const list = steamRootCandidates();
  assert.ok(Array.isArray(list) && list.length > 0, '候选列表为空');
  assert.equal(list.length, new Set(list).size, '候选列表有重复');
  const prev = process.env.DSH_WE_STEAM_ROOT;
  process.env.DSH_WE_STEAM_ROOT = '/tmp/fake-steam-root';
  try {
    const withEnv = steamRootCandidates();
    assert.equal(withEnv[0], '/tmp/fake-steam-root', 'DSH_WE_STEAM_ROOT 未优先');
    assert.ok(withEnv.includes('/tmp/fake-steam-root'));
  } finally {
    if (prev === undefined) delete process.env.DSH_WE_STEAM_ROOT; else process.env.DSH_WE_STEAM_ROOT = prev;
  }
});

// ── P1: 条件编译指令配平（issue #3） ──────────────────────────────────────
// 回归背景：3582367840 的 vert 多了一个 #endif（展开后第 109 行），shaderfrog
// 预处理器因此整条报 "Expected control line … but '#' found"，效果被丢弃；
// 而 WE 自带编译器容忍这种写法。
test('balanceConditionals: 多余的 #endif 被丢弃', () => {
  const src = '#if A\nx\n#endif\n#endif\n';
  const out = balanceConditionals(src, () => {});
  assert.equal((out.match(/#endif/g) || []).length, 1, '多余 #endif 未被丢弃');
  assert.ok(out.includes('x'));
});

test('balanceConditionals: 缺失的 #endif 在文件末尾补齐', () => {
  const out = balanceConditionals('#if A\nx\n', () => {});
  assert.equal((out.match(/#endif/g) || []).length, 1, '未补齐 #endif');
});

test('balanceConditionals: 源码本就配平时逐字节不变', () => {
  const src = '#if A\n#if B\nx\n#else\ny\n#endif\n#endif\n';
  assert.equal(balanceConditionals(src, () => {}), src, '配平源码被改动');
});

// ── 下游决策层 (policy) ────────────────────────────────────────────────────
// 目标：逐效果 apply/skip、逐效果后端、GPU 总开关、钩子优先级、非法输入不抛错。
test('normalizePolicy: 非法输入回落到安全默认（不抛错）', () => {
  for (const bad of [undefined, null, 0, 'x', [], { gpu: 'nonsense' }, { effects: 'nope' }, { gpu: { mode: {} } }]) {
    const p = normalizePolicy(bad);
    assert.ok(p && typeof p === 'object', 'normalizePolicy 未返回对象');
    assert.ok(GPU_MODES.includes(p.gpu.mode), 'gpu.mode 非法: ' + p.gpu.mode);
    assert.ok(p.allow instanceof Set && p.deny instanceof Set);
  }
  assert.equal(normalizePolicy({ gpu: false }).gpu.mode, 'off');
  assert.equal(normalizePolicy({ gpu: true }).gpu.mode, 'auto');
  assert.equal(normalizePolicy({ gpu: 'force' }).gpu.mode, 'force');
  assert.equal(normalizePolicy({}).gpu.mode, 'auto', '未提供 gpu 时不应擅自关闭');
  assert.equal(normalizePolicy({ gpu: { failStreakLimit: 0 } }).gpu.failStreakLimit, Infinity, '0 应表示永不熔断');
  assert.equal(normalizePolicy({ gpu: { failStreakLimit: 'x' } }).gpu.failStreakLimit, 3, '非法阈值未回落');
  assert.equal(normalizePolicy({}).skipDegenerate, true, '退化保护应默认开启');
  assert.equal(normalizePolicy({ effects: { skipDegenerate: false } }).skipDegenerate, false, 'skipDegenerate:false 未生效');
});

test('isNoopPolicy: 空策略被识别为 no-op（零开销前提）', () => {
  assert.equal(isNoopPolicy(normalizePolicy({})), true);
  assert.equal(isNoopPolicy(normalizePolicy({ gpu: 'off' })), false);
  assert.equal(isNoopPolicy(normalizePolicy({ effects: { deny: ['a'] } })), false);
  assert.equal(isNoopPolicy(normalizePolicy({ shaderPatch: { a: () => '' } })), false);
});

test('decideEffect: 钩子 > backend 表 > deny > allow > 默认', () => {
  const p = normalizePolicy({
    effects: { allow: ['a'], deny: ['b'], backend: { a: 'cpu', c: 'gpu-only' } },
    policy: { decideEffect: ({ effect }) => (effect === 'c' ? { action: 'skip', reason: 'hook' } : null) },
  });
  assert.equal(decideEffect(p, { effect: 'c' }).action, 'skip', '钩子未优先');
  assert.equal(decideEffect(p, { effect: 'c' }).source, 'hook');
  const a = decideEffect(p, { effect: 'a' });
  assert.equal(a.action, 'apply');
  assert.equal(a.backend, 'cpu');
  assert.equal(a.source, 'backend-map');
  assert.equal(decideEffect(p, { effect: 'b' }).source, 'deny');
  assert.equal(decideEffect(p, { effect: 'zzz' }).source, 'allow');
  assert.equal(decideEffect(normalizePolicy({}), { effect: 'any' }).action, 'apply');
});

test('decideEffect: 钩子抛错不牵连渲染（按默认放行并留痕）', () => {
  const p = normalizePolicy({ policy: { decideEffect: () => { throw new Error('boom'); } } });
  const r = decideEffect(p, { effect: 'x' });
  assert.equal(r.action, 'apply');
  assert.equal(r.source, 'hook-error');
});

test('gpuAllowsEffect: gpu=off 与名单生效', () => {
  assert.equal(gpuAllowsEffect(normalizePolicy({ gpu: 'off' }), 'a'), false);
  assert.equal(gpuAllowsEffect(normalizePolicy({ gpu: 'auto' }), 'a'), true);
  assert.equal(gpuAllowsEffect(normalizePolicy({ gpu: { denyEffects: ['a'] } }), 'a'), false);
  assert.equal(gpuAllowsEffect(normalizePolicy({ gpu: { allowEffects: ['b'] } }), 'a'), false);
  assert.equal(gpuAllowsEffect(normalizePolicy({ gpu: { allowEffects: ['b'] } }), 'b'), true);
});

test('normalizeBackend: off/none 表示"不走这条后端"', () => {
  assert.equal(normalizeBackend('cpu'), 'cpu');
  assert.equal(normalizeBackend('gpu-only'), 'gpu-only');
  assert.equal(normalizeBackend('off'), null);
  assert.equal(normalizeBackend('skip'), null);
  assert.equal(normalizeBackend('nonsense'), 'auto');
});

test('renderFrame: 策略进入真实渲染路径（跳过/后端/决策记录/GPU 开关）', async () => {
  const scene = findOneScene();
  if (!scene) return 'SKIP';
  const base = { input: scene, width: 160, height: 90, time: 2.5, weAssetsDir: locateWeAssets(), warm: false, log: () => {} };
  const a = await renderFrame(base);
  assert.ok(a.decisions && Array.isArray(a.decisions.items), '返回缺少 decisions');
  assert.ok(a.gpuStats && typeof a.gpuStats.state === 'string', '返回缺少 gpuStats');
  // 白名单：只允许一个不存在的效果 ⇒ 该场景所有效果都被跳过，且记录 source=allow
  const b = await renderFrame({ ...base, effects: { allow: ['__no_such_effect__'] } });
  assert.ok(b.decisions.total > 0, '白名单下没有决策记录');
  assert.ok(b.decisions.items.every((d) => d.action === 'skip'), '白名单未生效');
  assert.ok(b.decisions.items.every((d) => d.source === 'allow'));
  // gpu='off' 时不得探测（state 保持 unknown）
  const c = await renderFrame({ ...base, gpu: 'off' });
  assert.equal(c.gpuStats.state, 'unknown', 'gpu=off 仍探测了 GPU');
});


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
