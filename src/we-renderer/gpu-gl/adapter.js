// WE GPU 效果适配层 —— 把 gpu-gl 的 WebGL 执行器接回 SceneRenderer 的**热路径**。
//
// 为什么需要这个文件: `_tryEffectGpu` / `_getGpuBackend` 这两个挂载点随
// "移除 scene-anim 动画方向, 聚焦静态帧" 重构一起消失, 只留下引用方
// (死文件 render/passes.js 的存在性判断 + worker 里的诊断守卫), 于是
// `gpu-gl/` 那一整套实现成了无法抵达的代码 —— 实测 254/349 次 `gpuBackend=false`
// 根因在此 (不是"驱动不稳"), 详见 docs/SCENE-FRAME-PERF.md §八。
//
// 实测依据 (identity shader, 4096x4096): runEffectOnGL 正确性 maxΔ=0, 单 pass
// 13–24ms (含 FBO + readPixels 回读); CPU 同尺寸单次采样需 250–450ms。
//
// 开关与回退 (设计约束):
//   - 开关: `SceneRenderer.gpuAccel` (opts.gpuAccel === true)。**默认关闭** ——
//     GPU 输出与 CPU 存在浮点/采样实现差异, 必须由用户显式选择, 且帧缓存键里
//     已含 gpuFlag (index.js), 两种模式不会互相命中。
//   - 回退: 任何一步失败 (无 supreium-headless-gl / 无驱动 / 上下文创建失败 /
//     shader 编译失败 / 尺寸不符) 一律返回 null, 调用方继续走 CPU 内核 ——
//     **GPU 不可用绝不能影响渲染可用性**。
//   - 熔断: 连续失败达阈值后锁定为不可用, 不再逐效果付异常开销。
//
// 已知语义差异 (有意保留, 未在本层修正):
//   CPU GLSL 解释器对**辅助槽纹理**用 REPEAT 采样 (integration.js 的 __glslRepeat),
//   而 gpu-gl 的 uploadTextureData 对所有纹理统一 CLAMP_TO_EDGE。对位移/遮罩类
//   采样跨 [0,1] 的效果 (waterripple 等) 两者可能产生可见差异。修它需要按槽位
//   区分 wrap, 而纹理在 gpu-gl 里按 texData 对象全局缓存 —— 同一张纹理可能同时
//   当主图 (CLAMP) 与辅助槽 (REPEAT), 简单改会串。**先量化差异再决定是否值得动。**
import { getWebGL } from './gl-core.js';
import { runEffectOnGL, runEffectChainOnGL } from './gl-effect.js';
import { runMultiPassOnGL } from './gl-multipass.js';
import { buildUniforms, compileGlsl } from '../glsl/executor.js';
// combo 值归一 (数值 0 会让 shaderfrog 删 token) —— 与 CPU 数据通路**同一个函数**,
// 保证两侧编译的是同一份 combo 展开结果。
import { comboStr, summarizeRgba } from '../effects/effectjson.js';

// 逐 pass 取证开关 (与 effectjson.js 同约定): GPU 多 pass 同样把"各槽位绑到哪个 RT +
// 实际编译源签名"记到 passTrace, 由 onPass 打成 FX-DUMP(GPU) 行, 供逐 pass 并排对照。
// **每次调用读取**（非模块加载期），便于宿主/WebUI 逐请求切换。
const dumpFxOn = () => process.env.DSH_WE_FX_DUMP === '1';
// A/B 开关: 关掉"数据通路多 pass 走 GPU"(issue #4① 的接线), 回到接线前行为 —— 用于
// **同一会话内**测出该接线的净收益 (跨会话的绝对耗时会受机器负载影响, 不可比)。
const jsonGpuOff = () => process.env.DSH_WE_NO_FXJSON_GPU === '1';

// ── 后端状态 (进程内) ────────────────────────────────────────────────────────
// unknown: 未探测; ok: 可用; off: 已判定不可用 (不再尝试)
let _gpuState = 'unknown';
let _gpuFailStreak = 0;
const GPU_FAIL_STREAK_LIMIT = 3;

