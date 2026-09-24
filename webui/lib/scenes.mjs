// WebUI 服务端 — 场景发现与内省
//
// 职责: 把"本机有哪些壁纸"与"某个壁纸里有哪些对象/效果（供逐条开关）"整理成 JSON,
// 交给浏览器 UI。**只读 + 只依赖 renderFrame/SceneRenderer 的公开导出**, 不改 src/。
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { SceneRenderer } from '../../src/scene-renderer.js';
import { locateWeAssets, steamRootCandidates } from '../../src/render.js';

/** workshop 场景根目录候选（与本仓库 test/ 下各处同一套来源）。 */
export function workshopRoots() {
  const out = [];
  const env = process.env.WE_SF_WORKSHOP_ROOT;
  if (env && existsSync(env)) out.push(env);
  for (const r of steamRootCandidates()) {
    const p = join(r, 'steamapps', 'workshop', 'content', '431960');
    if (existsSync(p)) out.push(p);
  }
  return [...new Set(out)];
}

/** 入参可能是 scene.pkg、场景目录、或项目内的任意 json —— 统一成一个"可渲染入口"。 */
export function normalizeSceneInput(input) {
  if (!input) return null;
  const p = resolve(String(input));
  try {
    if (statSync(p).isDirectory()) {
      // 目录: 优先 project.json 的 file, 否则交给 renderFrame（它自己会解析）
      return existsSync(join(p, 'scene.pkg')) ? join(p, 'scene.pkg') : p;
    }
  } catch { return null; }
  return p;
}

/**
 * 发现本机场景。返回 [{ id, kind, pkg, sizeMB, mtimeMs, root }]。
 *
 * `kind` 决定"这个条目能不能直接渲染"：
 *   · `pkg`   —— 有 scene.pkg，本渲染器的标准输入；
 *   · `loose` —— 有 scene.json（松散的场景目录），也能渲染，而且**逐对象/逐效果开关**只能在
 *                这种形态上生效（pkg 里改不了 scene.json）；
 *   · `web`   —— 只有 index.html / project.json 的 **Web 壁纸**（另一条渲染路线），
 *                本渲染器不处理 ⇒ 不进列表（避免用户点进去只得到一句"scene.json 不存在"）。
 */
export function listScenes() {
  const scenes = [];
  const seen = new Set();
  const skipped = [];
  for (const root of workshopRoots()) {
    let ids = [];
    try { ids = readdirSync(root); } catch { continue; }
    for (const id of ids) {
      const dir = join(root, id);
      let kind = null;
      let entry = null;
      if (existsSync(join(dir, 'scene.pkg'))) { kind = 'pkg'; entry = join(dir, 'scene.pkg'); }
      else if (existsSync(join(dir, 'scene.json'))) { kind = 'loose'; entry = dir; }
      else { skipped.push({ id, dir, reason: existsSync(join(dir, 'index.html')) ? 'Web 壁纸（index.html，不在本渲染器范围）' : '无 scene.pkg / scene.json' }); continue; }

      const key = resolve(entry).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      let sizeMB = 0, mtimeMs = 0;
      try {
        if (kind === 'pkg') {
          const st = statSync(entry);
          sizeMB = +(st.size / 1048576).toFixed(1);
          mtimeMs = Math.round(st.mtimeMs);
        } else {
          const st = statSync(join(dir, 'scene.json'));
          sizeMB = +(st.size / 1024).toFixed(1); // 松散项目按 scene.json 体积（KB）
          mtimeMs = Math.round(st.mtimeMs);
        }
      } catch { /* ignore */ }
      scenes.push({ id, kind, pkg: resolve(entry), sizeMB, mtimeMs, root });
    }
  }
  // 最近修改的排前面（调壁纸时最常回到刚动过的那个）
  scenes.sort((a, b) => b.mtimeMs - a.mtimeMs);
  scenes.skipped = skipped;
  return scenes;
}

/** 构造渲染器所需的公共参数（不渲染，只为内省/渲染准备）。 */
export function rendererOpts({ width = 960, height = 540, time = 2.5, weAssetsDir = null, gpuAccel = false, policy = null } = {}) {
  return { width, height, time, weAssetsDir: weAssetsDir || locateWeAssets(), gpuAccel, policy };
}

/**
 * 场景内省: 列出对象与效果, 供 UI 做"逐对象/逐效果勾选"。
 *
 * 逐对象 = 数据层 (对象的 visible 字段)；逐效果 = 策略层 (effects.deny / policy.decideEffect,
 * 两者最终都走 effects.js 里同一个 _decideEffect)。这里把两条路径需要的信息都摊平:
 * 对象给出 index/id/name/type/visible, 效果给出 index/file/name(目录名)/visible。
 *
 * 注意: 构造 SceneRenderer 会读 pkg + 解析 scene.json（不渲染、不加载纹理），单次几十毫秒。
 */
export function describeScene(input, opts = {}) {
  const pkg = normalizeSceneInput(input);
  if (!pkg) throw new Error('场景不存在: ' + input);
  const t0 = Date.now();
  const r = new SceneRenderer(pkg, {
    width: opts.width || 960, height: opts.height || 540, time: opts.time || 2.5,
    weAssetsDir: opts.weAssetsDir || locateWeAssets(),
    gpuAccel: false, log: () => {},
  });
  const objects = (r.objects || []).map((o, i) => ({
    index: i,
    id: o.id != null ? String(o.id) : null,
    name: o.name != null ? String(o.name) : null,
    type: o._renderType || 'unknown',
    visible: !(o.visible === false),
    width: o.size ? o.size[0] : null,
    height: o.size ? o.size[1] : null,
    effects: (o.effects || []).map((ef, j) => ({
      index: j,
      file: ef.file != null ? String(ef.file) : null,
      // 与 effects.js 里的效果名口径一致: effects/<name> → <name>
      name: ef.file ? basename(dirname(String(ef.file))) : null,
      visible: !(ef.visible === false),
      passes: (ef.passes || []).length,
    })),
  }));
  return {
    pkg,
    sceneFile: r.sceneFile,
    weAssetsDir: r.weAssetsDir || null,
    width: r.W, height: r.H,
    objects,
    counts: {
      objects: objects.length,
      effects: objects.reduce((a, o) => a + o.effects.length, 0),
      visibleObjects: objects.filter((o) => o.visible).length,
      visibleEffects: objects.reduce((a, o) => a + o.effects.filter((e) => e.visible).length, 0),
    },
    ms: Date.now() - t0,
  };
}

/** 只读地读一个上传/本地目录条目的体积，用于上传回执。 */
export function fileSize(p) {
  try { return readFileSync(p).length; } catch { return 0; }
}
