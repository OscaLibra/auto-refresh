# 空闲自动刷新（会话保活）· Chrome / Edge 扩展

在指定页面上检测「多久没有任何操作」，到点自动刷新页面（或只发一次同源保活请求），
避免长时间空闲被服务端的滑动过期策略踢回登录页、丢掉未提交的表单。

- 目标平台：Chrome / Edge，**Manifest V3**，`minimum_chrome_version: 120`
- 版本：1.0.0
- 设计依据：AR-TD-001《技术方案与架构设计》、AR-SPEC-002《开发规范》、AR-PRC-003《开发流程与验收》

---

## 一、先跑起来（3 步）

1. 打开 `chrome://extensions` → 右上角打开「开发者模式」→ 点「加载已解压的扩展程序」→ 选中本目录（含 `manifest.json` 的那一层）。
2. 点扩展卡片上的「扩展程序选项」，填写网址（只填域名也行，会自动补成 `https://域名/*`）→ 保存 → 弹窗里点「允许」。
3. 打开那个页面，等阈值时间不要动鼠标键盘，页面会自动刷新；工具栏图标上的角标显示剩余分钟数。

> 只想立刻验证？把阈值设成 **1 分钟**，10 分钟后就知道结果了。上线前记得改回来。

---

## 二、为什么是这个架构（评审时最常被问的四件事）

| 决策 | 做法 | 原因 |
| --- | --- | --- |
| 计时主责放哪 | **content script 判决，SW 只做 30 秒巡检兜底** | content 与页面同生命周期、前台定时器精度 1 秒；SW 拿不到鼠标键盘事件，且每 30 秒才醒一次 |
| 怎么注入 | **`chrome.scripting.registerContentScripts` 动态注册**，manifest 里没有 `content_scripts` 段 | 规则由用户定义，静态声明只能写死；写全站通配会在安装时要求「读取和更改您在所有网站上的数据」，企业内分发会被安全团队直接拦下 |
| 权限怎么给 | `permissions: [storage, alarms, scripting]` + `optional_host_permissions: ["*://*/*"]` | **安装时零权限提示**，只在用户添加某个网址时弹一次「允许访问 oa.example.com」 |

> 权限按**域名**申请（`https://host/*`），脚本按**路径**注册（`https://host/app/*`）。
> 因为带路径的 `origins` 在部分 Chrome 版本会让 `permissions.request` 直接抛错，
> 一旦抛错用户就卡在授权环节且无法自救；而 host 权限本来就是按域名授予的，两者语义等价。
> 相应地，删除规则时只有「该域名下没有其它规则」才会撤销权限，避免误伤。
| 到点了做什么 | `reload`（默认）与 `ping` 两个**执行器**，共用同一套计时与判决 | reload 续期最可靠但会打断；ping 不打断但部分系统只在渲染页面的 GET 上续期。加新动作只需加一个执行器，不动计时核心 |

三条必须知道的产品级约束：

- **后台标签的定时器会被降频到每分钟 1 次**（Chromium intensive throttling），所以只能承诺「约 N 分钟 + 最多 1 分钟误差」。因此计时全程用**时间戳差值**，绝不用计数器累加。
- **页面的 `beforeunload` 会拦住刷新**。刷新后埋 3 秒存活探针，探针到期代码还在跑就说明被拦了 → 重置计时 + 提示改用保活模式，否则会每 30 秒弹一次确认框。
- **`scroll` 默认不算「有操作」**。日志流、轮播、无限加载会让 scroll 持续触发且 `isTrusted` 仍为 `true`，无法与真实滚动区分，打开就会永不刷新。该项作为设置项暴露，默认关闭。
- **窗口可见性变化不算「有操作」**。最小化、切到别的窗口再回来，都不重置计时——只有真实的鼠标 / 键盘事件才算。否则「最小化 9 分钟再打开（阈值 10 分钟）」会让页面实际空闲 19 分钟才刷新，会话早就过期了。这条与 AR-TD-001 4.3「转为可见即视为活动」的原设计不同，1.0.1 起修正，理由写在 `30-idle-judge.js` 与 `99-main.js` 的注释里。

---

## 三、工程结构

