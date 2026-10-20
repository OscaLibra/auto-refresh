# CHANGELOG

遵循 SemVer。分组：新增 / 修复 / 变更 / 移除。

## 1.0.0

初始版本，按 AR-TD-001 / AR-SPEC-002 / AR-PRC-003 实现。

### 新增

- 规则管理：按网址（支持路径通配）增删改启停，改动即时生效，无需重载扩展。
- 空闲计时：基于时间戳差值判决，前台精度 1 秒；30 秒防抖底线。
- 两种到点动作：`reload`（刷新页面，默认）与 `ping`（同源 HEAD 保活，失败降级 GET + Range）。
- 刷新前倒计时浮层（Shadow DOM closed），支持「稍后，重新计时」。
- 刷新后恢复滚动位置（`scrollY` 偏差 ≤ 4px，最多重试 20 次 / 3 秒）。
- 标签角标显示剩余分钟；暂停时显示 `||`。
- 工具栏弹窗：规则名、剩余 mm:ss、模式、暂停/恢复、立即刷新。
- 后台标签兜底：`alarms` 每 30 秒巡检，阈值 = `idleMs + 90s`。
- iframe 支持：`allFrames: true` 注入，子帧只上报活动，由 SW 转交顶层帧计时。
- 休眠唤醒宽限（默认 2 秒）+ 系统时间回拨保护。
- `beforeunload` 拦截检测：3 秒存活探针，重置计时避免连环弹框。
- 诊断：最近 50 条事件环形缓冲 + 一键导出（不含 URL 的 query/hash）。
- 权限最小化：安装零提示，按站点 `optional_host_permissions` 动态申请。
- 五道本地自检：`verify.mjs`（117 项）、`simulate.mjs`（33 项）、`simulate-sw.mjs`（57 项）、`make-icons.py`、`pack.mjs`。

### 已知限制

- 后台标签定时器降频，最坏延迟约 60 秒（产品承诺写作「约 N 分钟」）。
- match pattern 不支持端口，带端口的网址会被自动剥离端口。
- SPA 路由变化采用 `tabs.onUpdated` + `resync` 降级，不做 `pushState` 劫持。
- 不使用 `storage.sync`，规则不跨设备同步。

### 移除

- 无（首版）。
