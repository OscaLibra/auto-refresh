/**
 * background/rules-store.js —— 规则与设置的唯一写者（AR-TD-001 5.2 / 5.4）
 *
 * 职责：storage.local 中 `ar:rules` / `ar:settings` 的读写、校验、schema 迁移。
 * 为什么集中在这一层：规范"状态只有一个主人"——options 页只负责界面，真正的写入
 *   必须经过这里，才能保证串行（用户连点保存）、校验（非法值不进库）与迁移（幂等）。
 * 边界：不碰 content script、不碰动态注册（那是 registrar 的事）。
 */

import { K_RULES, K_SETTINGS, K_RULES_BACKUP } from '../shared/storage-keys.js';
import { normalizePattern } from '../shared/pattern.js';
import { badRequest } from '../shared/messages.js';

/** 当前 schema 版本；任何字段变更都要写 MIGRATIONS 并升版本 */
export const SCHEMA_VERSION = 1;

/** IDLE 阈值合法区间（分钟） */
export const IDLE_MIN = 1;
export const IDLE_MAX = 180;
/** 提示倒计时合法区间（秒），0 = 静默 */
export const PROMPT_MIN = 0;
export const PROMPT_MAX = 120;
/** 到点动作枚举，三处必须一致：此处 + content/40-executors.js + options 下拉框 */
export const MODES = Object.freeze(['reload', 'ping']);

/** 全局默认设置（AR-TD-001 5.4） */
export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
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

/**
 * 迁移表：key 为"目标版本"，函数必须是幂等的（重复执行结果一致）。
 * 规范 4.4：出错时不得清空用户数据，回退默认值并把原数据备份到 ar:rules:backup。
 */
const MIGRATIONS = {
  // 1 是初始版本，无需迁移
};

/* ------------------------------------------------------------------ */
/* 串行队列：options 页可能连续快速点击，保证写入顺序与最终状态一致      */
/* ------------------------------------------------------------------ */

let queue = Promise.resolve();

/**
 * 把一次写操作排进串行队列。
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function enqueue(fn) {
  const next = queue.then(fn, fn);
  // 无论成功失败都让队列继续流动，避免一次异常卡死后续所有写操作
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/* ------------------------------------------------------------------ */
/* 设置                                                               */
/* ------------------------------------------------------------------ */

/** @returns {Promise<typeof DEFAULT_SETTINGS>} 合并默认值后的设置 */
export async function getSettings() {
  const got = await chrome.storage.local.get(K_SETTINGS).catch(() => ({}));
  const raw = got?.[K_SETTINGS];
  const merged = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  merged.schemaVersion = SCHEMA_VERSION;
  return merged;
}

/**
 * 局部更新设置。
 * @param {Record<string, unknown>} patch
 */
export async function patchSettings(patch) {
  return enqueue(async () => {
    const cur = await getSettings();
    const next = sanitizeSettings({ ...cur, ...patch });
    await chrome.storage.local.set({ [K_SETTINGS]: next });
    return next;
  });
}

/**
 * 把任意输入夹到合法范围，防止 UI 绕过校验或旧数据脏值。
 * @param {Record<string, any>} s
 */
export function sanitizeSettings(s) {
  const clampInt = (v, min, max, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    globalEnabled: s.globalEnabled !== false,
    defaultIdleMinutes: clampInt(s.defaultIdleMinutes, IDLE_MIN, IDLE_MAX, 10),
    defaultMode: MODES.includes(s.defaultMode) ? s.defaultMode : 'reload',
    defaultPromptSeconds: clampInt(s.defaultPromptSeconds, PROMPT_MIN, PROMPT_MAX, 0),
    defaultKeepScroll: s.defaultKeepScroll !== false,
    wakeGraceMs: clampInt(s.wakeGraceMs, 0, 60000, 2000),
    minExecIntervalMs: clampInt(s.minExecIntervalMs, 1000, 600000, 30000),
    activityReportThrottleMs: clampInt(s.activityReportThrottleMs, 1000, 300000, 10000),
    countScrollAsActivity: s.countScrollAsActivity === true,
    notifyOnBlocked: s.notifyOnBlocked !== false,
    debug: s.debug === true,
  };
}

/* ------------------------------------------------------------------ */
/* 规则                                                               */
/* ------------------------------------------------------------------ */

/** @returns {Promise<Array<Record<string, any>>>} */
export async function listRules() {
  const got = await chrome.storage.local.get(K_RULES).catch(() => ({}));
  const raw = got?.[K_RULES];
  return Array.isArray(raw) ? raw.filter((r) => r && typeof r === 'object' && r.pattern) : [];
}

/**
 * 新增规则。
 * @param {{label?:string, pattern:string, idleMinutes?:number, mode?:string,
 *          promptSeconds?:number, keepScroll?:boolean, allowPingFallback?:boolean}} input
 */
export async function addRule(input) {
  return enqueue(async () => {
    const rule = buildRule(input);
    const rules = await listRules();
    if (rules.some((r) => r.pattern === rule.pattern)) {
      throw badRequest('duplicate-pattern', '这条网址规则已经存在，请直接编辑已有规则。');
    }
    const next = [...rules, rule];
    await chrome.storage.local.set({ [K_RULES]: next });
    return rule;
  });
}

/**
 * 局部更新规则。
 * @param {string} id
 * @param {Record<string, any>} patch
 */
