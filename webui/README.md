# we-static-frame · WebUI

一个**独立的**浏览器测试台：导入壁纸 → 调配置 → 直接看渲染结果。
不改动 `src/**` 的任何渲染逻辑，只通过 `src/render.js` 的 `renderFrame` 复用既有渲染器。

```bash
npm run webui              # → http://127.0.0.1:43121
npm run webui -- --port 8080
```

端口默认 **43121**，刻意避开 DSH Web GUI 自己占用的 43120，免得看错页面。
服务只监听回环地址。

## 为什么是"服务端渲染 + 浏览器显示"

上游的实时渲染器 [webwallgl](https://github.com/oneincase/webwallgl) 在**有 GPU** 的机器上是主路径；
本仓库是它的**静态帧兜底**（虚拟机 / 远程端 / 无 WebGL2）。这个 WebUI 也不试图把渲染搬进浏览器：

| 事实 | 后果 |
|---|---|
| 渲染内核是 Node 专用（`node:fs`/`node:path`、`node:zlib` 解 pkg、`node:vm` 跑场景脚本、`node:worker_threads`） | 浏览器里跑不起来，除非把内核重构进浏览器 |
| `Buffer` 出现 17 处 | 同上 |
| 内核是**全同步**设计（`readPkg`、纹理解码都是同步的） | 即便移植也要整体异步化 |
| `src/**` 是渲染器的**唯一实现**（按需修改，没有第二份可对照） | 再写一份浏览器版 = 两份实现必然分叉 |

所以分工是：**浏览器只管"选 + 配 + 看"，渲染在服务进程内跑**。
静态帧本来就不需要实时 GL 上下文共享，这个分工没有性能损失。

## 三个面板

1. **导入壁纸** —— 三种入口：
   - 本机 workshop 场景列表（自动扫描 `steamapps/workshop/content/431960`）。
     每个 pkg 旁边有「解包」按钮 → 落成松散目录后才能用**逐对象/逐效果开关**。
   - 拖拽上传 `scene.pkg` 或整个场景目录（落到 `webui/tmp/`，可单独删除）
   - 直接填路径（场景外的样本也能测）
2. **配置** —— 五个 tab，覆盖 `renderFrame` 暴露的**全部**下游接口（见下表）
3. **渲染结果** —— 图像 + 降级列表 + 决策表 + gpuStats + 逐行日志，可下载 PNG

### 哪些 workshop 条目能渲染

本机 24 个条目里：

| 类型 | 数量 | 能否渲染 |
|---|---|---|
| `scene.pkg`（打包场景） | 16 | ✅ 直接渲染 |
| `scene.json`（松散目录） | 0（本机） | ✅ 直接渲染，且逐对象开关免解包 |
| **Video 壁纸**（`project.json` + `.mp4`） | 6 | ❌ 不在范围（没有场景图，只有一段视频） |
| **Web 壁纸**（`index.html` + `js/`） | 2 | ❌ 不在范围（另一条渲染路线） |

被排除的条目会**列在列表底部并注明原因**，不是静默丢掉。

## 配置项 → 下游接口对照

| UI | `renderFrame` 参数 | 说明 |
|---|---|---|
| 宽度 / 高度 / 时间 t | `width` / `height` / `time` | 含 320×180 … 4K 预设 |
| 纹理预解码预热 | `warm` | 关掉可测冷启动成本 |
| 启用 GPU 通道 | `gpuAccel` | 历史开关，等价 `gpu:'auto'` |
| WE assets 目录 | `weAssetsDir` | 留空则自动定位 |
| videoFrames | `videoFrames` | 内嵌视频纹理需要外部抽帧（JSON 形式传入） |
| gpu 模式 | `gpu` | `auto` / `off` / `force` / 对象形式 |
| failStreakLimit、allowEffects、denyEffects | `gpu.{failStreakLimit,allowEffects,denyEffects}` | 熔断阈值与 GPU 效果名单 |
| skipDegenerate | `effects.skipDegenerate` | 关掉则保留退化输出，便于取证 |
| effects.allow / deny | `effects.allow` / `effects.deny` | 全局效果白/黑名单 |
| 统一后端 | `policy.decideBackend` | `auto`/`cpu`/`gpu`/`gpu-only` |
| **逐对象勾选** | 数据层 `scene.objects[i].visible` | 渲染器没有对象级策略钩子，按官方语义改数据 |
| **逐效果勾选** + 逐效果后端 | 数据层 `effects[j].visible` | 同一图层里的**同名效果也能分别控制**，比 allow/deny 精确 |
| 着色器补丁 | `shaderPatch` | key = 效果名 / 着色器 stem，正则替换源码 |
| 诊断取证 | `DSH_WE_*` 环境变量 | 见下 |

逐对象/逐效果这两条是**数据层**改写（写一份临时 `.webui-tmp-scene.json` 再渲染，原文件不动）：
- 数据层需要**松散场景目录**（`scene.json` 可直接读）。传入 `scene.pkg` 时服务端会**自动解包一次**
  再渲染（`ensureUnpacked`），产物落在 `webui/tmp/unpacked/<id>/` 并按 `sceneKey` 复用 ——
  **用户不需要手动解包**（列表里的「解包」按钮只是提前做掉这一步）。
- 用 `allow/deny` 或逐效果后端时不受此限（走的是策略层）。

### 解包（pkg → 松散目录）

**这一刻是自动的**：只要本次渲染带有逐对象/逐效果勾选，服务端就会先 `ensureUnpacked`。
`POST /api/unpack {input}` 是显式版本（列表里的按钮用它提前解包）。

复用 `src/pkg-extract.js` 已导出的 `parsePkg` / `readPkgEntry`（含 LZ4 块链解压，
靠"链条恰好消费完整个条目"判定是否压缩），本层只做路径安全 + 落盘，格式知识不复制。

**一致性实测（16 个 pkg，320×180）**：解包产物与原 pkg 的全部条目**逐字节一致**
（252/252、227/227…），渲染结果 **13/16 逐字节一致**。不一致的 3 个：

| 场景 | 情况 |
|---|---|
| 3470764447 / 3660962877 | Video 壁纸：内嵌 mp4 无法静态解码 ⇒ 两侧都是近空白帧，像素差异无意义 |
| 3629379075 | 8 个粒子对象里有 1 个（`Trails 2`）残留差异（390 字节 / 约 100 像素） |

为了这个一致性，顺带修了一个**真实缺陷**：粒子系统的确定性 RNG 原先用**场景文件路径**做种子
（`particles.js::_particleRng`），于是同一个场景换个路径（解包目录 / 上传副本）就会**重新掷点**
—— 一开始 16 个场景里有 10 个因此对不上。现在宿主可以传 `sceneKey`（稳定标识）覆盖它：
`SceneRenderer` 新增 `opts.sceneKey`，`renderFrame` 同名参数透传，WebUI 会自动推导
（解包旁挂 `.webui-scene.json` → workshop id → scene.json 内容哈希）。
**`Trails 2` 的残留差异与种子无关**（把两侧种子显式设成同一个值，差异仍是 390 字节），
所以那是粒子层另一处路径依赖，尚未定位 —— 需要时用 `.test-tmp/unpack-bisect2.mjs` 继续二分。

## 诊断取证开关

UI 里每个开关对应一个 `DSH_WE_*` 环境变量，逐请求注入：

`DSH_WE_FX_DUMP`（逐 pass：target/尺寸/各槽位绑到哪个 RT/编译源签名/像素摘要）、
`DSH_WE_FX_TRACE`（生成 JS 的出错行）、`DSH_WE_NO_FX`、`DSH_WE_NO_FXJSON`、
`DSH_WE_NO_FXJSON_GPU`、`DSH_WE_NO_FX_CHAIN`、`DSH_WE_CHAIN_VERIFY`、
`DSH_WE_DEBUG_GLSL`、`DSH_WE_PROFILE`、`DSH_WE_RT_ALL`、`DSH_WE_NO_SEED_VTEXCOORD`。

为了让这些开关能**逐请求**切换，渲染器里原本在模块加载期读取的开关已改为**每次调用读取**
（`xxxOn()` 取值函数，见 `effects/effectjson.js`、`gpu-gl/adapter.js`、`effects.js`、
`glsl/executor.js`、`profile.js` 等）。这是"读取时机"的改变，不改变任何渲染逻辑：
对"启动前设好环境变量"的既有用法行为完全一致（既有测试与逐场景普查均无回归）。

服务端对 `process.stderr.write` 做了请求作用域接管，因此少数直接写 stderr 的诊断输出
（如 gpu-gl 的单 pass 统计）也能出现在 UI 的日志面板里；渲染结束立即还原，不影响服务自身输出。

## 已知边界（诚实记录）

- **GPU 熔断是进程级的**：`gpu-gl/adapter.js` 的失败计数活在进程内，一次连续失败可能让后续
  请求都变成 `state=off`。所以 UI 的 `gpu:'force'` 会**显式复位**熔断状态（`resetGpuAdapter()`）
  —— 否则用户只能重启服务才能把 GPU 拿回来。gpuStats 会如实显示当前状态。
- **渲染期间无法取消**：内核是同步的，HTTP 请求一旦进入渲染就跑到结束。大分辨率 + 重效果
  场景请先从小分辨率试。
- 上传的体积上限是服务端 `readBody` 的 1GB（整个 pak 读进内存）；20-40MB 的 pkg 没问题。
- 逐对象/逐效果勾选对 `scene.pkg` **可用**（服务端自动解包，见上）；首次勾选会多花约 0.1–0.6 秒
  解包，之后复用。
- 每次请求的渲染状态（scenes/纹理缓存）**会**跨请求复用 —— 这是有意的（预热收益），
  代价是"改了同一个场景文件后"可能命中旧缓存；要绝对干净就重启服务。
- 解包产物会一直留在 `webui/tmp/unpacked/`（可随时删；`/api/unpacks` 列出）。

## 文件结构

```
webui/
  serve.mjs            零依赖 HTTP 服务：路由 + 上传 + 解包 + 渲染编排（进程内）
  lib/scenes.mjs       场景发现（pkg / loose / video / web 分类）与场景内省（对象·效果树）
  lib/unpack.mjs       scene.pkg → 松散目录（复用 pkg-extract 的 LZ4 感知读条目）+ 场景稳定标识
  lib/render.mjs       job → renderFrame 参数的**唯一映射点**（全部下游接口都在这里落地）
  public/index.html    三段式布局
  public/app.css       深色主题
  public/app.js        选区/配置/上传/解包/结果展示（零框架、零构建）
  public/state.js      极简发布订阅状态中心
  tmp/                 上传与解包产物（已加入 .gitignore）
```

## 冒烟自检

```bash
npm run webui -- --port 43121      # 另开一个终端
curl -s localhost:43121/api/health
curl -s localhost:43121/api/scenes
curl -s -X POST localhost:43121/api/render -H 'content-type: application/json' \
  -d '{"input":"<scene.pkg 路径>","render":{"width":480,"height":270,"time":2.5}}'
```
