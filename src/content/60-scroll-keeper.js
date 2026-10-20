/**
 * 60-scroll-keeper.js —— 刷新后恢复滚动位置（content 世界）
 *
 * 职责：刷新前记下 scrollY，刷新后回到原位。
 *
 * 例外说明（规范 2.3）：本文件是整个项目里唯一允许用 sessionStorage 的地方。
 *   滚动位置是"本标签、本页面"的瞬态数据，sessionStorage 的生命周期（标签级、
 *   导航后保留、关标签即清）正好匹配；而且刷新恢复必须同步读取——
 *   异步的 chrome.storage 会晚于首屏渲染，导致页面先跳到顶部再弹回原位的跳动。
 */

(function () {
  'use strict';

  const AR = window.AR && window.AR.__ours ? window.AR : window.__AR__;
  if (!AR) return;

  const C = AR.const;
  /** 恢复时的最大重试次数：页面资源陆续到位会把滚动位置重置 */
  const MAX_TRIES = 20;
  const RETRY_MS = 150;
  /** 允许的偏差（像素），小于它就不再重试 */
  const TOLERANCE = 4;

  /** key 必须带完整 URL，否则同一标签内不同页面的位置会互相污染 */
  function key() {
    return C.SCROLL_KEY_PREFIX + location.href;
  }

  /** 刷新前调用：记录当前位置 */
  function save() {
    try {
      const y = window.scrollY || window.pageYOffset || 0;
      if (y > 0) sessionStorage.setItem(key(), String(Math.round(y)));
    } catch {
      // 静默：隐私模式或站点禁用 storage 时保存失败，退化为"刷新后回到顶部"
    }
  }

  /** 页面启动时调用：恢复位置（同步读，异步重试） */
  function restore() {
    let y = 0;
    try {
      const raw = sessionStorage.getItem(key());
      if (!raw) return;
      y = Number(raw);
      // 一次性使用：恢复后立刻清掉，避免用户下次主动刷新时被莫名其妙带回旧位置
      sessionStorage.removeItem(key());
    } catch {
      return;
    }
    if (!Number.isFinite(y) || y <= 0) return;

    let tries = 0;
    const attempt = () => {
      if (tries++ > MAX_TRIES) return;
      try {
        window.scrollTo(0, y);
      } catch {
        return;
      }
      if (Math.abs((window.scrollY || 0) - y) <= TOLERANCE) return;
      // 内容还在加载（高度不够）时 scrollTo 会被截断，因此持续重试直到到位或放弃
      setTimeout(attempt, RETRY_MS);
    };
    // 放到下一帧：此时首屏已解析，滚动高度才存在
    setTimeout(attempt, 0);
  }

  AR.scroll = { save, restore };
})();
