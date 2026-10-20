/**
 * background/message-router.js —— 消息分发（AR-TD-001 第 6 节 / 规范 3.4）
 *
 * 职责：校验入参 → 调用 store/service → 返回 data。不写业务逻辑、不直接操作 storage。
 * 为什么集中在这里：SW 的 onMessage 只能注册一次，所有方向的消息都在一个入口分流，
 *   这样"谁该回包、谁不回包"只有一处可查。
 * 约定：handler 一律返回 Promise<data>；抛错必须带 code（badRequest）。
 */

import { MSG, CMD, EVT, DIAG_EVENT, badRequest } from '../shared/messages.js';
import { safeUrl } from '../shared/pattern.js';
import {
  getSettings,
  patchSettings,
  listRules,
  sanitizeSettings,
} from './rules-store.js';
import {
  patchSession,
  getSession,
  listSessions,
  getDiag,
  pushDiag,
  clearSession,
  DIAG_LIMIT,
} from './session-store.js';
import { rebuild } from './registrar.js';
import { updateBadge } from './badge.js';

/**
 * @param {chrome.runtime.MessageSender} sender
 * @returns {number} 会话 key 用的 tabId；来自扩展页的消息没有 tab 则抛错
 */
function requireTabId(sender) {
  const id = sender?.tab?.id;
  if (typeof id !== 'number') throw badRequest('no-tab', '当前页面不是普通网页标签，无法操作。');
  return id;
}

/**
 * 向指定标签的顶层帧发指令。
 * @param {number} tabId
 * @param {{cmd:string, [k:string]:any}} payload
 */
async function sendCommand(tabId, payload) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.TAB_COMMAND, payload }, { frameId: 0 });
    return true;
  } catch {
    // 静默：页面没有注入（不匹配规则）或已卸载时必然失败
    return false;
  }
}

/**
 * 广播给所有标签的顶层帧。
 * @param {string} event
 */
async function broadcast(event) {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.all(
    tabs.map((t) =>
      typeof t.id === 'number'
        ? chrome.tabs
            .sendMessage(t.id, { type: MSG.SW_BROADCAST, payload: { event } }, { frameId: 0 })
            .catch(() => null)
        : null,
    ),
  );
}

