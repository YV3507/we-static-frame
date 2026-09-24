// WebUI — 极简状态中心（发布/订阅，深合并式 setState）
//
// 之所以不用框架：这个 UI 的结构是固定的三段（导入 / 配置 / 结果），渲染结果一次到位，
// 上框架只会增加一个构建步骤。订阅者只做"按状态重画"。

const state = {
  health: null,
  healthError: null,
  scenes: [],
  workshopRoots: [],
  sceneError: null,
  uploads: [],
  selected: null,        // 当前场景路径
  chain: null,           // 场景内省结果 { objects: [...] }（勾选状态也挂在这里）
  effectBackend: {},     // { 效果名: 'cpu' | 'gpu' | 'gpu-only' | 'auto' }
  debugOn: new Set(),    // 打开的 DSH_WE_* 开关
  result: null,          // 最近一次渲染结果
  status: 'idle',        // idle | running | ok | bad
  statusText: '空闲',
  running: false,
};

const subs = new Set();

/** 取当前状态（**只读约定**：调用方不要直接改它，改状态一律走 setState）。 */
export function getState() { return state; }

/**
 * 浅合并式写入：
 *   · 顶层键直接覆盖；
 *   · `chain` 特殊处理 —— 勾选状态挂在 chain.objects 上，重画时用同一个对象引用，
 *     避免 setState({chain}) 把 UI 上的勾选状态丢掉。
 */
export function setState(patch) {
  if (patch && typeof patch === 'object') {
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'chain' && v && state.chain) {
        // 就地替换（勾选状态已写进传入的 c 对象里，这里只换引用）
        state.chain = v;
        continue;
      }
      state[k] = v;
    }
  }
  emit();
}

/** 局部更新渲染结果（渲染流程用，避免整份结果被重建）。 */
export function patchResult(part) {
  state.result = { ...(state.result || {}), ...(part || {}) };
  emit();
}

export function resetResult() {
  state.result = null;
  emit();
}

export function subscribe(fn) {
  subs.add(fn);
  fn(state);
  return () => subs.delete(fn);
}

function emit() {
  for (const fn of subs) {
    try { fn(state); } catch (e) { console.error('[state] 订阅者抛错', e); }
  }
}
