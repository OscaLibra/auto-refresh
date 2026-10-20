/**
 * 99-main.js —— 装配入口（content 世界，必须最后加载）
 *
 * 职责：把前面 8 个模块组装成一个可运行的实例：读配置 → 匹配规则 → 装监听 → 起判决。
 * 为什么必须最后：它要用到 00~70 挂在 window.AR 上的全部能力，靠 manifest 的 js 数组
 *   顺序保证依赖。任何新模块插入都必须同步改 content-manifest.js。
 * 为什么顶层帧与子帧走两条分支：跨域 iframe 里的 click / keydown 不会冒泡到顶层，
 *   如果只在顶层监听，主操作区在 iframe 的后台系统会被误刷新；但子帧绝不能自己执行刷新
 *   （会把整个页面刷掉），所以子帧只上报活动，由 SW 转交给顶层帧（AR-TD-001 2.8）。
 */

(function () {
  'use strict';

  const AR = window.AR && window.AR.__ours ? window.AR : window.__AR__;
  if (!AR) return;

  const C = AR.const;
  const st = AR.state;

  // 双实例守卫（规范 5.3）：bfcache 恢复、或开发期手动重载扩展后，
  // 同一页面可能出现两份脚本，不拦住就会双倍计时、双倍刷新。
  if (st.booted) return;
  st.booted = true;

  st.isTop = window.top === window;

  /** 与 rules-store.js 的 DEFAULT_SETTINGS 同值（content 不能 import，故复制一份） */
  const DEFAULTS = Object.freeze({
    globalEnabled: true,
    defaultIdleMinutes: 10,
    defaultMode: 'reload',
    defaultPromptSeconds: 0,
    defaultKeepScroll: true,
    wakeGraceMs: 2000,
    minExecIntervalMs: 30000,
    activityReportThrottleMs: 10000,
    countScrollAsActivity: false,
    notifyOnBlocked: true,
    debug: false,
  });

  // 滚动恢复必须尽早：同步读 sessionStorage，不能等异步的配置回来（否则会看到一次跳动）
  if (AR.scroll) AR.scroll.restore();

  /** 监听只挂一次：resync / boot 可能被多次调用，重复绑定会导致同一事件处理多次 */
  let msgBound = false;
  let storageBound = false;
  let pagehideBound = false;

  if (!st.isTop) {
    startChildFrame();
    return;
  }
  startTopFrame();

  /* ================================================================== */
  /* 顶层帧                                                              */
  /* ================================================================== */

  function startTopFrame() {
    // 监听必须"早于生效"注册：页面可能一开始因全局开关关闭 / 尚无规则而未启动，
    // 之后用户在设置页打开开关，只有提前挂上监听才能就地唤醒（无需刷新页面）。
    bindRuntimeMessages();
    bindStorageChanges();

    loadConfig()
      .then((ok) => {
        if (!ok) {
          AR.log('warn', 'storage-unavailable');
          return;
        }
        applyRule();
        if (!st.rule) {
          // 未命中规则：不起定时器、不上报，页面零开销（TC-06 要求 Console 无输出）
          AR.log('debug', C.EV.NO_MATCH, AR.safeUrl(location.href));
          return;
        }
        if (!st.enabled) {
          AR.log('debug', 'disabled', 'globalEnabled=false 或规则已停用');
          return;
        }
        boot();
      })
      .catch((e) => AR.log('warn', 'init-failed', e && e.message));
  }

  function boot() {
    st.ready = true;
    st.lastActivityAt = Date.now();

    AR.activity.start(onUserSignal, { countScroll: !!st.settings.countScrollAsActivity });
    AR.telemetry.hello();
    AR.judge.start();

    if (!pagehideBound) {
      pagehideBound = true;
      window.addEventListener('pagehide', onPageHide);
    }

    AR.log('info', 'booted', {
      rule: st.rule && st.rule.id,
      idleMin: Math.round(st.idleMs / 60000),
      mode: st.mode,
      promptSec: st.promptSeconds,
    });
  }

  /**
   * 读规则与设置。content 只读 storage.local（规范 5.1：会话状态由 SW 独占维护）。
   * @returns {Promise<boolean>}
   */
  async function loadConfig() {
    if (!chrome.storage || !chrome.storage.local) return false;
    const got = await chrome.storage.local.get([C.K_RULES, C.K_SETTINGS]).catch(() => null);
    if (!got || typeof got !== 'object') return false;

    st.settings = normalizeSettings(got[C.K_SETTINGS]);
    const rules = Array.isArray(got[C.K_RULES]) ? got[C.K_RULES] : [];
    const m = AR.match.matchRule(location.href, rules);
    st.matchReason = m.reason;
    st.rule = m.rule;
    return true;
  }

  /** 把规则 + 全局默认合成为本次运行的实际参数（规则优先） */
  function applyRule() {
    const s = st.settings || DEFAULTS;
    const r = st.rule;
    if (!r) {
      st.idleMs = 0;
      st.enabled = false;
      return;
    }

    const minutes = clamp(Number(r.idleMinutes) > 0 ? r.idleMinutes : s.defaultIdleMinutes, C.MIN_IDLE_MIN, C.MAX_IDLE_MIN);
    st.idleMs = minutes * 60000;

    const mode = C.EXECUTORS.indexOf(r.mode) >= 0 ? r.mode : s.defaultMode;
    st.mode = C.EXECUTORS.indexOf(mode) >= 0 ? mode : 'reload';

    // 注意 0 是合法值（= 静默刷新），不能用 || 兜底
    st.promptSeconds = clamp(Number.isFinite(r.promptSeconds) ? r.promptSeconds : s.defaultPromptSeconds, 0, C.MAX_PROMPT_SEC);
    st.keepScroll = r.keepScroll === undefined ? s.defaultKeepScroll !== false : r.keepScroll !== false;
    st.allowPingFallback = r.allowPingFallback !== false;
    st.enabled = s.globalEnabled !== false && r.enabled !== false;
  }

  /** 每次真实交互都走这里：重置时间戳 + 隐藏浮层 + 节流上报 */
  function onUserSignal() {
    AR.judge.resetActivity();
    AR.telemetry.activity();
  }

  /**
   * 页面重新可见时立刻结算一次，但**绝不**重置计时。
   *
   * 为什么立刻 tick：页面最小化 / 被冻结期间定时器会被降频甚至暂停，
   *   恢复瞬间可能已经超过阈值很久了，等下一个 tick 是没必要的延迟。
   *
   * 为什么不把"恢复可见"算作用户活动（偏离 AR-TD-001 4.3，见 CHANGELOG 1.0.1）：
   *   原实现把它当成活动，导致"最小化 9 分钟 → 重新打开 → 倒计时回到满值"。
   *   阈值 10 分钟时，页面实际要空闲 19 分钟才会刷新，服务端会话早就过期了——
   *   这与插件的核心目的直接冲突。
   *   "有没有操作"只应由真实的鼠标 / 键盘事件决定；窗口可见与否是浏览器行为，
   *   既不代表用户离开，也不代表用户回来。最小化期间刷新照常发生，用户看不到而已。
   */
  function onVisibilityChange() {
    if (document.visibilityState !== 'visible') return;
    AR.judge.tick();
  }

  /** 页面卸载：清定时器与浮层，避免 bfcache 恢复后出现双实例 */
  function onPageHide() {
    AR.judge.stop();
    AR.activity.stop();
    AR.overlay.destroy();
    AR.telemetry.bye('pagehide');
  }

  /** 监听只挂一次：resync / boot 可能被多次调用 */
  /* ---------------- 消息 ---------------- */

  function bindRuntimeMessages() {
    if (msgBound) return;
    msgBound = true;

    document.addEventListener('visibilitychange', onVisibilityChange, { passive: true });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return false;

      if (msg.type === C.MSG.TAB_COMMAND) {
        handleCommand(msg.payload);
        sendResponse({ ok: true });
        return false;
      }
      if (msg.type === C.MSG.BROADCAST) {
        const ev = msg.payload && msg.payload.event;
        if (ev === 'rules-changed' || ev === 'settings-changed') resync();
        sendResponse({ ok: true });
        return false;
      }
      if (msg.type === C.MSG.FRAME_ACTIVITY) {
        const at = Number(msg.payload && msg.payload.at);
        if (Number.isFinite(at)) st.lastActivityAt = Math.max(st.lastActivityAt, at);
        sendResponse({ ok: true });
        return false;
      }
      return false;
    });
  }

  /** @param {{cmd:string, at?:number}} p */
  function handleCommand(p) {
    if (!p || !p.cmd) return;
    switch (p.cmd) {
      case 'pause':
        st.paused = true;
        AR.overlay.hideCountdown();
        break;
      case 'resume':
        st.paused = false;
        AR.judge.resetActivity();
        break;
      case 'refresh':
        runExecutor('manual');
        break;
      case 'resync':
        resync();
        break;
      case 'activity':
        // SW 转交的子帧活动（跨域 iframe 的交互到不了这里，只能由 SW 中转）
        if (Number.isFinite(p.at)) st.lastActivityAt = Math.max(st.lastActivityAt, p.at);
        break;
      default:
        break;
    }
  }

  function runExecutor(reason) {
    const ex = AR.executors.get(st.mode);
    if (!ex) return;
    Promise.resolve(ex.run({ mode: st.mode, rule: st.rule, idleMs: st.idleMs })).catch((e) =>
      AR.log('warn', 'exec-error', `${reason}: ${e && e.message}`),
    );
  }

  /**
   * 重新匹配规则（SPA 路由变化 / 规则被改 / 设置被改都走这里）。
   * 这是 R-12 的降级方案：不做 MAIN world 劫持 pushState，
   * 而是由 SW 在 tabs.onUpdated 里发现 URL 变化后下发 resync。
   */
  async function resync() {
    const ok = await loadConfig();
    if (!ok) return;
    applyRule();
    AR.telemetry.event(C.EV.RESYNC, `${AR.safeUrl(location.href)} ${st.matchReason}`);

    if (!st.rule || !st.enabled) {
      // 新 URL 不再命中规则：必须停表，否则会按旧规则刷一个不该刷的页面
      AR.judge.stop();
      AR.overlay.hideCountdown();
      st.ready = false;
      AR.telemetry.bye('rule-lost');
      return;
    }

    AR.activity.start(onUserSignal, { countScroll: !!st.settings.countScrollAsActivity });
    AR.judge.resetActivity();
    if (!st.ready) {
      st.ready = true;
      AR.judge.start();
    }
    AR.telemetry.hello();
  }

  /** 规则 / 设置在别处被改时即时生效，无需刷新页面（FR-01 要求） */
  function bindStorageChanges() {
    if (storageBound) return;
    if (!chrome.storage || !chrome.storage.onChanged) return;
    storageBound = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[C.K_RULES] || changes[C.K_SETTINGS]) resync();
    });
  }

  /* ================================================================== */
  /* 子帧                                                               */
  /* ================================================================== */

  function startChildFrame() {
    if (!chrome.runtime || !chrome.runtime.id) return;
    // 只上报活动：不读规则、不计时、不刷新
    AR.activity.start(() => {
      st.lastActivityAt = Date.now();
      AR.telemetry.activity({ frame: true });
    });
    window.addEventListener('pagehide', () => AR.activity.stop());
  }

  /* ================================================================== */
  /* 工具                                                               */
  /* ================================================================== */

  /**
   * @param {any} raw
   * @returns {typeof DEFAULTS}
   */
  function normalizeSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      globalEnabled: s.globalEnabled !== false,
      defaultIdleMinutes: clamp(Number(s.defaultIdleMinutes) || 10, C.MIN_IDLE_MIN, C.MAX_IDLE_MIN),
      defaultMode: s.defaultMode === 'ping' ? 'ping' : 'reload',
      defaultPromptSeconds: clamp(Number(s.defaultPromptSeconds) || 0, 0, C.MAX_PROMPT_SEC),
      defaultKeepScroll: s.defaultKeepScroll !== false,
      wakeGraceMs: clamp(Number(s.wakeGraceMs) || 2000, 0, 60000),
      minExecIntervalMs: clamp(Number(s.minExecIntervalMs) || 30000, 1000, 600000),
      activityReportThrottleMs: clamp(Number(s.activityReportThrottleMs) || 10000, 1000, 300000),
      countScrollAsActivity: s.countScrollAsActivity === true,
      notifyOnBlocked: s.notifyOnBlocked !== false,
      debug: s.debug === true,
    };
  }

  /**
   * @param {number} v
   * @param {number} min
   * @param {number} max
   */
  function clamp(v, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }
})();
