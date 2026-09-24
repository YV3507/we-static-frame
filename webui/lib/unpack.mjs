// WebUI — scene.pkg → 松散场景目录（解包）
//
// 为什么需要它: 逐对象/逐效果开关走的是**数据层**（改写 scene.json 的 visible 字段），而
// scene.pkg 把 scene.json 及全部资源封在 PKG 容器里（条目多为 LZ4 块链存储）。把 pkg 落成
// 目录后，这些开关就能用，而且松散目录还有额外好处：可以直接读 shaders/materials JSON 排查。
//
// 复用而非重写: `src/pkg-extract.js` 已导出 parsePkg / readPkgEntry（含 LZ4 块链解压，
// 见该文件 probeCompressedEntry —— 用"链条恰好消费完整个条目"来判定是否压缩）。
// 本模块只做"路径安全 + 落盘"，格式知识一律不复制。
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parsePkg, readPkgEntry } from '../../src/pkg-extract.js';

/** webui/ 目录（上传与解包产物都落在它的 tmp/ 下，见 .gitignore）。 */
export const WEBUI_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** 解包时记录"这个目录来自哪个场景"的旁挂文件（里面只有一行 JSON）。 */
export const SIDECAR = '.webui-scene.json';

/**
 * 场景的**稳定标识**（与文件路径无关）—— 渲染器用它给粒子随机数播种，
 * 好让"同一场景的副本"（上传副本 / 解包目录）跑出逐像素一致的结果。
 *
 * 推导顺序:
 *   1. 目录里有解包旁挂（`.webui-scene.json`）→ 用其中记录的 `sceneKey`；
 *   2. 路径形态命中 `…/431960/<id>/…` → 用 workshop id；
 *   3. 其余（任意外部目录）→ 用 scene.json 内容哈希（跨路径稳定、内容变了才变）。
 */
export function deriveSceneKey(input) {
  const p = resolve(String(input));
  let dir = p;
  try { if (statSync(p).isFile()) dir = dirname(p); } catch { /* ignore */ }
  // 1. 解包旁挂
  try {
    const sc = join(dir, SIDECAR);
    if (existsSync(sc)) {
      const j = JSON.parse(readFileSync(sc, 'utf8'));
      if (j && j.sceneKey) return String(j.sceneKey);
    }
  } catch { /* ignore */ }
  // 2. workshop 形态（路径里出现 …/431960/<id>/…）
  const norm = p.replace(/\\/g, '/');
  const m = /\/431960\/([^/]+)\//.exec(norm + (norm.endsWith('/') ? '' : '/'));
  if (m) return 'workshop:' + m[1];
  // 3. scene.json 内容哈希
  try {
    const sj = join(dir, 'scene.json');
    if (existsSync(sj)) return 'scene:' + createHash('sha256').update(readFileSync(sj)).digest('hex').slice(0, 16);
  } catch { /* ignore */ }
  return null;
}

/** 把来源场景标识写进解包目录（供后续渲染复用同一随机种子）。 */
export function writeSidecar(outDir, sourceKey, sourcePath) {
  try {
    writeFileSync(join(outDir, SIDECAR), JSON.stringify({ sceneKey: sourceKey || null, from: sourcePath || null, when: new Date().toISOString() }, null, 1));
  } catch { /* ignore */ }
}

/** 读旁挂里的来源信息（UI 用来显示"这个目录解自哪个 pkg"）。 */
export function readSidecar(dir) {
  try {
    const sc = join(dir, SIDECAR);
    if (existsSync(sc)) return JSON.parse(readFileSync(sc, 'utf8'));
  } catch { /* ignore */ }
  return null;
}

/** 把条目路径规范成"相对、无穿越"的 POSIX 形式；非法返回 null。 */
export function safeEntryPath(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s) return null;
  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;              // 目录穿越：整条条目丢弃
    if (/[\0]/.test(seg)) return null;
    // Windows 保留字符（防止写出不可读的文件名）
    if (/[<>:"|?*]/.test(seg)) return null;
    parts.push(seg);
  }
  if (!parts.length) return null;
  return parts.join('/');
}

/**
 * 解包 scene.pkg 到 outDir。
 *
 * @param {string} pkgPath scene.pkg 路径
 * @param {string} outDir  目标目录（会被创建；存在同名文件会被覆盖）
 * @param {{sceneKey?:string}} [opts] sceneKey 会写进旁挂文件，供后续渲染保持粒子随机种子一致
 * @returns {{outDir:string, files:number, bytes:number, compressed:number, skipped:string[], sceneKey:string|null, ms:number}}
 */
