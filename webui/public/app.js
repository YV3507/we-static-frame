// we-static-frame · WebUI —— 浏览器侧逻辑（零框架、零构建）
//
// 分工：浏览器只负责"选壁纸 + 攒配置 + 显示结果"，真正的渲染在服务端子进程里跑
// （见 ../serve.mjs 与 ../render-worker.mjs）。因此这里没有任何 GL 代码。
import { getState, setState, subscribe, patchResult } from './state.js';

// ── 小工具 ────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(path + ' → HTTP ' + r.status);
  return r.json();
};
const postJson = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const BASE = document.title; // 用于下载文件名前缀

// ── 诊断开关说明（key 必须与服务端白名单一致）────────────────────────────
const DEBUG_KEYS = [
  ['DSH_WE_FX_DUMP', '逐 pass 取证：target/尺寸/各槽位绑到哪个 RT/编译源签名/像素摘要（排查"哪个 pass 先变常量"）'],
  ['DSH_WE_FX_TRACE', '生成 JS 的出错行（运行期异常的定位）'],
  ['DSH_WE_NO_FX', '效果链整体短路，量"完全不启用效果"的下界'],
  ['DSH_WE_NO_FXJSON', '关掉 effect.json 数据驱动通路（回到猜名通路）'],
  ['DSH_WE_NO_FXJSON_GPU', '关掉"数据通路多 pass 走 GPU"（issue #4① 的 A/B 臂）'],
  ['DSH_WE_NO_FX_CHAIN', '关掉 GPU 链式执行'],
  ['DSH_WE_CHAIN_VERIFY', '链式结果与"逐效果单独走 GPU"逐位对比'],
  ['DSH_WE_DEBUG_GLSL', 'gpu-gl 单 pass 的输出统计'],
  ['DSH_WE_PROFILE', '分阶段耗时剖析'],
  ['DSH_WE_RT_ALL', '保留每个对象的合成结果（DSH_RT_ALL 的等价开关）'],
  ['DSH_WE_NO_SEED_VTEXCOORD', '关掉 v_TexCoord 播种（issue #2 的 A/B 臂）'],
];

