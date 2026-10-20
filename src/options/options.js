/**
 * options.js —— 设置页逻辑（ESM，可 import）
 *
 * 职责：规则的增删改启停、权限申请、全局默认值、诊断导出。
 * 关键约束（AR-PRC-003 S3）：
 *   `chrome.permissions.request` 必须紧贴用户点击手势调用，前面不能有 await，
 *   否则手势失效、授权框不弹，表现为"点保存没反应"。
 * 边界：真正的写入都走 rules-store / registrar，页面本身不直接操作 chrome.storage。
 */

import { MSG } from '../shared/messages.js';
import { normalizePattern, toOriginPattern } from '../shared/pattern.js';
import {
  addRule,
  updateRule,
  removeRule,
  listRules,
  getSettings,
  patchSettings,
  IDLE_MIN,
  IDLE_MAX,
  PROMPT_MIN,
  PROMPT_MAX,
} from '../background/rules-store.js';
import { unregisterRule, dropPermission } from '../background/registrar.js';

const $ = (id) => document.getElementById(id);

/** @type {Array<Record<string, any>>} */
let rules = [];
/** @type {Record<string, any> | null} */
let settings = null;
/** 正在编辑的规则 id；null 表示新增 */
let editingId = null;

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

init().catch((e) => showBanner(`设置页初始化失败：${e?.message || e}`));

async function init() {
  await refresh();
  bindEvents();
}

async function refresh() {
  [rules, settings] = await Promise.all([listRules(), getSettings()]);
  renderGlobal();
  renderRules();
}

/* ------------------------------------------------------------------ */
/* 渲染                                                               */
/* ------------------------------------------------------------------ */

function renderGlobal() {
  const s = settings;
  $('globalEnabled').checked = s.globalEnabled !== false;
  $('sIdle').value = String(s.defaultIdleMinutes);
  $('sMode').value = s.defaultMode === 'ping' ? 'ping' : 'reload';
  $('sPrompt').value = String(s.defaultPromptSeconds);
  $('sCountScroll').checked = !!s.countScrollAsActivity;
  $('sCountMouseMove').checked = !!s.countMouseMoveAsActivity;
  $('sNotifyBlocked').checked = s.notifyOnBlocked !== false;
  $('sDebug').checked = !!s.debug;

  const broken = rules.filter((r) => r.enabled && r.permissionGranted === false);
  if (broken.length) {
    showBanner(
      `有 ${broken.length} 条规则未获得网址访问权限，当前不会生效。点对应规则上的「重新授权」并在弹窗中选「允许」即可。`,
    );
  } else {
    hideBanner();
  }
}

function renderRules() {
  const list = $('ruleList');
  list.textContent = '';
  $('emptyState').hidden = rules.length > 0;

  for (const r of rules) {
    list.appendChild(renderRule(r));
  }
}

/**
 * @param {Record<string, any>} r
 * @returns {HTMLElement}
 */
function renderRule(r) {
  const wrap = document.createElement('div');
  wrap.className = `rule${r.enabled ? '' : ' off'}`;
  wrap.dataset.id = r.id;

  const main = document.createElement('div');
  main.className = 'rule-main';

  const title = document.createElement('div');
  title.className = 'rule-title';
  const name = document.createElement('span');
  name.className = 'rule-name';
  name.textContent = r.label || hostOf(r.pattern);
  title.appendChild(name);

  const pat = document.createElement('code');
  pat.className = 'rule-pattern';
  pat.textContent = r.pattern;

  const meta = document.createElement('div');
  meta.className = 'rule-meta';
  meta.appendChild(tag(`${r.idleMinutes} 分钟`, 'on'));
  meta.appendChild(tag(r.mode === 'ping' ? '仅保活' : '刷新页面'));
  if (r.promptSeconds > 0) meta.appendChild(tag(`提前 ${r.promptSeconds} 秒提示`));
  if (r.mode === 'reload' && r.keepScroll !== false) meta.appendChild(tag('恢复滚动位置'));
  meta.appendChild(tag(r.enabled ? '已启用' : '已停用', r.enabled ? 'on' : ''));
  if (r.permissionGranted === false) meta.appendChild(tag('需重新授权', 'warn'));

  main.append(title, pat, meta);
  wrap.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'rule-actions';
  actions.append(
    btn('编辑', 'edit'),
    btn(r.enabled ? '停用' : '启用', 'toggle'),
    r.permissionGranted === false ? btn('重新授权', 'reauth') : null,
    btn('删除', 'del', 'danger'),
  );
  wrap.appendChild(actions);

  return wrap;
}

