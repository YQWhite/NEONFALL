# NEONFALL

**每一次落下，都与你的节奏相遇。**

![Version](https://img.shields.io/badge/version-0.2.10-a6cbb5)
![Platforms](https://img.shields.io/badge/platforms-Web%20%7C%20Windows%20%7C%20Android-789c89)
![TypeScript](https://img.shields.io/badge/TypeScript-Canvas%202D%20%2B%20WebAudio-3178c6)

NEONFALL 是一款支持 **Web、Windows 和 Android** 的下落式节奏游戏。导入 osu!mania 或 Malody 谱面，换上喜欢的皮肤，用键盘或触屏演奏；也可以连接自己的谱面服务器，让成绩自动同步，在排行榜中记录进步。

当前源码版本：**v0.2.10**。版本信息见 [package.json](package.json)，自动构建流程见 [Build & Release](.github/workflows/build.yml)。

## 功能亮点

### 带上熟悉的谱面与皮肤

- 支持 **4K / 5K / 6K / 7K / 8K** 键位模式。
- 直接导入 **`.osz`（osu!mania）和 `.mcz`（Malody Key 模式）**，自动转换并保存为 NEONFALL 谱面包。
- 支持 **`.osk`、`.msp`、`.nfsk`** 皮肤，包括 Malody 倾斜轨道布局及 osu!mania 皮肤的长条、判定图、音效等素材。
- osu!mania 判定支持编号动画帧，正确显示 200 / 100 / 50 / MISS 等素材；皮肤原本隐藏的 MAX / 300 保持隐藏，Malody 判定自动映射。
- osu!mania 音符保留皮肤原始比例与透明留白，长条按住后保持原连接位置；漏击使用皮肤自带的 `combobreak` 音效，同名素材不会串用其他皮肤的声音。
- 自定义 osu! 血量条保留背景、填充、指示标记的共同坐标、透明留白和 `@2x` 比例，不再叠加默认血条背景框。
- 离线内置 **「OSU皮肤示例」** 与 **「Malody斜轨示例」**，默认使用 OSU 示例。皮肤缺少对应键数时使用回退布局。
- 支持背景图片、浏览器可解码的视频，以及 osu! Storyboard 的精灵、动画、缓动、循环、混合等效果；背景与故事板亮度均可独立调整至 **0–100%**。

### 为键盘与触屏调整手感

- 支持自定义按键、触控轨道提示、轨道宽度与判定位置调整；轨道移动时上方延伸至屏幕顶端，保持音符速度。
- 采用 **osu!lazer mania 的 × 速刻度**：**1×–40×**、步长 **0.1×**，新用户默认 **8×**；保留已保存的速度偏好，按新刻度显示。基础速度按谱面主要 BPM 归一化，曲中变速仍然生效；详见 [osu!mania 速度说明](https://osu.ppy.sh/wiki/en/Game_mode/osu!mania#speed-change)。另有 Mod 下落倍率。
- 菜单预览与游玩共用一个音乐音量；音效音量统一控制击打与界面音效。暂停时可直接调整背景亮度、故事板亮度、音乐音量、音效音量及下落速度。
- 音频、视觉、输入偏移独立设置，提供设备输出延迟补偿与跟拍校准。
- 首个音符过早时自动补足准备时间；支持跳过空白前奏、休息段和尾奏。
- 最后一个音符结束后可继续听完音乐，音乐结束一秒后进入结算。
- 移动端菜单适配短横屏，网页提供横屏全屏入口；电脑可保持窗口游玩。

### 让菜单也跟着音乐动起来

- 主菜单使用当前播放歌曲的背景，切歌时淡入淡出，页面切换带连续过渡。
- 图标、频谱与侧边亮光随音频和节拍响应；亮边与轻微闪光从当前歌曲背景取色，切歌时平滑过渡。**kiai 段增强闪光，进入时触发一次双喷泉**。
- 主菜单按歌曲列表循环，选歌页单曲循环；同一歌曲的不同难度不会被当作下一首重复播放。
- 主菜单在曲末提前准备下一首；加载期间旧歌停在结尾，不会突然从预览点重播。
- 设置、档案、导入和排行榜等子页面保持预览音乐连续播放。
- 提供减少动画选项；击打粒子开关与主菜单特效分开控制。

### 从个人最佳到全服排行

- 歌曲按可折叠的树状列表分组；进入选歌时定位当前播放歌曲的首个难度，切换歌曲时自动展开该曲全部难度。
- 难度列表逐行缓动展开，背景通过柔和遮罩连续切换；进入选歌沿用当前菜单背景，新图加载期间保持画面连续。
- 首屏封面按可见范围逐步加载，只提取必要图片并复用同曲背景；预览缓存与本地下载分开，点击下载后仍可离线游玩。
- 每个难度名称上方显示醒目的**个人最高分与评级**，无需逐个选中即可比较已有成绩。
- 歌曲信息区使用固定页签与独立滚动内容，可在排行榜与详情间切换，查看谱师、成功率及**失败位置分布**；小横屏将下载、导出等操作收进底部菜单。
- 全服排行榜提供 **能力值、最佳表现、总分、准确率、通关数** 五种视角，显示玩家头像与昵称。
- 头像支持自主拖动、缩放和正方形裁切，登录后上传并绑定账号。
- 登录后自动同步成绩；暂时断网时保留待同步队列，恢复连接后重试。
- 三端均可使用中心谱面库，下载到本地后离线游玩；支持主动断开并更换服务器。
- 首次连接自动显示服务器公告，标明双方版本；版本不一致时提示并保留兼容连接。

## v0.2.10 更新重点

| 更新 | 体验变化 |
| --- | --- |
| 选歌布局 | 重排右侧信息区，最高分与评级置于每个难度上方，未选中也可见 |
| 可折叠曲库 | 进入选歌定位当前播放歌曲首个难度，切歌自动展开对应难度 |
| 连续选歌动画 | 难度列表逐行缓动展开、自动滚动平稳收尾；背景柔和遮罩过渡，进入选歌延续菜单背景 |
| 首次选歌性能 | 封面限并发加载、按需提取背景，避免整包重复解压和仅为封面触发的本地保存 |
| osu!mania × 速 | 改为 **1×–40×**、步长 **0.1×**、默认 **8×**，按谱面主要 BPM 归一化基础速度 |
| 统一音量与暂停设置 | 合并音乐和预览音量，音效覆盖击打与 UI；暂停直接调节两项亮度、两项音量和速度 |
| 皮肤判定动画 | 使用 osu!mania 的编号判定帧，保留透明 MAX / 300；修复皮肤预览长条与上一排重叠 |
| 长条与漏击音效 | 保留原皮肤音符比例、按住长条不向下拉伸；可靠加载皮肤漏击音效，避免长条或和弦重复叠音 |
| 自定义血量条 | 保留原图层比例与位置，去掉默认 HEALTH 标签、背景框和额外填充 |
| 主菜单自动切歌 | 提前准备下一首，曲末加载时不再回跳预览点；选歌页仍单曲循环 |
| 结算判定明细 | 显示 **MAX / 300 / 200 / 100 / 50 / MISS** 六档计数，并保留英文 Mod 名称 |
| 随背景变色的律动 | 侧边亮光与淡闪跟随背景主色，切歌时同步过渡 |

### 计分与能力值

普通成绩每谱满分 **1,000,000**。单键音符、长条头和尾等权计分，长条尾判窗口为头判的 **1.5 倍**。长条身体 tick 保留连击，但不额外增加准确率或 MAX 数；分数按 **320 / 300 / 200 / 100 / 50** 的判定权重线性归一化。这是 NEONFALL 的百万分公式，判定窗口与准确率参考 [osu!mania ScoreV2](https://osu.ppy.sh/wiki/en/Gameplay/Judgement/osu!mania#scorev2)。

评级为 **SS = 100%、S > 95%、A > 90%、B > 80%、C > 70%**，其余为 D，失败为 F。准确率使用 ScoreV2 的 MAX/GREAT 权重 **305/300**。

能力值取每张谱面的最佳表现分，选前 100 项按 **0.95ⁿ** 加权，并使用固定 100 个位置的权重总和归一化。重复刷同一张谱面不会重复累加能力值，积累更多优秀成绩才能逐步提升。

### 玩法 Mod

支持 Auto、Mirror、Random、Hidden、Fade In、Flashlight、No Fail、Down Scroll，以及下落倍率、恒定速度和无尾判。

| Mod | 效果 | 成绩处理 |
| --- | --- | --- |
| 恒定速度（Constant Speed） | 忽略 BPM / SV 变化对下落速度的影响，音乐节奏不变 | 表现分 ×90% |
| 无尾判（NoTail） | 按住到末端自动判尾；提前松键仍为 MISS | 分数与表现分均 ×90% |
| 恒速 + 无尾判 | 同时启用上述效果 | 分数 ×90%，表现分 ×81% |
| Auto / Mirror / Random | 自动演奏或改变轨道排列 | 不计排名与能力值 |

排行榜显示成绩所用 Mod。旧版成绩保留并与百万分成绩分开排行；全服总分、准确率和通关数仅统计百万分规则，成功率与失败位置只使用实际记录的尝试。

## 开始游玩

自动构建成功后，可在仓库的 **Releases** 页面获取对应产物：

| 产物 | 用途 |
| --- | --- |
| `NEONFALL-win-x64.zip` | Windows 便携版，解压后运行 `NEONFALL.exe` |
| `NEONFALL.apk` | Android 安装包 |
| `NEONFALL-web.zip` | Web 静态页面部署包 |
| `NEONFALL-server.zip` | Web 页面与中心谱面服务器的完整部署包 |

打开游戏后，在「导入」页面添加谱面或皮肤；也可以在「玩家档案」连接服务器并登录，从在线曲库选歌、下载和同步成绩。

默认按键：**4K `DFJK`、5K `DF 空格 JK`、6K `SDF JKL`、7K `SDF 空格 JKL`**，可在设置中修改。触屏直接点击轨道判定区域；`Esc` 暂停，`R` 重试、`Q` 返回选歌（暂停时），可跳过的段落使用空格。

## 自建服务器

服务器提供谱面库、账号、头像、自动成绩同步、公告与排行榜。完整部署包包含 Web 页面及运行依赖；准备 **Node.js 22.18+ 或 24 LTS**，解压后运行：

```bash
node server/server.js
```

默认端口为 `8787`。可直接访问 `http://127.0.0.1:8787/`，或通过自己的 HTTPS 反向代理对外提供服务。数据目录、上传策略、跨域和邮件配置见 [环境变量示例](server/deploy/neonfall.env.example)。

公告可设置 `NF_ANNOUNCEMENT_TITLE` 与 `NF_ANNOUNCEMENT`（正文支持 `\n` 换行）；也可在 `NF_DATA_DIR/server-info.json` 写入以下内容，下一次连接时生效，无需重启：

```json
{
  "announcement": {
    "title": "服务器公告",
    "body": "欢迎来到 NEONFALL！\n登录后成绩会自动同步。"
  }
}
```

环境变量优先于 JSON 配置。要使用完整的 v0.2.10 功能与全曲库个人最高分查询，请同时更新客户端和服务端，并保留原数据目录。旧服务器仍可连接；不支持新计分规则时，新成绩保存在队列，升级后自动补传。

<details>
<summary>服务器 API 摘要</summary>

| 接口 | 用途 |
| --- | --- |
| `GET /api/ping` | 状态、公告、版本与功能能力 |
| `POST /api/register`、`POST /api/login` | 注册、登录 |
| `GET /api/me` | 当前用户 |
| `PUT /api/me/avatar`、`DELETE /api/me/avatar` | 上传、删除本人头像 |
| `GET /api/avatars/:user/:file` | 公开头像 |
| `POST /api/scores`、`GET /api/scores` | 提交、查询谱面成绩 |
| `GET /api/scores/mine` | 当前账号成绩，默认最近 100 条；`all=1` 返回全部，供选歌展示各难度最高分 |
| `GET /api/leaderboard` | 全服榜，支持 `metric` 参数切换五类指标 |
| `GET /api/chart-stats` | 通过率、失败分布、个人最佳，参数为 `chart` 与 `keys` |
| `GET /api/charts`、`POST /api/charts/upload` | 查询、上传谱面 |
| `GET /api/charts/:id`、`DELETE /api/charts/:id` | 下载、按权限删除谱面 |
| `POST /api/verify-email/send`、`POST /api/verify-email` | 发送、校验邮箱验证码，需配置 SMTP |

新成绩查询使用 `scoreVersion=2`，例如 `/api/scores?chart=…&keys=4&scoreVersion=2`。服务端 v0.2.10 提供 `scoreVersion: 2`、`ratingVersion: 4`、`statisticsVersion: 1`。

</details>

## 从源码运行

技术栈：**TypeScript + Canvas 2D + WebAudio**，Windows 使用 Electron，Android 使用 Capacitor；服务端使用 Node.js 与 fflate。

```bash
npm ci
npm run dev          # 启动开发页面
npm run typecheck    # TypeScript 检查
npm run build        # 生成 dist/index.html
npm run server       # 使用构建后的页面启动中心服务器
```

仓库已配置 [GitHub Actions](.github/workflows/build.yml)，向 `main` 推送或手动触发流程后，构建三端客户端和服务包，并按 `package.json` 的版本号发布。

<details>
<summary>本地打包、格式与目录说明</summary>

打包脚本从项目上一级的 `samples-converted/` 读取示例曲库。全新克隆后，可在项目根目录用 PowerShell 准备与 CI 相同的资源位置：

```powershell
New-Item -ItemType Directory -Force -Path ..\samples-converted | Out-Null
Copy-Item -Path samples-converted\* -Destination ..\samples-converted\ -Recurse -Force
```

先运行 `npm run build` 生成最新页面，再选择所需打包命令：

```powershell
npm run package:online                    # Web / Server 部署包
node node_modules/electron/install.js      # 首次准备 Electron 运行时
powershell -File tools/package-win.ps1     # Windows 便携包
powershell -File tools/build-android.ps1 -Online  # Android，首次下载依赖
```

Android 构建需 JDK 21 与 Android SDK，具体版本和环境配置见工作流；后续依赖就绪时可运行 `npm run android:package`。Android 脚本会重新构建 Web 并同步至 Capacitor。

| 格式 | 内容 |
| --- | --- |
| `.nfm` | ZIP 谱面包：`chart.nf` 与音频、背景、视频、故事板等资源 |
| `.nfsk` | ZIP 皮肤包：`skin.nfskin` 与图片、音效等资源 |

导入时自动转换，也支持 `npm run convert <file>` 命令行转换。曲库可导出 `.nfm`；Windows 使用应用数据目录，Web / Android 使用 IndexedDB 保存本地资源。

```text
src/core/       谱面与皮肤解析、计分、难度与存储
src/engine/     音频、输入、判定与渲染
src/ui/         菜单、选歌、设置、账号、排行榜与游玩界面
server/         中心谱面服务器
electron/       Windows 客户端壳
android/        Android 客户端壳
tools/          转换、测试与打包工具
```

</details>

## 兼容范围

- `.osz` / `.mcz` 导入面向键盘下落式谱面；皮肤效果以已支持的格式字段为准。内置 OSU 示例原作提供 4K，Malody 斜轨示例提供 4/5/6K。
- 旧转换器遗漏动画素材的自定义皮肤需要重新导入原 `.osk`；与旧内置 OSU 示例内容完全一致的包会在加载时修复，保留用户原文件。
- Storyboard 的 Trigger 事件按 Pass/Fail 分层近似实现，Sample 音效事件尚未实现；视频能否播放取决于浏览器或 WebView 的解码能力。
- 手机网页方向锁定受浏览器限制，不支持时需手动横置设备；音乐首次播放可能需要点击启用音频。
- 当前提供的是下落速度调节，DT / HT 音乐变速尚未实现。

项目包含解析、判定、皮肤、音频、在线同步与界面回归测试，可运行 `npm test` 与 `npm run typecheck`，另有真实 Chrome 公告交互及多尺寸 Canvas 布局验证。Windows / Android 原生设备体验仍需实机验证。

判定与交互设计参考 osu!mania、Malody；示例皮肤保留原作者信息。欢迎通过 Issues 反馈问题，附上客户端/服务器版本、平台、复现步骤及相关谱面或皮肤信息。