// ── 配置收集：UI → 服务端 job ─────────────────────────────────────────────
function splitList(v) {
  return String(v || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
}

function buildJob() {
  const s = getState();
  const render = {
    width: Number($('#width').value) || 960,
    height: Number($('#height').value) || 540,
    time: $('#time').value === '' ? 2.5 : Number($('#time').value),
    warm: $('#warm').checked,
    gpuAccel: $('#gpuAccel').checked,
    weAssetsDir: $('#weAssets').value.trim() || null,
  };
  const mode = $('#gpuMode').value;
  const failStreak = $('#failStreak').value;
  if (mode) {
    if ($('#gpuPolicyObj').checked) {
      const g = { mode };
      if (failStreak !== '') g.failStreakLimit = Number(failStreak);
      const allow = splitList($('#fxAllow').value);
      const deny = splitList($('#fxDeny').value);
      if (allow.length) g.allowEffects = allow;
      if (deny.length) g.denyEffects = deny;
      render.gpu = g;
      render.gpuAccel = true;
    } else {
      render.gpu = mode;
      if (mode !== 'off') render.gpuAccel = true;
    }
  } else if (failStreak !== '' && render.gpuAccel) {
    render.gpu = { mode: 'auto', failStreakLimit: Number(failStreak) };
  }

  const vf = $('#videoFrames').value.trim();
  if (vf) { try { render.videoFrames = JSON.parse(vf); } catch { /* 忽略非法 JSON，渲染时按未填处理 */ } }

  const effects = {};
  const allow = splitList($('#fxAllow').value);
  const deny = splitList($('#fxDeny').value);
  if (allow.length) effects.allow = allow;
  if (deny.length) effects.deny = deny;
  if (!$('#skipDegenerate').checked) effects.skipDegenerate = false;
  const backends = {};
  for (const [name, b] of Object.entries(s.effectBackend)) if (b) backends[name] = b;
  if (Object.keys(backends).length) effects.backend = backends;

  const policy = {};
  const backendAll = $('#backendAll').value;
  if (backendAll) policy.decideBackendAll = backendAll;

  const debug = {};
  for (const k of s.debugOn) debug[k] = true;

  // 逐对象/逐效果：勾掉的写进 hide 列表
  const hideObjects = [];
  const hideEffects = [];
  if (s.chain) {
    for (const o of s.chain.objects || []) {
      if (o.visible === false) hideObjects.push(o.index);
      for (const f of o.effects || []) {
        if (f.visible === false && o.visible !== false) hideEffects.push({ object: o.index, index: f.index });
      }
    }
  }

  const job = { input: s.selected, render, effects, policy, debug, hideObjects, hideEffects };
  if (Object.keys(backends).length) job.policy.perEffectBackend = backends;
  const patches = patchesFromUI();
  if (patches.length) job.shaderPatch = patches;
  return job;
}

function patchesFromUI() {
  const out = [];
  for (const p of $$('#patchList .patch')) {
    const key = p.querySelector('.pkey').value.trim();
    const from = p.querySelector('.pfrom').value;
    const to = p.querySelector('.pto').value;
    const flags = p.querySelector('.pflags').value.trim();
    if (key && from) out.push({ key, from, to, flags });
  }
  return out;
}

// ── 渲染 ──────────────────────────────────────────────────────────────────
let renderSeq = 0;
async function doRender() {
  const s = getState();
  if (!s.selected) { setState({ status: 'bad', statusText: '先选一个场景' }); return; }
  const seq = ++renderSeq;
  setState({ status: 'running', statusText: '渲染中…', running: true });
  const t0 = performance.now();
  try {
    const r = await postJson('/api/render', buildJob());
    if (seq !== renderSeq) return; // 已有更新的请求，丢弃本次
    if (!r.ok) {
      patchResult({
        error: r.error, code: r.code || null, logs: r.logs || [], wallMs: r.wallMs,
      });
      setState({ status: 'bad', statusText: '失败: ' + String(r.error).slice(0, 60) });
      return;
    }
    patchResult({ ...r, receivedMs: Math.round(performance.now() - t0) });
    const deg = (r.degraded || []).length;
    setState({
      status: 'ok',
      statusText: '完成 ' + r.ms + 'ms' + (r.blank ? ' · 空白帧' : '') + (deg ? ' · 降级 ' + deg : ''),
    });
  } catch (e) {
    if (seq !== renderSeq) return;
    patchResult({ error: String(e.message || e), logs: [] });
    setState({ status: 'bad', statusText: '请求失败' });
  } finally {
    if (seq === renderSeq) setState({ running: false });
  }
}

// ── 场景列表 ──────────────────────────────────────────────────────────────
async function loadScenes() {
  try {
    const r = await api('/api/scenes');
    setState({ scenes: r.scenes || [], skippedScenes: r.skipped || [], workshopRoots: r.roots || [] });
  } catch (e) {
    setState({ scenes: [], sceneError: String(e.message || e) });
  }
}

async function loadUploads() {
  try {
    const r = await api('/api/uploads');
    setState({ uploads: r.uploads || [] });
  } catch { /* ignore */ }
}

function selectScene(path) {
  setState({ selected: path, chain: null, result: null });
  loadChain(path);
}

async function loadChain(path) {
  const box = $('#chainTree');
  box.replaceChildren(el('div', 'dim small', '解析场景中…'));
  try {
    const r = await api('/api/scene?path=' + encodeURIComponent(path));
    if (!r.ok) { box.replaceChildren(el('div', 'dim small', r.error)); return; }
    setState({ chain: r.scene });
  } catch (e) {
    box.replaceChildren(el('div', 'dim small', String(e.message || e)));
  }
}

// ── 渲染 UI ───────────────────────────────────────────────────────────────
function renderEnvLine(s) {
  const h = s.health;
  if (!h) { $('#envLine').textContent = s.healthError ? '环境自检失败: ' + s.healthError : '环境自检中…'; return; }
  $('#envLine').textContent = 'node ' + h.node + ' · ' + h.arch
    + ' · WE assets ' + (h.weAssetsDir ? '✓' : '✗（效果链会退化）')
    + ' · headless-gl ' + (h.headlessGl ? '✓' : '✗')
    + ' · 场景根 ' + (h.workshopRoots || []).length;
}

function renderSceneList(s) {
  const box = $('#sceneList');
  const scenes = s.scenes || [];
  $('#sceneCount').textContent = String(scenes.length);
  if (s.sceneError) { box.replaceChildren(el('div', 'dim small', s.sceneError)); return; }
  if (!scenes.length) { box.replaceChildren(el('div', 'dim small', '没扫描到场景（可设 WE_SF_WORKSHOP_ROOT 或直接拖拽上传）')); return; }
  const skipped = s.skippedScenes || [];
  const nodes = scenes.map((sc) => {
    const n = el('div', 'scene' + (s.selected === sc.pkg ? ' active' : ''));
    const left = el('span');
    left.append(el('span', 'id', sc.id));
    // 已解包标记：只有解包目录能用逐对象/逐效果开关
    if (sc.unpackedDir) { const t = el('span', 'tag ok', '已解包'); left.append(t); }
    n.append(left);
    const right = el('span', 'meta');
    right.append(sc.sizeMB + 'MB');
    if (!sc.unpackedDir) {
      const b = el('button', 'link unpack', '解包');
      b.title = '落成松散场景目录 → 可用逐对象/逐效果开关';
      b.onclick = async (ev) => {
        ev.stopPropagation();
        b.textContent = '解包中…'; b.disabled = true;
        try {
          const r = await postJson('/api/unpack', { input: sc.pkg });
          if (!r.ok) { b.textContent = '失败'; b.title = r.error || ''; return; }
          await loadScenes();
        } catch (e) { b.textContent = '失败'; b.title = String(e.message || e); }
      };
      right.append(b);
    }
    n.append(right);
    n.onclick = () => selectScene(sc.unpackedDir || sc.pkg);
    return n;
  });
  // 被排除的条目（Video / Web 壁纸）单独说明，别让用户以为漏了
  if (skipped.length) {
    const h = el('div', 'listHead', '不支持的条目 ' + skipped.length + ' 个');
    nodes.push(h);
    for (const sk of skipped) {
      const n = el('div', 'scene dim');
      n.append(el('span', 'id', sk.id));
      n.append(el('span', 'meta', sk.reason || ''));
      nodes.push(n);
    }
  }
  box.replaceChildren(...nodes);
}

/** 效果链面板顶部的「这需要解包」提示条。 */
function renderUnpackBar(s) {
  const bar = $('#unpackBar');
  const sc = (s.scenes || []).find((x) => x.pkg === s.selected);
  if (!sc) { bar.classList.add('hidden'); return; }
  if (sc.unpackedDir) {
    bar.classList.remove('hidden');
    bar.textContent = '✓ 已解包（' + sc.unpackedDir + '）—— 逐对象/逐效果开关可用。';
    return;
  }
  bar.classList.remove('hidden');
  bar.replaceChildren();
  bar.append(document.createTextNode('scene.pkg 里的 scene.json 封在 PKG 容器内，逐对象/逐效果开关需要先解包： '));
  const b = el('button', 'link', '解包这个场景');
  b.onclick = async () => {
    b.textContent = '解包中…'; b.disabled = true;
    try {
      const r = await postJson('/api/unpack', { input: sc.pkg });
      if (!r.ok) { b.textContent = '解包失败: ' + (r.error || ''); return; }
      await loadScenes();
      selectScene(r.input);
    } catch (e) { b.textContent = '解包失败: ' + String(e.message || e); }
  };
  bar.append(b);
}

function renderUploads(s) {
  const wrap = $('#uploadListWrap');
  wrap.classList.toggle('hidden', !(s.uploads || []).length);
  const box = $('#uploadList');
  box.replaceChildren(...(s.uploads || []).map((u) => {
    const n = el('div', 'scene' + (s.selected === u.dir ? ' active' : ''));
    n.append(el('span', 'id', u.name));
    const del = el('button', 'link', '删除');
    del.onclick = async (ev) => { ev.stopPropagation(); await postJson('/api/upload/delete', { name: u.name }); loadUploads(); };
    n.append(del);
    n.onclick = () => selectScene(u.dir);
    return n;
  }));
}

function renderChain(s) {
  const box = $('#chainTree');
  const c = s.chain;
  if (!c) { box.replaceChildren(el('div', 'dim small', s.selected ? '解析中…' : '选中场景后自动列出对象与效果。')); $('#chainSummary').textContent = '先选一个场景'; return; }
  $('#chainSummary').textContent = c.counts.objects + ' 个对象 · ' + c.counts.effects + ' 个效果 · ' + c.width + '×' + c.height
    + ' · ' + (c.weAssetsDir ? 'assets ✓' : 'assets ✗');
  box.replaceChildren(...(c.objects || []).map((o) => {
    const wrap = el('div', 'obj' + (o.visible ? '' : ' off'));
    const head = el('div', 'objHead');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = o.visible;
    cb.onchange = () => { o.visible = cb.checked; wrap.classList.toggle('off', !cb.checked); setState({ chain: c }); };
    head.append(cb, el('span', 'type', o.type));
    head.append(el('span', 'nm', (o.name || ('#' + o.id)) + (o.width ? '  ' + o.width + '×' + o.height : '')));
    wrap.append(head);
    for (const f of o.effects || []) {
      const row = el('div', 'fx' + (f.visible ? '' : ' off'));
      const fcb = el('input'); fcb.type = 'checkbox'; fcb.checked = f.visible;
      fcb.onchange = () => {
        f.visible = fcb.checked;
        row.classList.toggle('off', !fcb.checked);
        setState({ chain: c });
      };
      row.append(fcb, el('span', 'nm', f.name || f.file || '?'));
      row.append(el('span', 'passes', f.passes + ' pass'));
      // 逐效果后端（比 allow/deny 更细：同名效果也能分别指定）
      const sel = el('select');
      for (const [v, t] of [['', '默认'], ['auto', 'auto'], ['cpu', 'cpu'], ['gpu', 'gpu'], ['gpu-only', 'gpu-only']]) {
        const opt = el('option', null, t); opt.value = v; sel.append(opt);
      }
      sel.style.width = '96px';
      sel.value = getState().effectBackend[f.name] || '';
      sel.onchange = () => {
        const b = { ...getState().effectBackend };
        if (sel.value) b[f.name] = sel.value; else delete b[f.name];
        setState({ effectBackend: b });
      };
      row.append(sel);
      wrap.append(row);
    }
    return wrap;
  }));
}

function renderDebug(s) {
  const box = $('#debugList');
  if (box.dataset.built === '1') return;
  box.dataset.built = '1';
  box.replaceChildren(...DEBUG_KEYS.map(([k, desc]) => {
    const l = el('label');
    const cb = el('input'); cb.type = 'checkbox';
    cb.checked = s.debugOn.has(k);
    cb.onchange = () => {
      const set = new Set(getState().debugOn);
      if (cb.checked) set.add(k); else set.delete(k);
      setState({ debugOn: set });
    };
    const mid = el('div');
    mid.append(el('code', null, k), el('div', 'desc', desc));
    l.append(cb, mid);
    return l;
  }));
}

function fmtBytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : (n / 1024).toFixed(1) + 'KB'; }

