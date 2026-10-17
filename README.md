# NEONFALL

**NEONFALL** — 风格化霓虹下落式音游。一套 TypeScript 代码，同时运行在 **Web / Windows / Android** 三端。

当前版本 **0.2.7**。本地入口 `http://127.0.0.1:8787/`；完整 Web + 中心谱面部署包为 `release/NEONFALL-server.zip`，Android 安装包为 `release/NEONFALL.apk`（与 `NEONFALL-debug.apk` 相同），Windows 便携目录为 `release/NEONFALL-0.2.7-win-x64/`。

```
N E O N
F A L L
```

## 核心特性

- **4K / 5K / 6K / 7K（+8K）** 全键位模式，参考 osu!mania 判定（PERFECT ±16ms / GREAT ±40ms / GOOD ±73ms / OK ±103ms / BAD ±127ms @OD8，随谱面 OD 缩放）
- **直接导入 osz（osu!mania）与 mcz（Malody）谱面**，自动转换为本游戏专属谱面格式 **`.nfm`**（zip 容器：`chart.nf` JSON + 音频/背景/视频/storyboard 资源，7-Zip 可直接解压）
- **直接导入 osk（osu 皮肤）**，转换为专属皮肤格式 **`.nfsk`**（zip 容器：`skin.nfskin` JSON + 图片/音效/字体）；谱面内嵌皮肤（osz 根目录 skin.ini）同样支持
- **osu Storyboard 完整渲染**：Sprite/Animation、F/M/MX/MY/S/V/C/R/P 命令、缓动插值、Loop、Pass/Fail 分层、additive 混合、逐帧动画——直接跑 osz 里自带的 SB
- **视频背景与图片背景**（mp4/webm/m4v 可直接播；osz 的 flv/avi 因浏览器解码限制会被优雅跳过）
- **hitsound**：谱面 hitsound 位 + sample set 映射到皮肤音效，缺失时用 WebAudio 合成默认音效
- **mods**：Auto / Mirror / Random / Hidden / FadeIn / Flashlight / NoFail / DownScroll / 滚动速度 ×0.5–2.0 / **恒定速度**（忽略 BPM 与 SV 变速对显示的影响，表现分按 90% 折算）
- **账号系统**：英文 ID（3-16 位字母数字下划线）+ 昵称 + 密码 + 邮箱，支持**上传/更换头像**（PNG/JPEG/WebP，裁剪为 256×256）；邮箱验证支持 SMTP TLS / STARTTLS，需管理员配置邮件服务
- **评分系统**：谱面难度评级（★，由密度/和弦/连打/hold/SV/BPM 综合计算）+ pp 制 NEON 总评级（top 成绩 0.95 加权求和）+ 服务器排行榜
- **主菜单律动**：按真实音频频谱与 BPM 节拍响应（左右侧边闪光 + kiai 双喷泉），暂停/静音/无声时抑制；击打粒子开关不影响菜单特效
- **移动端横屏全屏**：手机网页一键横屏全屏（按浏览器方向锁定能力，不支持时提示手动横置），短横屏主菜单 / 选歌 / 设置 / 导入自适应布局
- **低延迟设计**：
  - WebAudio `latencyHint: interactive` 调度；自动补偿设备输出延迟（`baseLatency + outputLatency`）
  - 音频偏移 / 视觉偏移 / 输入偏移三轴独立校准，内置节拍器校准工具（按 16 个 tick 取中位数误差）
  - 输入时间戳直接取音频时钟（不依赖事件时间戳）；Electron 关后台节流
  - 视频背景按音频时钟漂移校正（>80ms 自动 seek）
  - 判定逻辑与渲染分离，渲染基于音频时钟而非墙钟

## 专属格式

| 后缀 | 内容 | 说明 |
|---|---|---|
| `.nfm` | 谱面包 | zip：`chart.nf`（JSON）+ `assets/`（音频、背景、视频）+ `sb/`（storyboard 资源）+ `skin/`（谱面内嵌皮肤） |
| `.nfsk` | 皮肤包 | zip：`skin.nfskin`（JSON）+ 图片 / 音效 / 字体 |

导入 osz/mcz/osk 后自动转成上述格式入库；库内可随时「EXPORT」导出 .nfm 文件。桌面端存储在应用数据目录（`%APPDATA%/NEONFALL/charts`），Web/Android 端存于浏览器 IndexedDB。

## 三端（同一套代码）

```
src/            ← 全部游戏代码（TS，无框架，Canvas 2D + WebAudio）
dist/index.html ← 单文件构建产物（所有 JS/CSS 内联）
electron/       ← Windows 壳（Electron，neonfall:// 协议 + 本地谱面文件桥）
android/        ← Android 壳（Capacitor 8，WebView）
server/         ← 中心谱面服务器（零依赖 Node.js）
```

