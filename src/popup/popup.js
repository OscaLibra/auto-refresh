/**
 * popup.js —— 弹窗逻辑（ESM）
 *
 * 职责：把"当前标签还剩多久刷新"一眼说清楚，并提供暂停 / 立即刷新 / 打开设置。
 * 为什么倒计时在本地递减：每秒向 SW 要一次数据太浪费；先取一次做基准，
 *   本地按 1 秒递减，每 5 秒与 SW 校准一次（popup 关闭即销毁，不存在 SW 的回收问题）。
 */

import { MSG } from '../shared/messages.js';

const $ = (id) => document.getElementById(id);

let tabId = null;
/** @type {{remainMs:number, at:number} | null} */
let base = null;
/** @type {Record<string, any> | null} */
let state = null;
let tickTimer = 0;
let syncTimer = 0;

init().catch(() => {
  setNotice('读取状态失败，请关闭弹窗后重试。');
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  $('btnPause').addEventListener('click', onTogglePause);
  $('btnRefresh').addEventListener('click', onRefreshNow);
  $('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('btnExport').addEventListener('click', onExport);

  await sync();
  tickTimer = setInterval(renderTick, 1000);
  syncTimer = setInterval(sync, 5000);
  // 弹窗关闭时清理，避免无意义的定时器
  window.addEventListener('unload', () => {
    clearInterval(tickTimer);
    clearInterval(syncTimer);
  });
}

/** 从 SW 拉一次真实状态 */
async function sync() {
  if (tabId == null) {
    setOff('无法读取标签页', '请在普通网页中使用本插件。');
    return;
  }
  const res = await send({ type: MSG.SW_GET_STATE, payload: { tabId } });
  if (!res || res.ok !== true) {
    setOff('后台服务未响应', '请稍后重试，或在扩展管理页重载本插件。');
    return;
  }

  state = res.data;
  const { session, rule, remainingMs } = state;
  base = session && typeof remainingMs === 'number' ? { remainMs: remainingMs, at: Date.now() } : null;

  if (!session || !rule) {
    setOff('当前页面未监控', '这个网址不在规则里。到「设置与规则」里添加后即可生效。');
    return;
  }

  // 有会话：点亮状态与元信息
  setDot(session.paused ? 'warn' : 'on');
  $('headState').textContent = session.paused ? '已暂停' : '计时中';

  $('mRule').textContent = rule.label || rule.pattern;
  $('mRule').title = rule.pattern;
  $('mMode').textContent = session.mode === 'ping' ? '仅保活（页面不动）' : '刷新页面';
  $('mIdle').textContent = `${Math.round(session.idleMs / 60000)} 分钟`;

  $('digits').classList.toggle('paused', !!session.paused);
  $('timerLabel').textContent = session.paused ? '已暂停，不会自动刷新' : '后自动刷新';

  $('btnPause').disabled = false;
  $('btnPause').textContent = session.paused ? '恢复计时' : '暂停';
  $('btnRefresh').disabled = false;

  if (rule.permissionGranted === false) {
    setNotice('这条网址的访问权限已失效，规则当前不生效。到「设置与规则」里点「重新授权」。');
  } else if (rule.mode === 'reload' && rule.promptSeconds === 0) {
    setNotice('刷新时页面上未保存的输入会丢失。需要保护时，给这条规则加「刷新前提示」。');
  } else {
    hideNotice();
  }

  renderTick();
}

/** 本地每秒递减显示 */
function renderTick() {
  if (!base) return;
  const remain = Math.max(0, base.remainMs - (Date.now() - base.at));
  const total = Math.floor(remain / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  $('digits').textContent = `${mm}:${ss}`;
}

/* ------------------------------------------------------------------ */
/* 操作                                                               */
/* ------------------------------------------------------------------ */

async function onTogglePause() {
  if (!state?.session || tabId == null) return;
  const next = !state.session.paused;
  $('btnPause').disabled = true;
  const res = await send({ type: MSG.SW_SET_PAUSED, payload: { tabId, paused: next } });
  $('btnPause').disabled = false;

  if (!res || res.ok !== true) {
    setNotice(res?.error?.message || '操作失败，请重试。');
    return;
  }
  await sync();
}

async function onRefreshNow() {
  if (tabId == null) return;
  $('btnRefresh').disabled = true;
  const res = await send({ type: MSG.SW_REFRESH_NOW, payload: { tabId } });
  $('btnRefresh').disabled = false;
  if (!res || res.ok !== true) {
    setNotice(res?.error?.message || '刷新失败，页面可能已关闭。');
    return;
  }
  // 页面正在重载，弹窗随即失效，直接关闭更符合预期
  window.close();
}

async function onExport() {
  const res = await send({ type: MSG.SW_EXPORT_DIAG, payload: {} });
  if (!res || res.ok !== true) {
    setNotice('导出失败，请稍后重试。');
    return;
  }
  const text = JSON.stringify(res.data, null, 2);
  const ok = await copyText(text);
  setNotice(ok ? '诊断信息已复制到剪贴板，可直接粘贴给技术支持。' : '复制失败，请到「设置与规则」页重试。');
}

/* ------------------------------------------------------------------ */
/* 渲染工具                                                           */
/* ------------------------------------------------------------------ */

/** @param {'on'|'off'|'warn'} kind */
function setDot(kind) {
  $('dot').className = `dot ${kind}`;
}

/**
 * 未监控 / 不可用时的空状态
 * @param {string} headState
 * @param {string} notice
 */
function setOff(headState, notice) {
  setDot('off');
  $('headState').textContent = headState;
  $('digits').textContent = '--:--';
  $('digits').classList.remove('paused');
  $('timerLabel').textContent = '未计时';
  $('mRule').textContent = '—';
  $('mRule').title = '';
  $('mMode').textContent = '—';
  $('mIdle').textContent = '—';
  $('btnPause').disabled = true;
  $('btnRefresh').disabled = true;
  setNotice(notice);
}

function setNotice(text) {
  const el = $('notice');
  el.textContent = text;
  el.hidden = false;
}

function hideNotice() {
  $('notice').hidden = true;
}

/**
 * @param {{type:string, payload?:any}} msg
 */
async function send(msg) {
  try {
    if (!chrome.runtime?.id) return null;
    return (await chrome.runtime.sendMessage(msg)) || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