function renderResult(s) {
  const r = s.result;
  const img = $('#preview');
  if (!r) {
    $('#resultMeta').replaceChildren(el('span', 'dim', '尚未渲染'));
    img.classList.remove('show'); $('#placeholder').style.display = '';
    $('#btnDownload').disabled = true;
    $('#cntDegraded').textContent = '0'; $('#cntDecisions').textContent = '0'; $('#cntLogs').textContent = '0';
    $('#degradedList').replaceChildren(el('div', 'dim', '—'));
    $('#decisionsTable').replaceChildren(el('div', 'dim', '—'));
    $('#gpuBox').textContent = '—'; $('#logBox').textContent = '—';
    return;
  }
  if (r.error) {
    $('#resultMeta').replaceChildren(el('span', 'pill warn', '错误'), el('span', 'dim', String(r.error).slice(0, 160)));
  } else {
    const pills = [];
    pills.push(el('span', 'pill', r.width + '×' + r.height));
    pills.push(el('span', 'pill', fmtBytes(r.bytes)));
    pills.push(el('span', 'pill', '渲染 ' + r.ms + 'ms'));
    pills.push(el('span', 'pill', '往返 ' + (r.wallMs != null ? r.wallMs : r.receivedMs) + 'ms'));
    pills.push(el('span', 'pill' + (r.blank ? ' warn' : ' ok'), r.blank ? '空白帧' : 'mean ' + r.meanLuma));
    const deg = (r.degraded || []).length;
    pills.push(el('span', 'pill' + (deg ? ' warn' : ' ok'), '降级 ' + deg));
    $('#resultMeta').replaceChildren(...pills);
    img.src = 'data:image/png;base64,' + r.png;
    img.classList.add('show'); $('#placeholder').style.display = 'none';
    $('#btnDownload').disabled = false;
  }
  $('#lastMs').textContent = r.logs ? r.logs.length + ' 行日志' : '';

  // 降级
  const dbox = $('#degradedList');
  const degs = r.degraded || [];
  $('#cntDegraded').textContent = String(degs.length);
  dbox.replaceChildren(...(degs.length ? degs.map((d) => {
    const n = el('div', 'kv' + (/视频|失败|退化|越界|编译/.test(d.action || '') ? ' bad' : ''));
    n.append(el('span', 'feat', d.feature));
    if (d.object) n.append(el('span', 'who', ' @' + d.object));
    n.append(el('div', 'act', d.action || ''));
    return n;
  }) : [el('div', 'dim', '无降级 ✓')]));

  // 决策
  const items = (r.decisions && r.decisions.items) || [];
  $('#cntDecisions').textContent = String(items.length);
  if (!items.length) $('#decisionsTable').replaceChildren(el('div', 'dim', '无决策记录（未使用策略接口）'));
  else {
    const t = el('table', 'dec');
    const thead = el('thead'); const hr = el('tr');
    for (const h of ['效果', '图层', '动作', '后端', '来源', '原因']) hr.append(el('th', null, h));
    thead.append(hr); t.append(thead);
    const tb = el('tbody');
    for (const d of items) {
      const tr = el('tr');
      tr.append(el('td', null, String(d.effect)));
      tr.append(el('td', null, d.layer == null ? '-' : String(d.layer)));
      tr.append(el('td', 'act-' + d.action, d.action));
      tr.append(el('td', null, d.backend || '-'));
      tr.append(el('td', null, d.source || '-'));
      tr.append(el('td', null, String(d.reason || '').slice(0, 70)));
      tb.append(tr);
    }
    t.append(tb);
    $('#decisionsTable').replaceChildren(t);
  }

  // GPU
  $('#gpuBox').textContent = r.gpuStats ? JSON.stringify(r.gpuStats, null, 1)
    + '\n\n生效配置: ' + JSON.stringify(r.effective || {}, null, 1) : '—';
  const logs = r.logs || [];
  $('#cntLogs').textContent = String(logs.length);
  $('#logBox').textContent = logs.length ? logs.join('\n') : '（无日志）';
  $('#logBox').scrollTop = $('#logBox').scrollHeight;
}

