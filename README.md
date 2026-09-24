# we-static-frame

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![Wallpaper Engine](https://img.shields.io/badge/Wallpaper%20Engine-scene.pkg-1b2838.svg)](https://www.wallpaperengine.io/)

把 Wallpaper Engine 的场景壁纸（`scene.pkg` / 场景目录）**离线渲染成一张 PNG** 的独立实现。
从 [`dsh-plugin-wallpaper-engine`](https://github.com/YV3507/dsh-wallpaper-engine) 的静态帧链整块搬出，
**不依赖任何宿主**（无 DSH、无插件、无 HTTP 服务）：既能当库调用，也能当命令行工具用。

> **为什么存在**：实时渲染（[`webwallgl`](https://github.com/oneincase/webwallgl)）在**有 GPU** 的机器上是主路径；
> 静态帧的定位是**虚拟机 / 远程端 / 无 WebGL2** 时的取舍方案 —— 也就是"没有实时渲染可用"时的兜底。
> 把它独立出来，是为了让渲染器本身能独立发版、独立评测，同时让主插件不必继续内嵌这 1MB 实现。

## 依赖

- **Node ≥ 18**（ESM）。
- **Wallpaper Engine 安装**：渲染器需要官方 `assets/`（shader / material / model / particle / scripts）才能还原效果链。
  用 `--we-assets <WE 安装目录>/assets` 指定，或让 CLI 自动定位（环境变量 `WE_ASSETS` / `DSH_WE_ASSETS`、
  `DSH_WE_STEAM_ROOT`，以及 Steam 默认库与 `libraryfolders.vdf`）。**这些资产是 WE 自带的，不随本仓库分发。**
  ⚠ 自动定位目前只探测 **Windows** 盘符路径；Linux / macOS 请显式设置 `WE_ASSETS`。
- 可选：`supreium-headless-gl`（x64）—— 效果链走 WebGL 的 GPU 加速（`--gpu`）。缺失、架构不符或驱动异常即自动回退 CPU。
- 可选：场景内嵌**视频纹理**需要调用方先抽帧（主插件用 ffmpeg），通过库参数 `videoFrames` 传入；CLI 暂不支持，
  这类场景会渲染成**空白帧**（见下方"已知限制"）。

## 用法

```bash
# 命令行
npx we-sf render "/path/to/scene.pkg" -o frame.png --w 3840 --h 2160 --t 2.5
npx we-sf render ./my-scene-dir -o frame.png --we-assets "C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine/assets"
npx we-sf locate          # 只打印自动定位到的 assets 路径
npx we-sf render <scene> -o out.png --log      # 把效果编译失败 / 缺纹理 / 降级上报打到 stderr
```

```js
// 库
import { renderFrame, renderToFile, locateWeAssets } from 'we-static-frame';

const { png, width, height, ms } = await renderFrame({
  input: 'C:/.../431960/3486806915/scene.pkg',
  width: 3840, height: 2160, time: 2.5,
  weAssetsDir: locateWeAssets(),
  gpuAccel: false,
  onDegraded: ({ object, feature, action }) => console.warn(feature, action), // 可选：降级留痕
});
```

## 目录结构 / 代码来源契约

```
src/**                  ← 渲染器本体：搬自主插件 dsh-plugin-wallpaper-engine 的静态帧链（64 文件）
src/render.js           ← 本仓库的库入口（renderFrame / renderToFile / locateWeAssets）
src/cli.js              ← 本仓库的 CLI（we-sf）
test/smoke.mjs          ← 冒烟：能拿到场景就渲染一张并校验 PNG 头（拿不到则 SKIP）
test/survey.mjs         ← 普查：本机全库逐个渲染，汇总空白帧 / 降级 / 耗时（人读表格 + JSON）
```

**`src/**` 的约定（vendored + 本地补丁）**：这部分代码**来源**是主插件的静态帧链，但本仓库是它的
**唯一发布源**——允许在此直接修 bug 并独立发版。改动请遵守两条：

1. **保持接口与语义与主插件一致**：这里的修复应当能被主插件反向取用（改动落点尽量小而集中，
   并在提交信息里写清"修的是什么、怎么验证"）。
2. **不要在两边各写一份实现**：主插件若要覆盖式同步 `src/**`，必须把本仓库的新提交一并带走
   （历史契约见主插件 `scripts/sync-webwallgl.mjs` 与 `.upstream.json` 的 `repo / name / version / commit / dirty / files`）。

反向约束不变：**本仓库不反向依赖主插件**，`src/**` 里不允许出现主插件专有模块的 import。

## 已知限制（会静默影响画面，务必先读）

这些都是"渲染成功但结果与官方不一致"的情形，默认只通过 `log` / `onDegraded` 通道暴露；
用 `--log`，或在代码里传 `onDegraded`，才能看到：

- **内嵌视频纹理** → 整层被跳过。若主图层就是视频纹理，整帧会是纯黑（exit code 仍为 0）。
  库调用方需自行抽帧并传 `videoFrames`。
- **效果编译/执行失败**（GLSL 报错、缺纹理、缺 combo 支持等）→ **该效果被丢弃**，对象保留，画面缺效果。
- **`--gpu` 的熔断**：同一进程内连续若干次 GPU 效果失败后，本次渲染剩余效果链全部回退 CPU，
  此时 `--gpu` 可能反而更慢（实测有 0.57×–1.0× 的场景）。

## 明确不做（边界）

- 不做缓存 / 变体档位 / `.fb.` 兜底 / 预热调度 / 设置与 UI —— 那些是**宿主职责**，留在主插件。
- 不做进程派发与 IPC（worker / fork / GPU node 探测）—— 同上。
  （`src/scene-render-worker.mjs`、`src/scene-prewarm.js` 是随镜像带过来的宿主侧文件，本仓库不调用它们。）
- 不做"用 WebWallGL 实时渲染器截帧"（那是另一条路线：GPU 侧由 webwallgl + 主插件的缓存回填承担）。

## 现状与待办

- 采样时刻选点（"t=2.5 可能是空白帧 ⇒ 试更晚时刻"）与度量口径目前仍在主插件的 worker 里；
  将来若确认它属于"渲染"而非"宿主策略"，可迁移到这里（迁移前不要在两处各写一份）。
- `--gpu` 的实际收益只在**效果链**上，且**取决于场景**：效果占比高的场景实测 1.8×–4.4×，
  效果少或触发熔断的场景会持平甚至变慢 —— 非效果段仍是 CPU。
- 已知缺陷与修复进度见 [Issues](https://github.com/YV3507/we-static-frame/issues)。

## 许可证

[MIT](LICENSE)。渲染器实现取自 [`dsh-plugin-wallpaper-engine`](https://github.com/YV3507/dsh-wallpaper-engine)（同为 MIT）。
