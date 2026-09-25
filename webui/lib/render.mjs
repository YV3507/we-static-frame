// WebUI 服务端 — 单次渲染的执行体（在**子进程**里跑）
//
// 为什么要子进程: `src/**` 是搬运来的既有实现, 多处 `DSH_WE_*` 诊断开关是**模块加载期**
// 读的环境变量（`const DUMP = process.env.DSH_WE_FX_DUMP === '1'` 等）。要让 UI 能逐次
// 切换这些开关（并且不因为模块级缓存串味），最省事又最不易错的做法就是**每次渲染起一个
// 干净的子进程**，环境变量按请求注入。渲染本身是秒级，进程启动 ~300ms 可接受。
//
// 本文件只做"把 job 翻译成 renderFrame 参数"，不含任何 UI 逻辑。
import { existsSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { renderFrame } from '../../src/render.js';
import { normalizeSceneInput } from './scenes.mjs';

/** 允许由 UI 打开的诊断环境变量（白名单，避免变成任意 env 注入）。 */
export const DEBUG_ENV_KEYS = new Set([
  'DSH_WE_FX_DUMP',        // 逐 pass 取证（target/尺寸/各槽位绑到哪个 RT/编译源签名/像素摘要）
  'DSH_WE_FX_TRACE',       // 生成 JS 的出错行
  'DSH_WE_NO_FX',          // 效果链整体短路（量"完全不启用效果"的下界）
  'DSH_WE_NO_FXJSON',      // 关掉 effect.json 数据通路
  'DSH_WE_NO_FXJSON_GPU',  // 关掉"数据通路多 pass 走 GPU"（issue #4① 的 A/B 臂）
  'DSH_WE_NO_FX_CHAIN',    // 关掉 GPU 链式执行
  'DSH_WE_CHAIN_VERIFY',   // 链式结果与逐效果单独走 GPU 逐位对比
  'DSH_WE_DEBUG_GLSL',     // gpu-gl 单 pass 输出统计
  'DSH_WE_PROFILE',        // 分阶段耗时剖析
  'DSH_WE_RT_ALL',         // 保留每个对象的合成结果
  'DSH_WE_NO_SEED_VTEXCOORD', // 关掉 v_TexCoord 播种（issue #2 的 A/B 臂）
]);

/** 把 UI 的 debug 开关对象（{KEY: true}）过滤成合法 env 值。 */
export function debugEnv(debug) {
  const env = {};
  if (!debug || typeof debug !== 'object') return env;
  for (const [k, v] of Object.entries(debug)) {
    if (!DEBUG_ENV_KEYS.has(k)) continue;
    if (v) env[k] = '1';
  }
  return env;
}

/** 解析 shaderPatch 的 JSON 形式: [{ key, from, to, flags }] → { key: fn }。
 *  用受限的正则替换（长度上限 + 捕获抛错），避免把任意代码带进渲染进程。 */
export function buildShaderPatch(specs) {
  if (!Array.isArray(specs) || !specs.length) return null;
  const patch = {};
  for (const s of specs) {
    if (!s || typeof s.key !== 'string' || !s.key) continue;
    const from = typeof s.from === 'string' ? s.from : '';
    const to = typeof s.to === 'string' ? s.to : '';
    if (!from || from.length > 500) continue;
    let re;
    try { re = new RegExp(from, typeof s.flags === 'string' ? s.flags.replace(/[^gimsuy]/g, '') : ''); } catch { continue; }
    patch[s.key] = (src) => {
      try { return String(src).replace(re, to); } catch { return src; }
    };
  }
  return Object.keys(patch).length ? patch : null;
}

/** 本次请求是否需要用数据层改写 scene.json（逐对象/逐效果勾选）。 */
export function needsVisibilityRewrite(job) {
  const n = Array.isArray(job.hideObjects) ? job.hideObjects.length : 0;
  const m = Array.isArray(job.hideEffects) ? job.hideEffects.length : 0;
  return !!(n || m);
}

/**
 * 按"逐对象 / 逐效果"开关改写场景 JSON。
 *
 * 为什么走数据层而不是策略层:
 *   · **逐对象**: 渲染器只认对象自己的 `visible` 字段（core.js `_visible`），没有对象级策略钩子。
 *     ⇒ 照官方语义直接改 `scene.objects[i].visible`。
 *   · **逐效果**: effects.js 的 `decideEffect` 能按 `{effect, layer, index}` 决策，但**同一图层里
 *     两个同名效果无法区分**（`layer` 与 `index` 在同一对象内不足以唯一定位到"第几个效果"的
 *     稳定身份）。数据层的 `effects[j].visible` 则天然精确 ⇒ 用同一张 JSON 一并处理。
 *   两者都在 `_readSceneObjects` 消费之前写回，语义与官方一致（visible=false 即不参与渲染）。
 *
 * @param {string} input 归一后的场景入口
 * @param {object} job 请求体
 * @returns {{input: string, tmp: string|null}} 可能是改写后的临时场景目录
 */
export function applyVisibilityOverrides(input, job) {
  const hideObjects = Array.isArray(job.hideObjects) ? job.hideObjects.map(Number) : [];
  const hideEffects = Array.isArray(job.hideEffects) ? job.hideEffects : []; // [{object, index}]
  if (!hideObjects.length && !hideEffects.length) return { input, tmp: null };

  // input 既可能是**场景目录**（松散/解包），也可能是**文件**（scene.pkg 或某个 .json）。
  // 两者取 scene.json 的方式不同：目录 → 它自己；文件 → 与它同级的目录。早先一律
  // dirname(input)，对"目录"入参会往上跳一级 ⇒ 明明已解包却说"需要解包"。
  let dir;
  try { dir = statSync(input).isDirectory() ? input : dirname(input); }
  catch { dir = dirname(input); }
  const scenePath = join(dir, 'scene.json');
  if (!existsSync(scenePath)) {
    // 走到这里说明上层没做前置解包（见 runJob 的 ensureUnpacked）。明确报错而不是静默
    // 忽略 —— 静默会让 UI 的勾选看起来"没生效"。
    const e = new Error('逐对象/逐效果开关需要**松散场景目录**（可直接改写 scene.json）；'
      + 'scene.pkg 的场景 JSON 在 PKG 容器内。可先用「解包」把 pkg 落成目录再勾选。');
    e.code = 'NEEDS_DIR';
    throw e;
  }

  const raw = JSON.parse(readFileSync(scenePath, 'utf8'));
  const objs = raw.objects || [];
  let changed = 0;
  for (const i of hideObjects) if (objs[i]) { objs[i].visible = false; changed++; }
  for (const h of hideEffects) {
    const o = objs[Number(h.object)];
    if (!o || !Array.isArray(o.effects)) continue;
    const j = Number(h.index);
    if (o.effects[j]) { o.effects[j].visible = false; changed++; }
  }
  if (!changed) return { input, tmp: null };
  // 改写结果写到**同一目录**（相对资源路径如 materials/xxx 必须仍然解析得到），
  // 文件名固定且带 .webui- 前缀，渲染后删除；原 scene.json 不动。
  const tmp = join(dir, '.webui-tmp-scene.json');
  writeFileSync(tmp, JSON.stringify(raw));
  return { input: tmp, tmp };
}

/** 组装 renderFrame 的入参。**这里是"全部下游接口"的唯一映射点**，UI 的字段都在这落地。 */
export function buildRenderOpts(job) {
  const render = job.render || {};
  const opts = {
    width: Number(render.width) || 960,
    height: Number(render.height) || 540,
    time: render.time === undefined || render.time === null ? 2.5 : Number(render.time),
    weAssetsDir: render.weAssetsDir || null,
    warm: render.warm !== false,
    gpuAccel: render.gpuAccel === true,
    // 场景稳定标识: 让"同一场景的副本"（uploads / 解包目录）跑出与原 pkg 逐像素一致的结果。
    // 粒子系统的确定性 RNG 用它做种子（见 we-renderer/particles.js::_particleRng）。
    sceneKey: job.sceneKey || null,
    // 渲染器的日志回调由调用方注入（子进程入口注入 → stderr）；未注入即静默
    log: typeof render.log === 'function' ? render.log : () => {},
  };
  if (render.gpu !== undefined && render.gpu !== null && render.gpu !== '') {
    if (typeof render.gpu === 'object') opts.gpu = render.gpu;
    else opts.gpu = String(render.gpu);
  } else if (render.gpuAccel === true) opts.gpu = 'auto';

  const eff = job.effects || {};
  const effects = {};
  if (Array.isArray(eff.allow) && eff.allow.length) effects.allow = eff.allow;
  if (Array.isArray(eff.deny) && eff.deny.length) effects.deny = eff.deny;
  if (eff.backend && typeof eff.backend === 'object' && Object.keys(eff.backend).length) effects.backend = eff.backend;
  if (eff.skipDegenerate === false) effects.skipDegenerate = false;
  if (Object.keys(effects).length) opts.effects = effects;
  // 退化负缓存：反复渲染同一场景时，把"连续多轮被丢弃"的效果直接跳过（省掉纯白做的计算）。
  // 只在 WebUI 的重复渲染场景下有意义；单次渲染的调用方默认不开启（行为逐位不变）。
  if (Number.isInteger(eff.skipDegenerateAfter) && eff.skipDegenerateAfter > 0) {
    opts.effects = { ...(opts.effects || {}), skipDegenerateAfter: eff.skipDegenerateAfter };
  }

  const pol = job.policy || {};
  const policy = {};
  if (Array.isArray(pol.skip) && pol.skip.length) {
    const set = new Set(pol.skip);
    policy.decideEffect = (ctx) => (set.has(ctx.effect) ? { action: 'skip', reason: 'UI 勾选跳过' } : 'apply');
  }
  if (pol.perEffectSkip && typeof pol.perEffectSkip === 'object') {
    // 逐效果(按对象名+效果名)跳过: 比 allow/deny 名单更精确
    const prev = policy.decideEffect;
    const keys = Object.entries(pol.perEffectSkip).filter(([, v]) => v).map(([k]) => k);
    if (keys.length) {
      const set = new Set(keys);
      policy.decideEffect = (ctx) => {
        const name = String(ctx.layer == null ? '' : ctx.layer) + '\u0000' + ctx.effect;
        if (set.has(name)) return { action: 'skip', reason: 'UI 逐效果跳过' };
        return prev ? prev(ctx) : 'apply';
      };
    }
  }
  if (pol.decideBackendAll) policy.decideBackend = () => pol.decideBackendAll;
  else if (pol.perEffectBackend && typeof pol.perEffectBackend === 'object') {
    // 逐效果后端（UI 的效果链树里每个效果一个下拉）：比全局统一后端更细，
    // 且比 effects.backend 表更强 —— 它会覆盖 decideEffect 推出来的 backend。
    const map = Object.fromEntries(Object.entries(pol.perEffectBackend).filter(([, v]) => typeof v === 'string' && v));
    if (Object.keys(map).length) policy.decideBackend = (ctx) => map[ctx.effect] || undefined;
  }
  if (policy.decideEffect || policy.decideBackend) opts.policy = policy;

  const patch = buildShaderPatch(job.shaderPatch);
  if (patch) opts.shaderPatch = patch;
  return opts;
}

/** 执行一次渲染 job（服务进程内直接调用）。 */
export async function runJob(job) {
  const t0 = Date.now();
  const normalized = normalizeSceneInput(job.input);
  if (!normalized) throw new Error('场景不存在: ' + job.input);
  // 场景稳定标识: 让"同一场景的副本"（上传副本 / 解包目录）与原 pkg 跑出逐像素一致的结果
  // —— 粒子系统的确定性 RNG 以它为种子（we-renderer/particles.js::_particleRng）。
  const sceneKey = job.sceneKey || (await import('./unpack.mjs')).deriveSceneKey(normalized);
  // ── 逐对象/逐效果开关: 需要**松散场景目录**（数据层要改写 scene.json）──────────
  // 传入的是 scene.pkg 时**自动解包一次**再渲染，而不是把"请先解包"甩给用户 ——
  // 用户的预期是"任何场景都能直接取消勾选"，多一步手动解包纯属摩擦。
  // 解包产物按 sceneKey 落在 webui/tmp/unpacked/<id>/，二次渲染直接复用（有旁挂校验）。
  let input = normalized;
  let autoUnpacked = null;
  if (needsVisibilityRewrite(job)) {
    const { ensureUnpacked } = await import('./unpack.mjs');
    const up = ensureUnpacked(normalized, sceneKey);
    if (up && up.input) { input = up.input; autoUnpacked = up.unpacked ? up.input : null; }
    else if (up && up.error) {
      const e = new Error(up.error);
      e.code = 'NEEDS_DIR';
      throw e;
    }
  }
  const vis = applyVisibilityOverrides(input, job);
  const opts = buildRenderOpts(job);
  opts.sceneKey = sceneKey;
  if (!opts.weAssetsDir) {
    const { locateWeAssets } = await import('../../src/render.js');
    opts.weAssetsDir = locateWeAssets();
  }
  if (process.env.WEBUI_DBG_OVERRIDE === '1') {
    let st = 'n/a';
    try { st = statSync(vis.input).isDirectory() ? 'dir' : 'file'; } catch (e) { st = 'stat-err:' + e.code; }
    process.stderr.write('[job] raw=' + JSON.stringify(job.input) + ' normalized=' + JSON.stringify(normalized)
      + ' used=' + JSON.stringify(vis.input) + ' (' + st + ') hides=' + (job.hideObjects || []).length + '/' + (job.hideEffects || []).length
      + ' autoUnpacked=' + JSON.stringify(autoUnpacked) + '\n');
  }
  // GPU 熔断状态是**进程级**的（见 gpu-gl/adapter.js）。WebUI 常在同一进程里连渲染多个场景，
  // 一次失败就可能让后续请求全部"状态=off"。`gpu:'force'` 的语义本就是"重新探测"，这里显式
  // 复位一次，使 UI 上的 force 真正能重新武装 GPU —— 否则用户只能重启服务才能恢复。
  if (opts.gpu === 'force' || (opts.gpu && typeof opts.gpu === 'object' && opts.gpu.mode === 'force')) {
    try {
      const { resetGpuAdapter } = await import('../../src/we-renderer/gpu-gl/adapter.js');
      resetGpuAdapter();
    } catch { /* ignore */ }
  }
  const res = await renderFrame({ ...opts, input: vis.input });
  if (vis.tmp) { try { rmSync(vis.tmp, { force: true }); } catch { /* ignore */ } }
  return {
    png: Buffer.from(res.png).toString('base64'),
    bytes: res.png.length,
    width: res.width, height: res.height, time: res.time,
    sceneSrc: res.sceneSrc,
    weAssetsDir: res.weAssetsDir,
    ms: res.ms,
    totalMs: Date.now() - t0,
    blank: !!res.blank,
    meanLuma: res.meanLuma,
    degraded: res.degraded || [],
    decisions: res.decisions || { total: 0, items: [] },
    gpuStats: res.gpuStats || null,
    // 逐对象/逐效果开关是否触发了自动解包（UI 据此提示"已自动解包到 …"）
    autoUnpacked: autoUnpacked || null,
    sceneKey,
    effective: { effects: opts.effects || null, gpu: opts.gpu || null, policy: !!opts.policy, shaderPatchKeys: opts.shaderPatch ? Object.keys(opts.shaderPatch) : [] },
  };
}
