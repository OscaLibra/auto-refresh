/**
 * 30-idle-judge.js —— 空闲判决（content 世界，计时主责）
 *
 * 职责：只判断"到没到点"，不执行任何动作、不操作 DOM。
 * 为什么这样拆：动作的种类会随需求增长（刷新 / 保活 / 以后可能是通知、切标签），
 *   判决必须与动作解耦，否则每加一种动作都要改计时核心。
 * 为什么用时间戳差值而不是计数器：后台标签的定时器会被降频到每分钟 1 次，
 *   计数器会严重滞后（每分钟 +1 秒，10 分钟阈值要跑 10 小时）。
 * 必须处理的三个边界（AR-TD-001 2.4）：系统休眠唤醒、定时器冻结、用户改系统时间。
 */

(function () {
  'use strict';

  const AR = window.AR && window.AR.__ours ? window.AR : window.__AR__;
  if (!AR) return;

  const C = AR.const;
  const st = AR.state;

  /** 启动判决循环（幂等：重复调用不会产生第二个定时器） */
  function start() {
    stop();
    const now = Date.now();
    st.lastTickAt = now;
    if (!st.lastActivityAt) st.lastActivityAt = now;
    st.tickTimer = setInterval(tick, C.TICK_MS);

    // 调试技巧（AR-PRC-003 S4）：临时暴露手动触发，不必真等 10 分钟
    if (st.settings && st.settings.debug) {
      Object.defineProperty(window, '__arTick', {
        value: tick,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    }
  }

  /** 停止判决循环 */
  function stop() {
    if (st.tickTimer) clearInterval(st.tickTimer);
    st.tickTimer = 0;
  }

  /**
   * 重置"上次活动"为现在。所有真实的用户交互都收敛到这一个入口，
   * 保证 iframe 转交、snooze、手动操作的行为完全一致。
   */
  function resetActivity() {
    st.lastActivityAt = Date.now();
    if (st.promptShown) hidePrompt();
  }

  /** 一次判决 */
  function tick() {
    const now = Date.now();
    const drift = now - (st.lastTickAt || now);
    st.lastTickAt = now;

    // 边界一 / 二：两次 tick 间隔远超 1 秒 → 页面被冻结过，或系统刚从休眠唤醒
    if (drift > C.WAKE_DETECT_MS) {
      st.wakeAt = now;
      AR.log('debug', 'wake-detected', { drift });
    }

    // 边界三：用户改系统时间导致时间轴回拨，idle 会变成负数，必须夹住并重设基准
    if (now < st.lastActivityAt) {
      AR.log('warn', 'clock-rollback', { back: st.lastActivityAt - now });
      st.lastActivityAt = now;
    }

    if (!st.enabled || st.paused) {
      hidePrompt();
      return;
    }
    if (!st.rule || !st.idleMs) return;

    const idle = Math.max(0, now - st.lastActivityAt);

    if (idle >= st.idleMs) {
      hidePrompt();

      // 唤醒宽限：用户刚睁眼页面就闪一下体验极差，先等 wakeGraceMs
      const grace = Number((st.settings && st.settings.wakeGraceMs) ?? 2000);
      if (st.wakeAt && now - st.wakeAt < grace) return;

      // 防抖底线：任何执行器 30 秒内不重复触发，避免"刷完立刻又被判超时"
      if (now - st.lastExecAt < C.MIN_EXEC_INTERVAL_MS) {
        st.lastActivityAt = now;
        AR.log('debug', 'exec-debounced');
        return;
      }

      fire();
      return;
    }

    // 提示浮层：距离到点还剩 promptSeconds 时开始倒计时
    const promptMs = (st.promptSeconds || 0) * 1000;
    if (promptMs > 0 && idle >= st.idleMs - promptMs) {
      const remain = Math.max(0, Math.ceil((st.idleMs - idle) / 1000));
      showPrompt(remain);
    } else if (st.promptShown) {
      hidePrompt();
    }
  }

  /** 到点：交给执行器，判决层不关心动作细节 */
  function fire() {
    if (st.execInFlight) return;
    const executor = AR.executors && AR.executors.get(st.mode);
    if (!executor) {
      AR.log('warn', 'executor-missing', st.mode);
      st.lastActivityAt = Date.now();
      return;
    }

    st.execInFlight = true;
    report(C.EV.IDLE_TIMEOUT, `idle=${Math.round(st.idleMs / 1000)}s`);

    Promise.resolve(executor.run({ mode: st.mode, rule: st.rule, idleMs: st.idleMs }))
      .then((res) => {
        // 执行器主动放弃了（被防抖 / 前置条件不满足）：重置计时，避免每秒重试
        if (res && res.ok === false && res.code !== 'reloading') {
          st.lastActivityAt = Date.now();
        }
      })
      .catch((e) => {
        AR.log('warn', 'exec-error', e && e.message);
        report(C.EV.EXEC_ERROR, e && e.message);
        st.lastActivityAt = Date.now();
      })
      .finally(() => {
        st.execInFlight = false;
      });
  }

  /** @param {number} remainSec */
  function showPrompt(remainSec) {
    const ov = AR.overlay;
    if (!ov) return;
    if (!st.promptShown) {
      st.promptShown = true;
      ov.showCountdown(remainSec, onSnooze);
      report(C.EV.PROMPT_SHOWN);
    } else {
      ov.updateCountdown(remainSec);
    }
  }

  function hidePrompt() {
    st.promptShown = false;
    if (AR.overlay) AR.overlay.hideCountdown();
  }

  /** 用户点"稍后"：重新计一轮 */
  function onSnooze() {
    resetActivity();
    report(C.EV.SNOOZE);
  }

  /**
   * @param {string} event
   * @param {string} [detail]
   */
  function report(event, detail) {
    if (AR.telemetry) AR.telemetry.event(event, detail);
  }

  AR.judge = { start, stop, resetActivity, tick };
})();