export function unpackPkg(pkgPath, outDir, opts = {}) {
  const t0 = Date.now();
  const buf = readFileSync(pkgPath);
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  // parsePkg 认的是 `[u32][PKGV00xx]` 布局（唯一带 LZ4 解压能力的实现）。若遇到旧式
  // `PKGV...` 裸头它会抛错 —— 这时如实报出来，不假装成功。
  let index;
  try {
    index = parsePkg(data);
  } catch (e) {
    const err = new Error('解包失败（PKG 头部布局不被支持）: ' + e.message);
    err.code = 'PKG_FORMAT';
    throw err;
  }

  const base = resolve(outDir);
  mkdirSync(base, { recursive: true });
  const skipped = [];
  let files = 0, bytes = 0, compressed = 0;
  for (const entry of index) {
    const rel = safeEntryPath(entry.path);
    if (!rel) { skipped.push(String(entry.path) + '（路径非法/含穿越）'); continue; }
    let payload;
    try {
      payload = readPkgEntry(data, entry);
    } catch (e) {
      skipped.push(rel + '（' + e.message + '）');
      continue;
    }
    const abs = resolve(base, rel);
    if (!abs.startsWith(base)) { skipped.push(rel + '（解析后越出目标目录）'); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(payload));
    files++;
    bytes += payload.length;
    if ((entry.flags & 1) !== 0) compressed++;
  }
  // 记下来源场景标识：解包目录与原 pkg 用**同一个**粒子随机种子，逐对象/逐效果对照才有意义
  const sceneKey = opts.sceneKey || deriveSceneKey(pkgPath);
  writeSidecar(base, sceneKey, pkgPath);
  return { outDir: base, files, bytes, compressed, skipped, sceneKey, ms: Date.now() - t0 };
}

/** 递归统计目录里的文件数与总字节（用于解包回执/校验）。 */
export function dirStats(dir) {
  let files = 0, bytes = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else { files++; bytes += st.size; }
    }
  };
  try { walk(dir); } catch { /* ignore */ }
  return { files, bytes };
}

/** 解包目录里是否具备可渲染入口。 */
export function findSceneEntry(dir) {
  if (existsSync(join(dir, 'scene.json'))) return dir;
  // 少数包把场景放在子目录并靠 project.json 声明 —— 递归找一层
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory() && existsSync(join(p, 'scene.json'))) return p;
    }
  } catch { /* ignore */ }
  return null;
}

/** 解包产物的统一落点（与 serve.mjs 的上传目录同根）。 */
export function unpackedDirFor(key) {
  const safe = String(key || 'scene').replace(/[^\w.-]+/g, '_').slice(0, 80);
  return join(WEBUI_DIR, 'tmp', 'unpacked', safe);
}

/**
 * **确保拿到可改写的场景目录** —— 逐对象/逐效果开关的前置步骤。
 *
 * 入参是松散目录 → 原样返回；是 scene.pkg → 解包到 `tmp/unpacked/<key>/` 再返回该目录。
 * 已有解包产物时直接复用（用旁挂的 `sceneKey` 与体积粗校验，不一致就重解）。
 *
 * 为什么要自动做: "取消勾选一个效果"是**最常用**的操作，而 pkg 是**最常见**的输入形态；
 * 把"请先手动解包"甩给用户等于每个场景都要多点一次。解包只要 100–600ms，直接做掉。
 *
 * @returns {{input:string|null, unpacked:boolean, done:boolean, error?:string, sceneKey?:string}}
 */
export function ensureUnpacked(input, sceneKey) {
  const p = resolve(String(input));
  let isDir = false;
  try { isDir = statSync(p).isDirectory(); } catch { /* ignore */ }
  if (isDir) {
    // 松散/已解包目录：能直接改写就用它
    if (findSceneEntry(p)) return { input: p, unpacked: false, done: false };
    return { input: null, unpacked: false, done: false, error: '目录里找不到 scene.json: ' + p };
  }
  if (!/\.pkg$/i.test(p)) {
    // 其它文件（比如直接指向某个 .json）—— 交给上层按"同级目录"处理
    return { input: p, unpacked: false, done: false };
  }

  const key = sceneKey || deriveSceneKey(p) || ('pkg-' + hashPath(p));
  const out = unpackedDirFor(key);
  // 复用已有解包：旁挂的 sceneKey 一致且入口还在
  const prev = readSidecar(out);
  const entry = existsSync(out) ? findSceneEntry(out) : null;
  if (entry && prev && prev.sceneKey === key) {
    return { input: entry, unpacked: true, done: false, sceneKey: key };
  }
  try {
    const r = unpackPkg(p, out, { sceneKey: key });
    const e2 = findSceneEntry(out);
    if (!e2) return { input: null, unpacked: true, done: true, error: '解包完成但没有 scene.json: ' + out };
    return { input: e2, unpacked: true, done: true, sceneKey: r.sceneKey };
  } catch (e) {
    return { input: null, unpacked: true, done: false, error: '自动解包失败: ' + (e && e.message ? e.message : e) };
  }
}

/** 路径哈希（外部目录没有 workshop id 时兜底当解包目录名）。 */
function hashPath(p) {
  return createHash('sha256').update(String(p)).digest('hex').slice(0, 12);
}