export async function updateRule(id, patch) {
  return enqueue(async () => {
    const rules = await listRules();
    const idx = rules.findIndex((r) => r.id === id);
    if (idx < 0) throw badRequest('not-found', '规则不存在，可能已被删除。');

    const cur = rules[idx];
    const merged = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt };

    if (patch.pattern !== undefined && patch.pattern !== cur.pattern) {
      const norm = normalizePattern(patch.pattern);
      if (!norm.ok) throw badRequest('invalid-pattern', norm.error);
      merged.pattern = norm.pattern;
      if (rules.some((r) => r.id !== id && r.pattern === norm.pattern)) {
        throw badRequest('duplicate-pattern', '这条网址规则已经存在，请直接编辑已有规则。');
      }
    }
    if (patch.idleMinutes !== undefined) {
      merged.idleMinutes = clampInt(patch.idleMinutes, IDLE_MIN, IDLE_MAX, 10);
    }
    if (patch.promptSeconds !== undefined) {
      merged.promptSeconds = clampInt(patch.promptSeconds, PROMPT_MIN, PROMPT_MAX, 0);
    }
    if (patch.mode !== undefined) {
      if (!MODES.includes(patch.mode)) throw badRequest('invalid-mode', '不支持的动作类型。');
      merged.mode = patch.mode;
    }
    if (patch.label !== undefined) merged.label = String(patch.label).slice(0, 32) || merged.label;
    if (patch.enabled !== undefined) merged.enabled = !!patch.enabled;
    if (patch.keepScroll !== undefined) merged.keepScroll = !!patch.keepScroll;
    if (patch.allowPingFallback !== undefined) merged.allowPingFallback = !!patch.allowPingFallback;
    if (patch.permissionGranted !== undefined) merged.permissionGranted = !!patch.permissionGranted;
    merged.updatedAt = Date.now();

    const next = rules.slice();
    next[idx] = merged;
    await chrome.storage.local.set({ [K_RULES]: next });
    return merged;
  });
}

/**
 * 删除规则。
 * @param {string} id
 */
export async function removeRule(id) {
  return enqueue(async () => {
    const rules = await listRules();
    const next = rules.filter((r) => r.id !== id);
    await chrome.storage.local.set({ [K_RULES]: next });
    return { removed: rules.length - next.length, rules: next };
  });
}

/**
 * 由用户输入构造一条完整规则（补齐默认值、规范化 pattern）。
 * @param {Parameters<typeof addRule>[0]} input
 */
export function buildRule(input) {
  const norm = normalizePattern(input.pattern);
  if (!norm.ok) throw badRequest('invalid-pattern', norm.error);

  const label = String(input.label ?? '').trim().slice(0, 32) || hostOf(norm.pattern);
  const now = Date.now();

  return {
    id: `r_${randomHex(6)}`,
    label,
    pattern: norm.pattern,
    enabled: true,
    idleMinutes: clampInt(input.idleMinutes, IDLE_MIN, IDLE_MAX, 10),
    mode: MODES.includes(input.mode) ? input.mode : 'reload',
    promptSeconds: clampInt(input.promptSeconds, PROMPT_MIN, PROMPT_MAX, 0),
    keepScroll: input.keepScroll !== false,
    allowPingFallback: input.allowPingFallback !== false,
    permissionGranted: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** @param {string} pattern @returns {string} 取 host 作为默认名称 */
export function hostOf(pattern) {
  const m = /^[a-z*]+:\/\/([^/]+)/i.exec(pattern);
  return m ? m[1].replace(/^\*\./, '') : '未命名规则';
}

/* ------------------------------------------------------------------ */
/* 初始化与迁移                                                        */
/* ------------------------------------------------------------------ */

/**
 * 幂等初始化：补齐默认设置、执行迁移。
 * 迁移出错不清空数据：把原始规则备份到 ar:rules:backup，再回退默认值。
 */
export async function ensureInitialized() {
  const got = await chrome.storage.local.get([K_SETTINGS, K_RULES]).catch(() => ({}));
  let settings = { ...DEFAULT_SETTINGS, ...(got?.[K_SETTINGS] || {}) };

  try {
    settings = migrate(settings);
  } catch (e) {
    // 静默：迁移失败属于代码缺陷，用户数据必须保住，因此只备份并回退
    await chrome.storage.local.set({ [K_RULES_BACKUP]: got?.[K_RULES] ?? [] }).catch(() => {});
    settings = { ...DEFAULT_SETTINGS };
    console.error('[AR] migrate failed, fallback to defaults', e);
  }

  // 关键：只有真变化才落盘。SW 每 30 秒被巡检 alarm 唤醒一次、每次都会重跑到这里，
  // 无条件 set 会让所有页面收到 storage.onChanged → 触发 resync → 重置倒计时。
  // 这正是"最小化再打开，倒计时突然归满"的根源（CHANGELOG 1.0.2）。
  const next = sanitizeSettings(settings);
  const raw = got?.[K_SETTINGS];
  const rawNorm = raw && typeof raw === 'object' ? sanitizeSettings({ ...DEFAULT_SETTINGS, ...raw }) : null;
  if (!rawNorm || JSON.stringify(rawNorm) !== JSON.stringify(next)) {
    await chrome.storage.local.set({ [K_SETTINGS]: next }).catch(() => {});
  }

  const rules = got?.[K_RULES];
  if (!Array.isArray(rules)) {
    await chrome.storage.local.set({ [K_RULES]: [] }).catch(() => {});
  }
}

/**
 * 按版本链依次迁移。
 * @param {Record<string, any>} state
 */
export function migrate(state) {
  let s = { ...state };
  let v = Number(s.schemaVersion) || SCHEMA_VERSION;
  while (MIGRATIONS[v + 1]) {
    s = MIGRATIONS[v + 1](s);
    v += 1;
  }
  s.schemaVersion = SCHEMA_VERSION;
  return s;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                             */
/* ------------------------------------------------------------------ */

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

function randomHex(len) {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}