// 诊断计数 (gpu-diag.log / profile 报告用)
const stats = { used: 0, failed: 0, fallback: 0, unavailable: 0 };

export function gpuAdapterStats() {
  return { state: _gpuState, failStreak: _gpuFailStreak, ...stats };
}

/** 测试/LRU 用: 复位探测与熔断状态。 */
export function resetGpuAdapter() {
  _gpuState = 'unknown';
  _gpuFailStreak = 0;
  stats.used = 0; stats.failed = 0; stats.fallback = 0; stats.unavailable = 0;
}

export function installGpuAdapter(proto) {
  /**
   * 返回后端标识 ('webgl') 或 null。首次调用做真实探测 (getWebGL(true)),
   * 不可用则熔断为 off —— 后续调用零成本直接返回 null。
   *
   * 下游策略（this.policy.gpu.mode）：
   *   · 'off'   → 永不探测、永不使用 GPU（零开销，连 require 都不做）
   *   · 'auto'  → 默认：探测一次，不可用就回退 CPU
   *   · 'force' → 即便本进程此前已熔断也重新探测（便于下游"宁可慢也要 GPU"或多场景复用）
   */
  proto._getGpuBackend = function () {
    if (this.gpuAccel !== true) return null;
    const mode = (this.policy && this.policy.gpu && this.policy.gpu.mode) || 'auto';
    if (mode === 'off') return null;
    if (mode === 'force') _gpuState = 'unknown';       // 强制重探（含此前熔断的进程）
    if (_gpuState === 'off') return null;
    if (_gpuState === 'unknown') {
      let ok = false;
      try { ok = getWebGL(true) !== null; } catch { ok = false; }
      _gpuState = ok ? 'ok' : 'off';
      if (!ok) { stats.unavailable++; this.log('GPU 不可用 (无 headless-GL/驱动), 效果链继续走 CPU'); }
    }
    return _gpuState === 'ok' ? 'webgl' : null;
  };

  /** 熔断阈值可由下游配置（policy.gpu.failStreakLimit；0 = 永不熔断）。 */
  proto._gpuFailStreakLimit = function () {
    const n = this.policy && this.policy.gpu && this.policy.gpu.failStreakLimit;
    if (n === Infinity) return Infinity;
    return Number.isFinite(n) && n > 0 ? n : GPU_FAIL_STREAK_LIMIT;
  };

  /** 记一次 GPU 失败; 达阈值即熔断。 */
  proto._noteGpuFailure = function (e) {
    stats.failed++;
    _gpuFailStreak++;
    const limit = this._gpuFailStreakLimit();
    this.log('GPU 效果失败 (' + _gpuFailStreak + '/' + limit + '): ' + (e && e.message ? e.message : e));
    if (_gpuFailStreak >= limit) {
      _gpuState = 'off';
      this.log('GPU 连续失败达阈值 → 熔断, 本次进程内效果链全部回退 CPU');
    }
  };

  /**
   * 用 GPU 执行单个效果。成功返回 {width,height,rgba}, 任何失败返回 null
   * (调用方继续走 CPU 内核 / GLSL 解释器)。
   *
   * @param {object} img  链输入图 (作为 g_Texture0)
   * @param {object} ef   效果对象 (ef.file / ef.passes)
   * @param {string} name 效果名 (effects/<name>)
   * @param {object} c    constantshadervalues
   * @param {object} pass pass 定义 (textures / combos)
   * @param {number} t    场景时间
   */
  proto._tryEffectGpu = function (img, ef, name, c, pass, t) {
    if (!this._getGpuBackend()) return null;
    if (!img || !img.width || !img.height || !img.rgba) return null;
    let compiled;
    try { compiled = this._compileWorkshopEffect(ef); } catch { return null; }
    // fragPre 缺失 = CPU 侧也没能产出预处理源码 ⇒ 本层不接手 (保守, 宁可走 CPU)
    if (!compiled || !compiled.fragPre) return null;
    try {
      const pass0 = pass || (ef.passes && ef.passes[0]) || {};
      const constants = c || pass0.constantshadervalues || {};
      const texRefs = pass0.textures || [];
      const textures = texRefs.map((p) => (p && p !== 'null' ? this.loadTexture(p) : null));
      // uniform 组装与 CPU 路径**完全同一套** (executor.buildUniforms + 同一 engine 注入)
      const u = buildUniforms(compiled.uniforms, constants, {
        time: t || 0,
        textures,
        objW: img.width,
        objH: img.height,
        userAlpha: 1,
        parallaxPosition: this.optsMouse ? [this.optsMouse.x, this.optsMouse.y] : [0.5, 0.5],
      });
      // sampler2D 绑定: g_Texture0 = 链输入 img, g_TextureN = textures[N] (官方槽位语义)
      for (const [un, info] of Object.entries(compiled.uniforms)) {
        if (info.type === 'sampler2D' && u[un] === undefined) {
          const idx = Number((/g_Texture(\d+)/.exec(un) || [])[1] || 0);
          u[un] = idx === 0 ? img : (textures[idx] || null);
        }
      }
      // wrap 语义标记: 与 CPU 解释器 (integration.js::_renderGlslEffect) 同一套约定 ——
      // 辅助槽纹理 REPEAT, 主图 g_Texture0 CLAMP (当 img 自身也是辅助槽时同样 REPEAT)。
      // gl-effect 的 wrapFor 依赖这两个标记, 否则采样跨 [0,1] 的位移/遮罩效果会产生
      // 可见差异。用普通属性标记 (与 CPU 侧共用同一字段名, 便于对照排查)。
      for (const tx of textures) if (tx) tx.__glslRepeat = true;
      img.__glslRepeat = textures.includes(img);
      const out = runEffectOnGL({
        fragPre: compiled.fragPre,
        vertPre: compiled.vertPre,
        u,
        width: img.width,
        height: img.height,
      });
      // 尺寸必须一致: 不一致说明该效果会改变图层尺寸, GPU 单 pass 不适用 → 回退 CPU
      if (!out || !out.rgba || out.width !== img.width || out.height !== img.height) return null;
      stats.used++;
      _gpuFailStreak = 0; // 成功即清零 (偶发失败不累积)
      return out;
    } catch (e) {
      this._noteGpuFailure(e);
      return null;
    }
  };

  /**
   * 连续效果链在**一次 GL 会话**内执行 (FBO 乒乓, 中间结果不读回 CPU) —— §三十五。
   *
   * ★ 与 `_tryEffectGpu` **完全独立**: 本方法不改动它任何一行。
   *   §三十一 的教训: 那次为了复用 program/uniform 而拆分 `_tryEffectGpu`,
   *   结果走 GPU 的效果数从 25 掉到 21、像素随之改变, 机制至今未查明。
   *   这里宁可重复约 20 行 uniform 组装, 也不碰那条路径 —— 重复只可能造成
   *   "少串一条链"(错过优化), 不可能改变单效果路径的行为。
   *   两条路径产出是否一致, 由 effects.js 的 DSH_WE_CHAIN_VERIFY=1 自检直接断言。
   */
  proto._tryEffectChainGpu = function (img, items) {
    if (!this._getGpuBackend()) return null;
    if (!img || !img.width || !img.height || !img.rgba) return null;
    if (!items || items.length < 2) return null;
    try {
      const prepared = [];
      for (const it of items) {
        const compiled = this._compileWorkshopEffect(it.ef);
        if (!compiled || !compiled.fragPre) return null;
        const pass0 = it.pass || (it.ef.passes && it.ef.passes[0]) || {};
        const constants = it.c || pass0.constantshadervalues || {};
        const texRefs = pass0.textures || [];
        const textures = texRefs.map((p) => (p && p !== 'null' ? this.loadTexture(p) : null));
        const u = buildUniforms(compiled.uniforms, constants, {
          time: it.t || 0,
          textures,
          objW: img.width,
          objH: img.height,
          userAlpha: 1,
          parallaxPosition: this.optsMouse ? [this.optsMouse.x, this.optsMouse.y] : [0.5, 0.5],
        });
        for (const [un, info] of Object.entries(compiled.uniforms)) {
          if (info.type === 'sampler2D' && u[un] === undefined) {
            const idx = Number((/g_Texture(\d+)/.exec(un) || [])[1] || 0);
            u[un] = idx === 0 ? img : (textures[idx] || null);
          }
        }
        for (const tx of textures) if (tx) tx.__glslRepeat = true;
        img.__glslRepeat = textures.includes(img);
        prepared.push({ fragPre: compiled.fragPre, vertPre: compiled.vertPre, u });
      }
      const out = runEffectChainOnGL(prepared, img.width, img.height);
      if (!out || !out.rgba || out.width !== img.width || out.height !== img.height) return null;
      stats.used += items.length;
      _gpuFailStreak = 0;
      return out;
    } catch (e) {
      this._noteGpuFailure(e);
      return null;
    }
  };

  /**
   * 用 GPU 执行 **effect.json 数据通路**的多 pass 效果 (bloom / blurprecise / bokeh_blur …)。
   *
   * 与 `_tryEffectGpu` (效果目录名猜 shader 的单 pass 通路) 的区别: 这里跑的是
   * `effects/effectjson.js` 已解析好的 `def` (fbos / passes / 每 pass 的 fragX+meta)，
   * FBO 链交给 `gpu-gl/gl-multipass.js::runMultiPassOnGL` —— 该执行器与 CPU 的
   * `_applyEffectJsonEffect` 同语义 (target FBO 分辨率 = 输入尺寸 / fbos[].scale,
   * bind[i].name → 'previous' | FBO 名)。着色器编译与 uniform 组装**复用 CPU 路径同一套**
   * (compileGlsl / buildUniforms + 同序 sampler 补绑), 因此在 GPU 上跑的是同一个程序。
   *
   * 返回契约与 CPU 路径一致: `{width,height,rgba}` (宽高已回到输入尺寸), 或 null
   * (调用方继续走 CPU 逐 pass)。**任何失败/单 pass 无产出即整体放弃** —— 与 CPU 侧
   * "一个 pass 失败则整个效果不应用" 同策略 (宁可慢, 不可错)。
   *
   * @param {object} def  _fxJsonDef 的返回值 (含 passes[].fragX/meta/material…)
   * @param {object} ef   实例效果声明 (scene.json objects[].effects[])
   * @param {{width,height,rgba}} img 链输入图 (= 本层渲染结果)
   * @param {number} t    场景时间
   * @param {string} name 效果名 (effects/<name>)
   */
  proto._tryEffectJsonGpu = function (def, ef, img, t, name) {
    if (jsonGpuOff()) return null;
    if (!this._getGpuBackend()) return null;
    if (!img || !img.width || !img.height || !img.rgba) return null;
    if (!def || !def.passes || !def.passes.length) return null;
    if (!this._fxJsonCombos || !this._fxJsonTextures) return null;
    // 已证伪的"素材不齐"前置条件: 与 CPU 路径同判 (缺源码的 pass 不试 GPU, 直接交回 CPU 记错)
    if (def.passes.some((p) => !p.frag)) return null;
    const W = img.width, H = img.height;
    const chains = this._fxJsonCombos(def, ef);
    const byFragRel = new Map();
    for (const p of def.passes) if (p.fragRel && !byFragRel.has(p.fragRel)) byFragRel.set(p.fragRel, p);
    // passShader: gl-multipass 按 pass.material 逐 pass 索要编译结果。
    // key 用材质路径 (与 def.passes[i].material 同源), miss 时回落到"首个未消费的 pass"。
    const compiledByPass = new Map();
    const compileForPass = (p) => {
      const chain = chains[p.index] || { combos: {} };
      const combos = {};
      for (const [k, v] of Object.entries(chain.combos)) combos[k] = comboStr(v);
      let fragX = p.fragX, vertX = p.vertX || null;
      // shaderPatch: 与 CPU 路径同序 (shaderStem → fragRel → material; core 侧再做 basename 匹配)
      if (this._applyShaderPatch) {
        for (const k of [p.shaderStem, p.fragRel, p.material].filter(Boolean)) {
          const nf = this._applyShaderPatch(k, fragX, 'fragment');
          const nv = vertX ? this._applyShaderPatch(k, vertX, 'vertex') : null;
          if (nf !== fragX || (nv && nv !== vertX)) { fragX = nf; if (nv) vertX = nv; break; }
        }
      }
      return compileGlsl({
        fragSource: fragX,
        vertSource: vertX,
        combos,
        resolveInclude: def.resolveInclude,
        onWarn: () => {},
      });
    };
    const usedPasses = new Set();
    // 逐 pass 取证缓冲 (DSH_WE_FX_DUMP=1): GPU 版同样把"target/尺寸/各槽位绑到哪个 RT/
    // 编译源签名/像素摘要"记下来 —— 与 CPU 侧的 FX-DUMP 行并排才能判定两侧是否逐 pass 一致。
    const passTrace = dumpFxOn() ? [] : null;
    const passShader = (materialPath) => {
      let p = byFragRel.get(materialPath);
      if (!p) p = def.passes.find((q) => q.material === materialPath && !usedPasses.has(q.index));
      if (!p) p = def.passes.find((q) => !usedPasses.has(q.index));
      if (!p) return null;
      usedPasses.add(p.index);
      if (!compiledByPass.has(p.index)) compiledByPass.set(p.index, compileForPass(p));
      return compiledByPass.get(p.index);
    };
    // uPerPass: 与 CPU `_fxJsonRenderPass` 同一套 uniform/sampler 组装。
    // 差异只在"纹理从哪来"—— FBO 链由 gl-multipass 维护, 这里拿到的是它已解析好的 bound[]。
    const uPerPass = (pass, compiled, inputTex, bound, outW, outH) => {
      const p = [...compiledByPass.entries()].find(([, c]) => c === compiled);
      const idx = p ? p[0] : (pass.index != null ? pass.index : 0);
      const textures = bound || [];
      const sceneP = (ef.passes && ef.passes[idx]) || {};
      const defP = def.passes[idx] || {};
      const constants = Object.assign({}, defP.materialConstants || {}, sceneP.constantshadervalues || {});
      const texInfo = this._fxJsonTextures(def, ef, idx);
      // 诊断取证 (DSH_WE_FX_DUMP=1): 与 CPU 路径同一批字段, 便于逐 pass 并排对照
      if (dumpFxOn()) {
        const binds = textures.map((tx, k) => {
          const ref = texInfo.refs[k];
          const nm = ref === 'previous' ? 'previous' : (ref == null ? '-' : String(ref).slice(0, 28));
          return k + ':' + nm + (tx && tx.width ? '(' + tx.width + 'x' + tx.height + ')' : '(null)');
        });
        const rec = passTrace.find((x) => x.pass === pass);
        if (rec) {
          rec.binds = binds;
          // 编译源签名取自解析记录 (含 shaderPatch / combo 展开后的源码), 与 CPU 侧 `src=` 同义
          rec.src = String(defP.fragX || '').slice(0, 60).replace(/\s+/g, ' ');
        }
      }
      const u = buildUniforms(compiled.uniforms, constants, {
        time: t || 0,
        textures,
        objW: W, objH: H,
        userAlpha: 1,
        parallaxPosition: this.optsMouse ? [this.optsMouse.x, this.optsMouse.y] : [0.5, 0.5],
      });
      // sampler 补绑 (与 CPU 路径逐条对齐):
      //   ① 元注释表 compiled.uniforms —— undefined 与 null 一视同仁 (buildUniforms 对
      //      "无常量/无默认值" 的 sampler 显式给 null, 只判 undefined 会漏 ⇒ 采样器为
      //      null ⇒ GPU 绑白纹理而 CPU 兜底, 两侧分歧);
      //   ② 兜底扫 fragPre 里**实际声明**的 sampler (无 // {...} 元注释的声明不进 ①)。
      for (const [un, info] of Object.entries(compiled.uniforms)) {
        if (info.type === 'sampler2D' && (u[un] === undefined || u[un] === null)) {
          const i = Number((/g_Texture(\d+)/.exec(un) || [])[1] || 0);
          u[un] = textures[i] || null;
        }
      }
      const pre = compiled.fragPre || '';
      if (pre.indexOf('sampler2D') >= 0) {
        for (const mm of pre.matchAll(/uniform\s+sampler2D\s+([A-Za-z_]\w*)/g)) {
          const un = mm[1];
          if (u[un] === undefined || u[un] === null) {
            const i = Number((/g_Texture(\d+)/.exec(un) || [])[1] || 0);
            u[un] = textures[i] || null;
          }
        }
      }
      // 环绕语义: 与 CPU `_fxJsonRenderPass` 逐槽一致 —— 槽 0 = 本 pass 输入 (CLAMP),
      // 其余槽 (位移/噪声/遮罩/RT) = REPEAT。gl-effect 的 wrapFor 读这两个标记。
      for (let k = 1; k < textures.length; k++) if (textures[k]) textures[k].__glslRepeat = true;
      if (textures[0]) textures[0].__glslRepeat = false;
      return u;
    };
    try {
      // 喂给 gl-multipass 的 ef: fbos 取自 def.json (scale/format 与 CPU 同源), passes 为
      // 原始声明 (material/target/bind), 顺序与 def.passes 一一对应。
      // 喂给 gl-multipass 的 ef: fbos 取自 def.json (scale/format 与 CPU 同源); passes 用
      // **解析后的 def.passes 复制件**, 但 `bind` 换成 CPU 侧同一套解析结果 ——
      // runMultiPassOnGL 只认 `pass.bind`, 而真实 effect.json 里很多 pass **不写 bind**
      // (blurprecise 的 pass0 就没有), CPU 侧 `_fxJsonRenderPass` 这时会回落到材质/实例的
      // `textures` 列表。若只把原始 bind 传下去, 那些槽位在 GPU 侧恒为未绑定 ⇒ 采样得白纹理
      // ⇒ 整个 pass 纯白 (实测 FX-DUMP(GPU) 的 binds= 为空 / mean=255 即此)。
      // ⚠️ 不要直接用 def.json.passes: 那是另一批对象, 没有 fragX ⇒ passShader 找不到编译源。
      const gpuPasses = def.passes.map((p) => {
        const ti = this._fxJsonTextures(def, ef, p.index);
        const bind = [];
        for (let k = 0; k < ti.refs.length; k++) {
          const r = ti.refs[k];
          if (r === undefined || r === null) continue;
          bind.push({ index: k, name: r });
        }
        return { ...p, bind };
      });
      const gpuEf = { fbos: def.json.fbos || [], passes: gpuPasses };
      const onPass = dumpFxOn()
        ? (pass, out, ctx) => {
          // 逐 pass 取证: 与 effectjson.js 的 'FX-DUMP <name> passN → target …' 同一字段顺序,
          // 前缀改 FX-DUMP(GPU) 便于两侧并排 diff。
          const rec = ctx.rec;
          this.log('FX-DUMP(GPU) ' + name + ' pass' + (rec ? rec.idx : '?')
            + ' → ' + (ctx.target || '(direct)') + ' ' + out.width + 'x' + out.height
            + ' binds=' + ((rec && rec.binds) || []).join(',')
            + ' src=' + ((rec && rec.src) || '?')
            + ' ' + summarizeRgba(out));
        }
        : null;
      const out = runMultiPassOnGL({ ef: gpuEf, img, passShader, uPerPass, onPass, passTrace });
      if (!out || !out.rgba || !out.width || !out.height) return null;
      stats.used += def.passes.length;
      _gpuFailStreak = 0;
      // 尺寸契约与 CPU 一致: 中间 pass 写 target (可能降采样), 最终结果必须回到输入尺寸,
      // 否则调用方拿到的是"缩小过的图"(CPU 侧同样在末尾 upsample)。
      if (out.width !== W || out.height !== H) {
        if (!this._upsampleRgba) return null;
        return this._upsampleRgba(out, W, H);
      }
      return out;
    } catch (e) {
      this._noteGpuFailure(e);
      return null;
    }
  };
}