/**
 * @param {string} text
 * @param {string} act
 * @param {string} [extraClass]
 */
function btn(text, act, extraClass) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn mini${extraClass ? ` ${extraClass}` : ''}`;
  b.dataset.act = act;
  b.textContent = text;
  return b;
}

/**
 * @param {string} text
 * @param {string} [cls] '' | 'on' | 'warn'
 */
function tag(text, cls) {
  const t = document.createElement('span');
  t.className = `tag${cls ? ` ${cls}` : ''}`;
  t.textContent = text;
  return t;
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function bindEvents() {
  $('globalEnabled').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    settings = await patchSettings({ globalEnabled: enabled });
    await send({ type: MSG.SW_SET_GLOBAL, payload: { enabled } });
    await refresh();
  });

  $('btnAdd').addEventListener('click', () => openForm(null));
  $('btnCancel').addEventListener('click', closeForm);
  $('ruleForm').addEventListener('submit', onFormSubmit);
  $('fPattern').addEventListener('input', updatePreview);

  $('ruleList').addEventListener('click', onRuleAction);

  $('btnSaveSettings').addEventListener('click', onSaveSettings);
  $('btnExport').addEventListener('click', onExport);
}

/**
 * 规则卡片上的操作（事件委托，避免为每个按钮单独绑定）
 * @param {MouseEvent} e
 */
async function onRuleAction(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const card = b.closest('.rule');
  const id = card?.dataset.id;
  const rule = rules.find((r) => r.id === id);
  if (!rule) return;

  const act = b.dataset.act;

  if (act === 'edit') {
    openForm(rule);
    return;
  }

  if (act === 'toggle') {
    try {
      await updateRule(rule.id, { enabled: !rule.enabled });
      await send({ type: MSG.RULES_CHANGED });
      await refresh();
    } catch (err) {
      showBanner(`操作失败：${err?.message || err}`);
    }
    return;
  }

  if (act === 'reauth') {
    // 必须是点击手势内的第一个异步调用：按域名申请，不能带路径
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [toOriginPattern(rule.pattern)] });
    } catch (err) {
      showBanner(`申请权限失败：${err?.message || err}`);
      return;
    }
    if (!granted) {
      showBanner('未获得该网址的访问权限，规则仍不会生效。请在弹窗中选「允许」后重试。');
      return;
    }
    await updateRule(rule.id, { permissionGranted: true });
    await send({ type: MSG.RULES_CHANGED });
    await refresh();
    return;
  }

  if (act === 'del') {
    const ok = window.confirm(
      `删除规则「${rule.label || hostOf(rule.pattern)}」？\n\n` +
        `删除后该页面不再自动刷新，同时会撤销对该网址的访问权限。此操作不可撤销。`,
    );
    if (!ok) return;
    try {
      // 顺序：先注销注入 → 再撤销权限 → 最后删数据，任一步失败都不至于留下"幽灵规则"
      await unregisterRule(rule.id);
      // 同一域名下可能还有别的规则，撤权限会把它们一起弄失效，必须先确认没有共用者
      if (!originSharedByOthers(rule.pattern, rule.id)) await dropPermission(rule.pattern);
      await removeRule(rule.id);
      await send({ type: MSG.RULES_CHANGED });
      await refresh();
    } catch (err) {
      showBanner(`删除失败：${err?.message || err}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 表单                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {Record<string, any> | null} rule
 */
