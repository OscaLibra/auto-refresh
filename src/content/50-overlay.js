/**
 * 50-overlay.js —— 刷新前倒计时浮层（content 世界）
 *
 * 职责：到点前给用户一个可见的"要刷新了"，并提供"稍后"。
 * 为什么必须用 Shadow DOM（closed）：站点普遍有 `* { box-sizing }`、`div { display:block }`
 *   这类全局样式，直接插 DOM 会被污染变形；closed 模式则让站点脚本拿不到 shadowRoot，
 *   没法篡改我们的浮层。
 * 为什么挂 documentElement 而不是 body：部分站点给 body 加了 `overflow:hidden` 或
 *   `transform`，会让 fixed 定位失效（规范 7.1）。
 */

(function () {
  'use strict';

  const AR = window.AR && window.AR.__ours ? window.AR : window.__AR__;
  if (!AR) return;

  const HOST_ID = 'ar-overlay-host';
  let host = null;
  let root = null;
  /** @type {HTMLElement | null} */
  let cardEl = null;
  let numEl = null;
  let snoozeFn = null;
  let toastTimer = 0;

  const STYLE = `
    :host { all: initial; }
    .ar-card {
      position: fixed; right: 24px; bottom: 24px; z-index: 2147483647;
      min-width: 240px; max-width: 320px; box-sizing: border-box;
      padding: 14px 16px; border-radius: 10px;
      background: #1f2328; color: #ffffff;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      box-shadow: 0 8px 28px rgba(0,0,0,.28);
      pointer-events: auto;
    }
    .ar-title { font-size: 13px; font-weight: 600; margin: 0 0 4px; }
    .ar-title b { font-variant-numeric: tabular-nums; }
    .ar-sub { font-size: 12px; color: #c9d1d9; margin: 0 0 10px; }
    .ar-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .ar-btn {
      font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer;
      border: 1px solid #8b949e; background: transparent; color: #ffffff;
      pointer-events: auto;
    }
    .ar-btn:hover { background: rgba(255,255,255,.12); }
    .ar-btn:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }
    .ar-toast {
      position: fixed; right: 24px; bottom: 24px; z-index: 2147483647;
      max-width: 320px; box-sizing: border-box; padding: 10px 14px; border-radius: 8px;
      background: #bf8700; color: #ffffff;
      font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      box-shadow: 0 8px 28px rgba(0,0,0,.25);
    }
  `;

  /** 惰性创建宿主（只有真正要用时才插 DOM，空闲时不占任何资源） */
  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; right: 0; bottom: 0;';
    // closed：站点拿不到 shadowRoot，无法读改浮层内容
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);
    document.documentElement.appendChild(host);
  }

  /**
   * 显示 / 更新倒计时卡片。
   * @param {number} remainSec 剩余秒数
   * @param {() => void} onSnooze 点"稍后"的回调
   */
  function showCountdown(remainSec, onSnooze) {
    ensureHost();
    snoozeFn = onSnooze;

    if (!cardEl) {
      cardEl = document.createElement('div');
      cardEl.className = 'ar-card';
      cardEl.setAttribute('role', 'status');
      cardEl.setAttribute('aria-live', 'polite');

      const title = document.createElement('div');
      title.className = 'ar-title';
      title.appendChild(document.createTextNode('页面将在 '));
      numEl = document.createElement('b');
      numEl.textContent = String(remainSec);
      title.appendChild(numEl);
      title.appendChild(document.createTextNode(' 秒后自动刷新'));

      const sub = document.createElement('div');
      sub.className = 'ar-sub';
      sub.textContent = '用于保持登录状态，避免长时间无操作被登出';

      const actions = document.createElement('div');
      actions.className = 'ar-actions';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ar-btn';
      btn.textContent = '稍后，重新计时';
      btn.addEventListener('click', () => {
        hideCountdown();
        if (typeof snoozeFn === 'function') snoozeFn();
      });
      actions.appendChild(btn);

      cardEl.append(title, sub, actions);
      root.appendChild(cardEl);
    }

    if (numEl) {
      const v = String(Math.max(0, remainSec));
      // 只在秒数变化时写 DOM，避免每秒无意义的重排
      if (numEl.textContent !== v) numEl.textContent = v;
    }
  }

  /** 隐藏倒计时（不销毁，snooze 后复用） */
  function hideCountdown() {
    if (cardEl && cardEl.parentNode) cardEl.parentNode.removeChild(cardEl);
    cardEl = null;
    numEl = null;
  }

  /**
   * 轻提示（如"刷新被页面拦截"），若干秒后自动消失。
   * @param {string} text
   * @param {number} [ms]
   */
  function toast(text, ms) {
    ensureHost();
    const el = document.createElement('div');
    el.className = 'ar-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.textContent = String(text || '');
    root.appendChild(el);

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
      toastTimer = 0;
    }, Number(ms) > 0 ? Number(ms) : 8000);
  }

  /** 彻底移除宿主（pagehide 时调用，避免 bfcache 恢复后出现两个浮层） */
  function destroy() {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = 0;
    cardEl = null;
    numEl = null;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    root = null;
  }

  AR.overlay = { showCountdown, hideCountdown, updateCountdown: showCountdown, toast, destroy };
})();