// ── 上传 ──────────────────────────────────────────────────────────────────
async function uploadFiles(files) {
  if (!files || !files.length) return;
  const fd = new FormData();
  for (const f of files) {
    // 目录上传时保留相对路径（拖拽目录时 webkitRelativePath 为空，退化成文件名）
    const rel = f.webkitRelativePath || f.name;
    fd.append('files', f, rel);
  }
  $('#uploadState').textContent = '上传 ' + files.length + ' 个文件…';
  try {
    const r = await api('/api/upload', { method: 'POST', body: fd });
    if (!r.ok) { $('#uploadState').textContent = '✗ ' + r.error; return; }
    $('#uploadState').textContent = '✓ ' + r.files.length + ' 个文件 → ' + r.dir + (r.hint ? '（' + r.hint + '）' : '');
    await loadUploads();
    if (r.input) selectScene(r.input);
  } catch (e) {
    $('#uploadState').textContent = '✗ ' + String(e.message || e);
  }
}

function wireDrop() {
  const drop = $('#drop');
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { stop(e); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { stop(e); drop.classList.remove('over'); });
  drop.addEventListener('drop', async (e) => {
    const items = e.dataTransfer.items;
    const files = [];
    if (items && items.length && items[0].webkitGetAsEntry) {
      // 目录拖拽：逐个递归读 entry（DataTransferItemList 在 await 后会失效，必须同步取 entry）
      const entries = [];
      for (const it of items) { const en = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (en) entries.push(en); }
      for (const en of entries) await collectEntry(en, '', files);
    } else {
      for (const f of e.dataTransfer.files) files.push({ file: f, rel: f.name });
    }
    if (!files.length) { $('#uploadState').textContent = '没读到文件（目录拖拽需要浏览器支持 webkitGetAsEntry）'; return; }
    await uploadFilesWithRel(files);
  });
}