function openForm(rule) {
  editingId = rule ? rule.id : null;
  $('formTitle').textContent = rule ? '编辑网址' : '添加网址';
  $('fPattern').value = rule ? rule.pattern : '';
  $('fLabel').value = rule ? rule.label || '' : '';
  $('fIdle').value = String(rule ? rule.idleMinutes : settings.defaultIdleMinutes);
  $('fMode').value = (rule ? rule.mode : settings.defaultMode) === 'ping' ? 'ping' : 'reload';
  $('fPrompt').value = String(rule ? rule.promptSeconds : settings.defaultPromptSeconds);
  $('fKeepScroll').checked = rule ? rule.keepScroll !== false : settings.defaultKeepScroll !== false;
  $('fPingFallback').checked = rule ? rule.allowPingFallback !== false : true;

  clearError();
  updatePreview();
  $('formCard').hidden = false;
  $('fPattern').focus();
  $('formCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeForm() {
  editingId = null;
  $('formCard').hidden = true;
  $('ruleForm').reset();
  clearError();
}

/** 实时把用户输入规范化并展示，减少"保存时报错"的挫败感 */
function updatePreview() {
  const el = $('fPreview');
  const raw = $('fPattern').value.trim();
  if (!raw) {
    el.hidden = true;
    return;
  }
  const n = normalizePattern(raw);
  el.hidden = false;
  if (!n.ok) {
    el.classList.add('bad');
    el.textContent = n.error;
    return;
  }
  el.classList.remove('bad');
  const extra = n.warnings.length ? `（${n.warnings[0]}）` : '';
  el.textContent = `将监控：${n.pattern}${extra}`;
}

/** @param {SubmitEvent} e */
async function onFormSubmit(e) {
  e.preventDefault();
  clearError();

  const patternRaw = $('fPattern').value.trim();
  const label = $('fLabel').value.trim();
  const idleMinutes = Number($('fIdle').value);
  const promptSeconds = Number($('fPrompt').value);
  const mode = $('fMode').value;
  const keepScroll = $('fKeepScroll').checked;
  const allowPingFallback = $('fPingFallback').checked;

  const norm = normalizePattern(patternRaw);
  if (!norm.ok) {
    showError(norm.error);
    $('fPattern').focus();
    return;
  }
  if (!Number.isFinite(idleMinutes) || idleMinutes < IDLE_MIN || idleMinutes > IDLE_MAX) {
    showError(`空闲分钟数需要是 ${IDLE_MIN}–${IDLE_MAX} 之间的整数。`);
    $('fIdle').focus();
    return;
  }
  if (!Number.isFinite(promptSeconds) || promptSeconds < PROMPT_MIN || promptSeconds > PROMPT_MAX) {
    showError(`提示时长需要是 ${PROMPT_MIN}–${PROMPT_MAX} 秒，0 表示直接刷新。`);
    $('fPrompt').focus();
    return;
  }

  // 权限申请必须紧贴手势：这之前不能有 await（规范 AR-PRC-003 S3）
  // 用域名级 pattern 申请：带路径的 pattern 在部分 Chrome 版本会直接抛错，
  // 一旦抛错用户就卡在授权环节且无法自救（host 权限本就是按域名授予的）
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [toOriginPattern(norm.pattern)] });
  } catch (err) {
    showError(`无法申请该网址的访问权限：${err?.message || err}。请检查网址格式后重试。`);
    return;
  }
  if (!granted) {
    showError('未获得该网址的访问权限，规则无法生效。请再点一次「保存」，并在弹窗中选「允许」。');
    return;
  }

  const payload = {
    pattern: norm.pattern,
    label,
    idleMinutes,
    mode,
    promptSeconds,
    keepScroll,
    allowPingFallback,
  };

  try {
    if (editingId) {
      const cur = rules.find((r) => r.id === editingId);
      if (cur && cur.pattern !== norm.pattern && !originSharedByOthers(cur.pattern, editingId)) {
        // 网址换了域名：旧域名的权限要撤，否则会留下一堆已授权却没人用的站点
        await dropPermission(cur.pattern);
      }
      await updateRule(editingId, { ...payload, permissionGranted: true });
    } else {
      const created = await addRule(payload);
      await updateRule(created.id, { permissionGranted: true });
    }

    const res = await send({ type: MSG.RULES_CHANGED });
    await refresh();

    if (res?.failed?.length) {
      showError(
        `规则已保存，但脚本没能注入该页面：${res.failed[0].message}。点规则上的「重新授权」再试一次。`,
      );
      return;
    }
    closeForm();
  } catch (err) {
    showError(err?.message || '保存失败，请重试。');
  }
}