/** @type {Record<string, (msg:any, sender:chrome.runtime.MessageSender)=>Promise<any>>} */
export const routes = {
  /* ---------------- content → SW ---------------- */

  /** content 启动时注册会话；SW 一律用 sender.tab.id 归一（规范 3.5） */
  [MSG.CONTENT_HELLO]: async (msg, sender) => {
    const tabId = requireTabId(sender);
    // 子帧不上报 hello：会话由顶层帧建立，子帧只贡献活动时间
    if (sender.frameId !== 0) return { ok: true };

    const p = msg.payload || {};
    const idleMs = Number(p.idleMs);
    if (!Number.isFinite(idleMs) || idleMs <= 0) {
      throw badRequest('invalid-payload', 'idleMs 必须是正数。');
    }

    const prev = await getSession(tabId);
    const now = Date.now();
    const sameRule = prev && prev.ruleId === p.ruleId;

    // 计时基准只允许两类来源，绝不能在这里写 `now` 了事：
    //  1) fresh（页面真正加载/刷新）→ 新时间轴，从现在起算；
    //  2) 非 fresh（resync 的元数据同步）→ content 是判决方，以它报来的
    //     lastActivityAt 为准。曾有无条件 `lastActivityAt: now` 的写法，
    //     导致 resync 风暴时倒计时被反复归满（CHANGELOG 1.0.2）。
    let lastActivityAt = now;
    if (!p.fresh) {
      const fromContent = Number(p.lastActivityAt);
      lastActivityAt =
        Number.isFinite(fromContent) && fromContent > 0
          ? Math.min(fromContent, now)
          : (prev?.lastActivityAt ?? now);
    }

    const session = await patchSession(tabId, {
      ruleId: p.ruleId || null,
      url: safeUrl(p.url || ''),
      idleMs,
      mode: p.mode === 'ping' ? 'ping' : 'reload',
      allowPingFallback: p.allowPingFallback !== false,
      lastActivityAt,
      // 暂停是"按标签"的意愿，规则不变时跨刷新保留；换规则则视为新会话
      paused: sameRule ? !!prev.paused : false,
      lastExecResult: sameRule ? prev.lastExecResult : undefined,
      reloadCount: sameRule ? prev.reloadCount || 0 : 0,
    });

    await pushDiag({
      event: DIAG_EVENT.REGISTERED,
      tabId,
      detail: `${p.ruleId} ${session.url}`,
    });
    await updateBadge(tabId);
    return { serverNow: now, session };
  },

  /** 活动上报（节流 10s）：SW 只更新不判决 */
  [MSG.CONTENT_ACTIVITY]: async (msg, sender) => {
    const tabId = requireTabId(sender);
    const p = msg.payload || {};
    const at = Number(p.lastActivityAt) || Date.now();
    await patchSession(tabId, { lastActivityAt: at, visible: p.visible !== false });

    // 关键：跨域 iframe 里的操作不会冒泡到顶层，必须由 SW 转交给负责计时的顶层帧，
    // 否则主操作区在 iframe 的后台系统会被误刷新（R-03 / TC-17）
    if (sender.frameId !== 0) {
      await sendCommand(tabId, { cmd: CMD.ACTIVITY, at });
    }
    return { ok: true };
  },

  /** 执行埋点 */
  [MSG.CONTENT_EXEC]: async (msg, sender) => {
    const tabId = requireTabId(sender);
    const p = msg.payload || {};
    const s = await getSession(tabId);
    const patch = { lastExecResult: String(p.result || p.event || 'ok') };

    if (p.event === DIAG_EVENT.RELOAD_START) {
      patch.lastExecAt = Date.now();
      patch.reloadCount = (s?.reloadCount || 0) + 1;
    } else if (p.event === DIAG_EVENT.RELOAD_BLOCKED) {
      // content 已重置自己的计时基准（beforeunload 拦截），会话副本必须跟上，
      // 否则弹窗 / 角标看到的还是"已过期"的旧基准，倒计时会卡在 00:00
      patch.lastExecAt = Date.now();
      patch.blockedCount = (s?.blockedCount || 0) + 1;
      patch.lastActivityAt = Date.now();
    } else if (p.event === DIAG_EVENT.PING_OK) {
      // 保活成功 = 服务端会话已续期，content 已重置计时；会话同步，弹窗才不会卡在 00:00
      patch.lastExecAt = Date.now();
      patch.pingOkCount = (s?.pingOkCount || 0) + 1;
      patch.lastActivityAt = Date.now();
    } else if (p.event === DIAG_EVENT.PING_FALLBACK) {
      patch.pingFailCount = (s?.pingFailCount || 0) + 1;
    }

    await patchSession(tabId, patch);
    await pushDiag({ event: String(p.event || 'exec'), tabId, detail: p.detail });
    await updateBadge(tabId);
    return { ok: true };
  },

  /**
   * 页面卸载前的告别。默认不清会话（可能是刷新，新页面还会 hello）；
   * 但 `rule-lost` 表示该页已确定不在监控范围（规则被删 / 改 / 停用），
   * 会话留着只会让兜底巡检去刷一个不该刷的页面，必须清。
   */
  [MSG.CONTENT_BYE]: async (msg, sender) => {
    const tabId = requireTabId(sender);
    const reason = String(msg?.payload?.reason || 'pagehide');
    if (reason === 'rule-lost') {
      await clearSession(tabId);
    }
    await pushDiag({ event: 'bye', tabId, detail: reason });
    return { ok: true };
  },

  /* ---------------- popup / options → SW ---------------- */

  [MSG.SW_GET_STATE]: async (msg) => {
    const tabId = Number(msg?.payload?.tabId);
    if (!Number.isFinite(tabId)) throw badRequest('invalid-payload', '缺少 tabId。');

    const [session, settings, rules] = await Promise.all([
      getSession(tabId),
      getSettings(),
      listRules(),
    ]);
    const rule = session?.ruleId ? rules.find((r) => r.id === session.ruleId) || null : null;
    const now = Date.now();
    const remainingMs = session
      ? Math.max(0, session.idleMs - (now - (session.lastActivityAt || now)))
      : null;

    return { serverNow: now, session, rule, settings, remainingMs };
  },

  [MSG.SW_REFRESH_NOW]: async (msg) => {
    const tabId = Number(msg?.payload?.tabId);
    if (!Number.isFinite(tabId)) throw badRequest('invalid-payload', '缺少 tabId。');
    const now = Date.now();
    try {
      await chrome.tabs.reload(tabId);
    } catch (e) {
      throw badRequest('reload-failed', `刷新失败：${e?.message || '标签可能已关闭'}`);
    }
    await patchSession(tabId, { lastActivityAt: now, lastExecAt: now, lastExecResult: 'manual' });
    await pushDiag({ event: 'manual-reload', tabId });
    return { ok: true };
  },

  [MSG.SW_SET_PAUSED]: async (msg) => {
    const tabId = Number(msg?.payload?.tabId);
    if (!Number.isFinite(tabId)) throw badRequest('invalid-payload', '缺少 tabId。');
    const paused = !!msg?.payload?.paused;

    const s = await getSession(tabId);
    if (!s) throw badRequest('no-session', '当前标签没有正在生效的规则。');

    await patchSession(tabId, {
      paused,
      // 恢复时重新计时，避免"暂停 3 小时后一恢复立刻刷"
      lastActivityAt: paused ? s.lastActivityAt : Date.now(),
    });
    await sendCommand(tabId, { cmd: paused ? CMD.PAUSE : CMD.RESUME });
    await pushDiag({ event: DIAG_EVENT.PAUSED, tabId, detail: paused ? 'paused' : 'resumed' });
    await updateBadge(tabId);
    return { ok: true, paused };
  },

  [MSG.SW_SET_GLOBAL]: async (msg) => {
    const enabled = !!msg?.payload?.enabled;
    const settings = await patchSettings({ globalEnabled: enabled });
    await broadcast(EVT.SETTINGS_CHANGED);
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    if (active?.id != null) await updateBadge(active.id);
    return { ok: true, settings: sanitizeSettings(settings) };
  },

  /** 导出诊断（仅用户手动触发）：不含 URL 的 query/hash，不含任何页面内容 */
  [MSG.SW_EXPORT_DIAG]: async () => {
    const [settings, rules, sessions, diag] = await Promise.all([
      getSettings(),
      listRules(),
      listSessions(),
      getDiag(),
    ]);
    return {
      schemaVersion: settings.schemaVersion,
      generatedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      settings,
      rules,
      sessions,
      diag,
      diagLimit: DIAG_LIMIT,
    };
  },

  /* ---------------- options → SW ---------------- */

  [MSG.RULES_CHANGED]: async () => {
    const res = await rebuild();
    await broadcast(EVT.RULES_CHANGED);
    return res;
  },
};

/**
 * 统一分发（由 service-worker.js 注册）。
 * @param {any} msg
 * @param {chrome.runtime.MessageSender} sender
 * @returns {((msg:any, sender:any)=>Promise<any>) | null}
 */
export function findHandler(msg) {
  if (!msg || typeof msg.type !== 'string') return null;
  return routes[msg.type] || null;
}