function collectEntry(entry, prefix, out) {
  return new Promise((resolveDone) => {
    if (entry.isFile) {
      entry.file((f) => { out.push({ file: f, rel: prefix + entry.name }); resolveDone(); }, () => resolveDone());
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const readBatch = () => reader.readEntries(async (batch) => {
        if (!batch.length) {
          for (const en of all) await collectEntry(en, prefix + entry.name + '/', out);
          resolveDone();
          return;
        }
        all.push(...batch);
        readBatch();
      }, () => resolveDone());
      readBatch();
      return;
    }
    resolveDone();
  });
}

async function uploadFilesWithRel(items) {
  const fd = new FormData();
  for (const it of items) fd.append('files', it.file, it.rel);
  $('#uploadState').textContent = '上传 ' + items.length + ' 个文件…';
  try {
    const r = await api('/api/upload', { method: 'POST', body: fd });
    if (!r.ok) { $('#uploadState').textContent = '✗ ' + r.error; return; }
    $('#uploadState').textContent = '✓ ' + r.files.length + ' 个文件 → ' + r.dir + (r.hint ? '（' + r.hint + '）' : '');
    await loadUploads();
    if (r.input) selectScene(r.input);
  } catch (e) {
    $('#uploadState').textContent = '✗ ' + String(e.message || e);
  }
}