**平台差异（按需求）**：
- **Web**：使用中心谱面服务器（同源 `/api`），谱面列表/下载/上传/账号/排行榜都走服务器；下载的谱面缓存到 IndexedDB。`dist/index.html` 双击即可本地运行（file:// 下自动进入本地模式）
- **Windows / Android**：支持本地导入与离线缓存；在账号页配置服务器地址后，可连接中心服务器同步谱面、成绩与排行榜。

## 构建

```bash
npm install                    # 安装依赖（国内可设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）
npm run build                  # → dist/index.html（单文件，三端共用；Node.js 22.18+）
npm test                       # 全套回归测试（解析/引擎/皮肤/在线/集成等）
npm run convert <file>         # 命令行转换 osz/mcz/osk → nfm/nfsk
```

### Web（本地运行）

```bash
npm run server                 # 中心谱面服务器 http://localhost:8787
# 首次启动自动把示范谱面播种进谱面仓库
# 完整部署包：npm run package:online
# 解压 release/NEONFALL-server.zip，配置环境变量后 node server/server.js
```

### Windows

```bash
powershell -File tools\package-win.ps1
# → release/NEONFALL-win-x64/NEONFALL.exe（便携目录，不必单文件）
# → release/NEONFALL-win-x64.zip
# 首次启动自动把内置示范谱面播种进本地曲库
```

### Android

```bash
npm run android:package        # 构建最新 Web、同步 Capacitor、离线构建 → release/NEONFALL-debug.apk
# 新机器首次获取依赖：powershell -File tools/build-android.ps1 -Online
# 正式商店发布应由所有者使用自己的长期签名密钥生成 release 包。
```

`build-apk.bat` 使用隔离的 `.gradle-home`（规避本机 `~/.gradle/gradle.properties` 里失效的代理配置）与腾讯/阿里云镜像。

## 服务器 API 摘要

```
GET    /api/ping                    状态（含版本 / ratingVersion / avatars 标志）
POST   /api/register|login          注册/登录（scrypt 哈希，Bearer token）
GET    /api/me                      当前用户
PUT    /api/me/avatar               上传头像（PNG/JPEG/WebP，登录后，仅本人）
DELETE /api/me/avatar               删除头像
GET    /api/avatars/:user/:file     公开头像
POST   /api/verify-email/send       发送验证码（管理员配置 SMTP 后启用）
POST   /api/verify-email            校验验证码
POST   /api/scores / GET /api/scores  提交/查询成绩（含 mods 字段，自动重算评级）
GET    /api/leaderboard             玩家评级榜
GET    /api/charts                  谱面列表
POST   /api/charts/upload           登录后上传 NFM（内容 SHA-1 去重）
GET/DELETE /api/charts/:id          下载 / 上传者或管理员删除
```

## 目录结构

```
neonfall/
├── src/core/        类型、zip、nfm 格式、osz/mcz/osk 解析、storyboard、评级、存储
├── src/engine/      音频引擎、输入、判定会话、皮肤渲染
├── src/ui/          主题、控件、App 框架、各界面（主菜单/选歌/设置/账号/导入/游玩/结算）
├── server/          中心谱面服务器 + 数据目录
├── electron/        Windows 壳
├── android/         Android 壳（Capacitor）
├── tools/           转换 CLI、单元测试、视觉测试、OCR 截图分析、图标生成、打包脚本
└── release/         构建产物（Windows exe + zip、apk、web/server 部署包）
```

## 操作说明

- **选歌**：↑↓/鼠标滚轮浏览，Enter 开始，F2 随机，M 打开 mods，Ctrl+F 搜索，I 导入
- **游玩**：4K `DFJK`，5K `DF 空格 JK`，6K `SDF JKL`，7K `SDF 空格 JKL`（设置-INPUT 可改键）；触屏直接点按判定区
- **ESC** 暂停（R 重开 / Q 退出）；长段休息时按空格跳过
- **延迟校准**：设置 → AUDIO → START CALIBRATION，跟着节拍按空格

## 已知限制（迭代计划内）

- 浏览器/WebView 无法解码 osz 自带的 flv/avi 视频（mp4/webm 正常）
- osu storyboard 的 Trigger 事件按 Pass/Fail 分层近似实现；Sample 音效事件未实现
- 邮件验证需要管理员配置 SMTP；未配置时接口返回 503，不输出验证码或伪报发送成功
- DT/HT 变速 mod 未实现（音高无损变速需要粒度合成，列入后续迭代）

*NEONFALL v0.2.7 — drop into the neon.*
