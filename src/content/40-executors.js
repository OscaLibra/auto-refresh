/**
 * 40-executors.js —— 到点动作执行器（content 世界）
 *
 * 职责：真正"做那件事"。两种模式共用同一套计时与判决，只在执行器层分叉。
 * 为什么分 reload / ping：
 *   reload  Sessions 续期最可靠（等价于用户真实访问），但会打断（未保存表单会丢）；
 *   ping    不发导航、只发同源轻量请求，不打断，但部分系统只在渲染页面的 GET 上续期。
 * 扩展方式：新增动作 = 新增一个 {name, run, canRun} 对象并在 EXECUTORS 登记，
 *   同时更新规则 schema 与 options 下拉框（三处一致，缺一处表现为"用户选了但无效"）。
 */

(function () {
  'use strict';

  const AR = window.AR && window.AR.__ours ? window.AR : window.__AR__;
  if (!AR) return;

  const C = AR.const;
  const st = AR.state;

  /** 请求超时：ping 是"轻量保活"，不能挂在那儿 */
  const PING_TIMEOUT_MS = 8000;

  /* ------------------------------------------------------------------ */
  /* reload 执行器                                                       */
  /* ------------------------------------------------------------------ */

  const reloadExecutor = {
    name: 'reload',
    canRun() {
      return true;
    },
    /**
     * @param {{mode:string, rule:any, idleMs:number}} ctx
     * @returns {Promise<{ok:boolean, code:string}>}
     */
    async run(ctx) {
      const now = Date.now();
      if (now - st.lastExecAt < C.MIN_EXEC_INTERVAL_MS) return { ok: false, code: 'debounced' };
      st.lastExecAt = now;

      // 刷新前记录滚动位置（sessionStorage，见 60-scroll-keeper.js 的例外说明）
      if (st.keepScroll && AR.scroll) AR.scroll.save();

      report(C.EV.RELOAD_START, `idle=${Math.round((ctx && ctx.idleMs ? ctx.idleMs : st.idleMs) / 1000)}s`);

      // 3 秒存活探针：如果 3 秒后这段代码还在跑，说明页面根本没卸载，
      // 即刷新被 beforeunload 拦住了（用户点了"取消"）。必须重置计时，
      // 否则下一轮 tick 又会刷新 → 每 30 秒弹一次确认框的死循环（R-02）。
      let probe = 0;
      try {
        probe = setTimeout(onReloadBlocked, C.RELOAD_PROBE_MS);
      } catch (e) {
        AR.log('warn', 'probe-schedule-failed', e && e.message);
      }

      try {
        location.reload();
      } catch (e) {
        if (probe) clearTimeout(probe);
        AR.log('warn', 'reload-throw', e && e.message);
        return { ok: false, code: 'reload-error' };
      }
      return { ok: true, code: 'reloading' };
    },
  };

  /** 探针到期仍未卸载：判定被拦截 */
  function onReloadBlocked() {
    st.lastActivityAt = Date.now();
    st.lastExecAt = Date.now();
    report(C.EV.RELOAD_BLOCKED, 'beforeunload intercepted');
    if (st.settings && st.settings.notifyOnBlocked && AR.overlay) {
      AR.overlay.toast('页面拦截了自动刷新（可能存在未保存内容），建议改用"保活"模式');
    }
  }

  /* ------------------------------------------------------------------ */
  /* ping 执行器                                                         */
  /* ------------------------------------------------------------------ */

  const pingExecutor = {
    name: 'ping',
    canRun() {
      return true;
    },
    async run(ctx) {
      const now = Date.now();
      if (now - st.lastExecAt < C.MIN_EXEC_INTERVAL_MS) return { ok: false, code: 'debounced' };
      st.lastExecAt = now;

      const url = location.href;
      let res = await quietFetch(url, { method: 'HEAD' });

      // 不少后端路由不支持 HEAD，会回 405 / 501：退化为 GET + Range: bytes=0-0
      if (res && (res.status === 405 || res.status === 501)) {
        res = await quietFetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
      }

      if (res && res.ok) {
        st.lastActivityAt = Date.now();
        report(C.EV.PING_OK, `status=${res.status}`);
        return { ok: true, code: 'ping-ok' };
      }

      report(C.EV.PING_FALLBACK, res ? `status=${res.status}` : 'network-error');

      if (st.allowPingFallback) {
        // 降级：保活失败时按刷新兜底，保证会话最终不会失效
        AR.log('warn', 'ping-fallback-reload');
        return reloadExecutor.run(ctx);
      }
      // 不允许降级：重置计时，等下一轮再试（避免每秒重试打爆请求）
      st.lastActivityAt = Date.now();
      return { ok: false, code: 'ping-failed' };
    },
  };

  /**
   * 同源轻量请求：带 cookie（续期依赖它），不缓存，超时即放弃。
   * 只允许打当前页同源地址——本插件不向任何第三方域名发请求（合规红线）。
   * @param {string} url
   * @param {RequestInit} init
   * @returns {Promise<Response|null>}
   */
  async function quietFetch(url, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
    try {
      return await fetch(url, {
        ...init,
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        signal: ctrl.signal,
      });
    } catch {
      // 静默：网络错误 / 被 CSP 拦 / 超时都走"保活失败"的降级链，不打扰用户
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 注册表                                                             */
  /* ------------------------------------------------------------------ */

  const REGISTRY = { reload: reloadExecutor, ping: pingExecutor };

  /**
   * @param {string} name
   * @returns {{name:string, run:Function, canRun:Function} | null}
   */
  function get(name) {
    return REGISTRY[name] || null;
  }

  /**
   * @param {string} event
   * @param {string} [detail]
   */
  function report(event, detail) {
    if (AR.telemetry) AR.telemetry.event(event, detail);
  }

  AR.executors = { get, list: Object.keys(REGISTRY), reload: reloadExecutor, ping: pingExecutor };
})();