// ── 事件绑定 ──────────────────────────────────────────────────────────────
function wire() {
  $('#btnRender').onclick = doRender;
  $('#btnReloadScenes').onclick = loadScenes;
  $('#btnClearUploads').onclick = async () => {
    for (const u of getState().uploads || []) await postJson('/api/upload/delete', { name: u.name });
    loadUploads();
  };
  $('#btnUsePath').onclick = () => { const v = $('#pathInput').value.trim(); if (v) selectScene(v); };
  $('#pathInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnUsePath').click(); });

  $('#btnPickFiles').onclick = () => $('#fileInput').click();
  $('#btnPickDir').onclick = () => $('#dirInput').click();
  $('#fileInput').onchange = (e) => uploadFiles([...e.target.files]);
  $('#dirInput').onchange = (e) => uploadFilesWithRel([...e.target.files].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name })));
  wireDrop();

  // 分辨率 / 时间预设
  for (const b of $$('#resPresets button')) b.onclick = () => {
    $('#width').value = b.dataset.w; $('#height').value = b.dataset.h;
    $$('#resPresets button').forEach((x) => x.classList.toggle('active', x === b));
  };
  for (const b of $$('#timePresets button')) b.onclick = () => {
    $('#time').value = b.dataset.t;
    $$('#timePresets button').forEach((x) => x.classList.toggle('active', x === b));
  };

  // 主/结果 tab
  for (const b of $$('#tabs button')) b.onclick = () => {
    $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === b.dataset.tab));
  };
  for (const b of $$('.resultTabs button')) b.onclick = () => {
    $$('.resultTabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.rtab').forEach((t) => t.classList.toggle('active', t.dataset.rtab === b.dataset.rtab));
  };

  // 效果链 全开 / 全关效果
  $('#btnAllOn').onclick = () => { const c = getState().chain; if (!c) return; for (const o of c.objects) { o.visible = true; for (const f of o.effects) f.visible = true; } setState({ chain: c }); };
  $('#btnAllOff').onclick = () => { const c = getState().chain; if (!c) return; for (const o of c.objects) for (const f of o.effects) f.visible = false; setState({ chain: c }); };

  // 着色器补丁
  $('#btnAddPatch').onclick = () => { addPatchRow({ key: '', from: '', to: '', flags: 'g' }); };

  // 下载
  $('#btnDownload').onclick = () => {
    const r = getState().result;
    if (!r || !r.png) return;
    const a = document.createElement('a');
    a.href = 'data:image/png;base64,' + r.png;
    a.download = 'we-sf-' + (getState().selected || 'scene').replace(/[^\w.\-]+/g, '_').slice(-40) + '-' + Date.now() + '.png';
    a.click();
  };

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey && !/input|textarea|select/i.test(e.target.tagName)) { e.preventDefault(); doRender(); }
  });
}