```
auto-refresh/
├── manifest.json
├── icons/                        # 16 / 48 / 128（由 tools/make-icons.py 生成）
├── src/
│   ├── background/               # service worker，ESM，无 DOM
│   │   ├── service-worker.js     # 入口：只做装配，监听器全部顶层同步注册
│   │   ├── rules-store.js        # 规则/设置的唯一写者 + schema 迁移 + 串行队列
│   │   ├── registrar.js          # 动态注册（幂等 diff、权限回写）
│   │   ├── content-manifest.js   # CONTENT_JS 清单（顺序即依赖顺序）
│   │   ├── session-store.js      # 标签会话 + 诊断环形缓冲（storage.session）
│   │   ├── patrol.js             # 30 秒 alarms 巡检兜底
│   │   ├── badge.js              # 角标剩余分钟
│   │   └── message-router.js     # 消息分发
│   ├── content/                  # 注入脚本，IIFE + window.AR，无 ESM
│   │   ├── 00-config.js          # 常量、命名空间、共享状态
│   │   ├── 10-rule-match.js      # 规则匹配（含原因码）
│   │   ├── 20-activity.js        # 活动监听（capture + passive）
│   │   ├── 30-idle-judge.js      # 计时判决（主责）
│   │   ├── 40-executors.js       # reload / ping 执行器
│   │   ├── 50-overlay.js         # Shadow DOM 倒计时浮层
│   │   ├── 60-scroll-keeper.js   # 滚动位置记录与恢复
│   │   ├── 70-telemetry.js       # 上报与诊断（节流 + 静默失败）
│   │   └── 99-main.js            # 装配入口（必须最后加载）
│   ├── options/                  # 设置页（ESM）
│   ├── popup/                    # 工具栏弹窗（ESM）
│   └── shared/                   # 纯函数与常量（两侧共用 / content 侧复制）
├── docs/
│   ├── 用户手册.md
│   ├── 运维手册.md
│   └── 验收清单.md
└── tools/
    ├── make-icons.py             # 生成三档 PNG（不依赖 Pillow）
    ├── verify.mjs                # 静态自检 + pattern 单元测试
    ├── simulate.mjs              # content 端运行时冒烟测试（39 项）
    ├── simulate-sw.mjs           # service worker 集成测试（57 项）
    └── pack.mjs                  # 打包成可分发的 zip
```

**content 的数字前缀就是依赖顺序**，`99-main.js` 必须最后。新增模块要同步改两处：
文件名前缀 + `src/background/content-manifest.js` 的 `CONTENT_JS`（`tools/verify.mjs` 会校验两者一致）。

---

## 四、本地自检

需要 Node 18+（生成图标需要 Python 3）。

```bash
node tools/verify.mjs        # 120 项：manifest 权限红线、content 无 ESM、常量一致性、pattern 单测
node tools/simulate.mjs      # 39 项：装配、到点刷新、提示浮层、ping、iframe、休眠唤醒、时间回拨、最小化恢复
node tools/simulate-sw.mjs   # 57 项：规则 CRUD、动态注册幂等、会话、暂停、巡检兜底、诊断导出
python3 tools/make-icons.py  # 重新生成图标
node tools/pack.mjs          # 产出 dist/auto-refresh-{version}.zip（dist/ 不入库）
```

分发包不走版本库：`dist/` 已被 `.gitignore` 排除，`node tools/pack.mjs` 生成的 zip 作为 **GitHub Release 附件**发布。

三套检查全部通过再发布。真实浏览器里的 25 条手工用例见 `docs/验收清单.md`（TC-01 ~ TC-25）。

### 调试上下文（最常混淆的地方）

| 代码 | 日志在哪看 |
| --- | --- |
| content script | 目标页 F12 → Console → 左上角上下文切到扩展名（默认是 `top`，看不到） |
| service worker | `chrome://extensions` → 本扩展卡片 → 点「服务工作进程」 |
| options / popup | 各自页面的 DevTools（popup 需右键图标 →「审查弹出内容」） |

SW 显示 `Service worker (inactive)` 是正常回收，不是崩溃；点一下按钮就会唤醒。
调试时把设置页的「输出调试日志」打开，content 里会出现 `[AR]` 前缀日志，并暴露 `window.__arTick()` 可手动跑一次判决，不用真等 10 分钟。

---

## 五、这个插件做不了什么

- **救不回已经过期的会话**。它只在会话还有效时续期；真过期了刷新就是正常跳登录页，这是预期结果，不是缺陷。
- **不保证秒级准时**。后台标签最坏延迟约 60 秒，兜底巡检再加 90 秒宽限。
- **不支持带端口的规则**。Chrome 的 match pattern 不支持端口，添加 `https://oa.example.com:8443/app` 会被自动剥成 `https://oa.example.com/app*`（规则会覆盖该域名的所有端口）。
- **不监听 SPA 的 `pushState`**。本期用 `tabs.onUpdated` + `resync` 降级：站内路由切换后最多 90 秒内按新 URL 重新判定。
- **不能跨浏览器同步规则**。刻意不用 `storage.sync`：内网 URL 不该跨设备同步，且配额容易爆。

## 六、合规红线（不得越界）

- 不读 Cookie、不读表单值、不读剪贴板、不接触任何凭据。
- 不向第三方域名发任何请求；没有任何埋点、统计 SDK 或远程代码。`ping` 模式只请求 `location.href` 自身。
- 不模拟点击、不自动填账号密码、不绕过二次认证、不绕过付费墙或风控。
- **不得用于考勤或在岗监控**。活动时间戳只存本机 `storage.session`，随浏览器关闭清空，不上传、不落盘、不聚合。
- 会话状态的写入权只属于 SW；规则只存 `storage.local`。任何「双写同一状态」的改动都属于设计违规。