async function onSaveSettings() {
  const idleMinutes = Number($('sIdle').value);
  const promptSeconds = Number($('sPrompt').value);
  if (!Number.isFinite(idleMinutes) || idleMinutes < IDLE_MIN || idleMinutes > IDLE_MAX) {
    showBanner(`默认空闲阈值需要是 ${IDLE_MIN}–${IDLE_MAX} 之间的整数。`);
    return;
  }
  if (!Number.isFinite(promptSeconds) || promptSeconds < PROMPT_MIN || promptSeconds > PROMPT_MAX) {
    showBanner(`默认提示时长需要是 ${PROMPT_MIN}–${PROMPT_MAX} 秒。`);
    return;
  }

  settings = await patchSettings({
    defaultIdleMinutes: idleMinutes,
    defaultMode: $('sMode').value === 'ping' ? 'ping' : 'reload',
    defaultPromptSeconds: promptSeconds,
    countScrollAsActivity: $('sCountScroll').checked,
    countMouseMoveAsActivity: $('sCountMouseMove').checked,
    notifyOnBlocked: $('sNotifyBlocked').checked,
    debug: $('sDebug').checked,
  });

  // 让已打开的页面立即按新设置重算，不必手动刷新（FR-01）
  await send({ type: MSG.RULES_CHANGED });
  hideBanner();

  const ok = $('settingsOk');
  ok.hidden = false;
  setTimeout(() => {
    ok.hidden = true;
  }, 2000);
}

/* ------------------------------------------------------------------ */
/* 诊断                                                               */
/* ------------------------------------------------------------------ */

async function onExport() {
  const res = await send({ type: MSG.SW_EXPORT_DIAG });
  if (!res || res.ok !== true) {
    showBanner('导出失败：后台服务未响应，请重载扩展后重试。');
    return;
  }
  const text = JSON.stringify(res.data, null, 2);
  const copied = await copyText(text);
  const ok = $('exportOk');
  ok.textContent = copied ? '已复制到剪贴板' : '复制失败，请重试';
  ok.hidden = false;
  setTimeout(() => {
    ok.hidden = true;
  }, 2400);
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
    // 回退：某些环境下 clipboard API 被策略禁用
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

/* ------------------------------------------------------------------ */
/* 小工具                                                             */
/* ------------------------------------------------------------------ */

/**
 * 给扩展页发消息，永不 reject。
 * @param {{type:string, payload?:any}} msg
 */
async function send(msg) {
  try {
    if (!chrome.runtime?.id) return null;
    const res = await chrome.runtime.sendMessage(msg);
    return res || null;
  } catch {
    // 静默：SW 正在冷启动或扩展刚被重载，用户重试即可
    return null;
  }
}

function showError(text) {
  const el = $('fError');
  el.textContent = text;
  el.hidden = false;
}

function clearError() {
  const el = $('fError');
  el.textContent = '';
  el.hidden = true;
}

function showBanner(text) {
  const el = $('banner');
  el.textContent = text;
  el.hidden = false;
}

function hideBanner() {
  $('banner').hidden = true;
}

/** @param {string} pattern */
function hostOf(pattern) {
  const m = /^[a-z*]+:\/\/([^/]+)/i.exec(String(pattern || ''));
  return m ? m[1].replace(/^\*\./, '') : '未命名规则';
}

/**
 * 该域名是否还被其它规则使用（决定要不要撤销 host 权限）。
 * @param {string} pattern 目标规则的 pattern
 * @param {string} excludeId 目标规则自己的 id
 * @returns {boolean}
 */
function originSharedByOthers(pattern, excludeId) {
  const origin = toOriginPattern(pattern);
  return rules.some((r) => r.id !== excludeId && toOriginPattern(r.pattern) === origin);
}