function addPatchRow(p) {
  const box = el('div', 'patch');
  const g3 = el('div', 'grid3');
  const key = el('input', 'pkey'); key.placeholder = 'key（效果名/着色器 stem，如 gaussian）'; key.value = p.key || '';
  const from = el('input', 'pfrom'); from.placeholder = 'from（正则，如 void\\s+main\\s*\\(\\)\\s*\\{)'; from.value = p.from || '';
  const flags = el('input', 'pflags'); flags.placeholder = 'flags'; flags.value = p.flags || 'g';
  g3.append(key, from, flags);
  const to = el('input', 'pto'); to.placeholder = 'to（替换文本）'; to.value = p.to || '';
  const del = el('button', 'link del', '删除');
  del.onclick = () => box.remove();
  box.append(g3, to, del);
  $('#patchList').append(box);
}

// ── 渲染订阅 ──────────────────────────────────────────────────────────────
let built = false;
subscribe((s) => {
  renderEnvLine(s);
  renderSceneList(s);
  renderUploads(s);
  renderUnpackBar(s);
  renderChain(s);
  if (!built) { renderDebug(s); built = true; }
  renderResult(s);
  const st = $('#renderState');
  st.className = 'state ' + s.status;
  st.textContent = s.statusText || '空闲';
  $('#btnRender').disabled = !!s.running;
  $('#btnRender').textContent = s.running ? '渲染中…' : '渲染 (R)';
});

// ── 启动 ──────────────────────────────────────────────────────────────────
(async () => {
  wire();
  addPatchRow({ key: 'gaussian', from: 'void\\s+main\\s*\\(\\)\\s*\\{', to: 'void main() { gl_FragColor = texSample2D(g_Texture0, v_TexCoord.xy); return;', flags: 'g' });
  try { setState({ health: await api('/api/health') }); } catch (e) { setState({ healthError: String(e.message || e) }); }
  await Promise.all([loadScenes(), loadUploads()]);
  console.log('[webui] ready');
})();
