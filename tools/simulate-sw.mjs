/**
 * tools/simulate-sw.mjs —— service worker 端集成测试（无需真浏览器）
 *
 * 为什么需要：SW 里最容易出的是"链路问题"——权限没读到、注册没生效、
 *   消息回包漏了、兜底巡检条件写反。这些用静态检查看不出来，只能跑。
 * 做法：用内存版 chrome.* 桩加载真实的 background 模块，按 AR-PRC-003 的关键用例
 *   逐条驱动。桩会刻意模仿真实 Chrome 的报错（如重复注册 id / 标签已关闭抛错），
 *   这样"以为没问题"的写法会在这里暴露。
 * 用法：node tools/simulate-sw.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(detail ? `${name} —— ${detail}` : name);
    console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/* ------------------------------------------------------------------ */
/* chrome.* 桩                                                        */
/* ------------------------------------------------------------------ */

function makeArea(map) {
  const pick = (key) => (map.has(key) ? map.get(key) : undefined);
  return {
    get: async (keys) => {
      const out = {};
      if (keys == null) {
        for (const [k, v] of map) out[k] = v;
        return out;
      }
      if (typeof keys === 'string') {
        const v = pick(keys);
        if (v !== undefined) out[keys] = v;
        return out;
      }
      if (Array.isArray(keys)) {
        for (const k of keys) {
          const v = pick(k);
          if (v !== undefined) out[k] = v;
        }
        return out;
      }
      // {key: default} 形式
      for (const k of Object.keys(keys)) {
        const v = pick(k);
        out[k] = v === undefined ? keys[k] : v;
      }
      return out;
    },
    set: async (obj) => {
      for (const [k, v] of Object.entries(obj)) map.set(k, v);
    },
    remove: async (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}

function makeChrome() {
  const local = new Map();
  const session = new Map();
  const tabs = new Map();
  const windows = new Map();
  const alarms = new Map();
  const scripts = [];
  const granted = new Set();
  const messages = [];
  const badges = [];
  const reloads = [];
  const diagLog = [];
  /** SW 顶层注册的事件监听器，供测试直接驱动 */
  const listeners = { tabsUpdated: [], tabsRemoved: [], alarm: [] };

  const chrome = {
    storage: { local: makeArea(local), session: makeArea(session) },
    runtime: {
      id: 'test-ext',
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      lastError: undefined,
    },
    scripting: {
      getRegisteredContentScripts: async () => scripts.map((s) => ({ ...s })),
      registerContentScripts: async (list) => {
        // host 权限按域名授予：granted 里存的是 `https://host/*`，需要判断是否覆盖注册用的精确路径
        const covered = (match) =>
          [...granted].some((g) => {
            const base = g.replace(/\/\*$/, '/');
            return match === g || match.startsWith(base);
          });
        for (const spec of list) {
          // 模仿真实行为：同 id 重复注册直接抛错
          if (scripts.some((s) => s.id === spec.id)) {
            throw new Error(`Duplicate script ID '${spec.id}'`);
          }
          if (!covered(spec.matches[0])) {
            throw new Error(`Cannot access contents of the page for '${spec.matches[0]}'`);
          }
          scripts.push({ ...spec });
        }
      },
      unregisterContentScripts: async ({ ids }) => {
        for (const id of ids) {
          const i = scripts.findIndex((s) => s.id === id);
          if (i < 0) throw new Error(`Nonexistent script ID '${id}'`);
          scripts.splice(i, 1);
        }
      },
    },
    permissions: {
      contains: async ({ origins }) => origins.every((o) => granted.has(o)),
      remove: async ({ origins }) => {
        for (const o of origins) granted.delete(o);
        return true;
      },
      onRemoved: { addListener: () => {} },
      onAdded: { addListener: () => {} },
    },
    alarms: {
      get: async (name) => (alarms.has(name) ? { name, ...alarms.get(name) } : undefined),
      create: async (name, info) => {
        if (alarms.has(name)) throw new Error('alarm already exists');
        alarms.set(name, info);
      },
      onAlarm: { addListener: () => {} },
    },
    tabs: {
      get: async (id) => {
        if (!tabs.has(id)) throw new Error('No tab with id: ' + id);
        return { id, ...tabs.get(id) };
      },
      query: async () => {
        const active = [...tabs.entries()].find(([, t]) => t.active);
        return active ? [{ id: active[0], ...active[1] }] : [];
      },
      reload: async (id) => {
        if (!tabs.has(id)) throw new Error('No tab with id: ' + id);
        reloads.push(id);
      },
      sendMessage: async (tabId, msg, opts) => {
        messages.push({ tabId, msg, frameId: opts && opts.frameId });
        if (!tabs.has(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { ok: true };
      },
      onRemoved: { addListener: (f) => listeners.tabsRemoved.push(f) },
      onUpdated: { addListener: (f) => listeners.tabsUpdated.push(f) },
      onReplaced: { addListener: () => {} },
      onActivated: { addListener: () => {} },
    },
    windows: {
      get: async (id) => windows.get(id) || { id, state: 'normal' },
    },
    action: {
      setBadgeText: async (o) => badges.push({ ...o }),
      setBadgeBackgroundColor: async () => {},
    },
    alarmsState: alarms,
  };

  return { chrome, local, session, tabs, windows, alarms, scripts, granted, messages, badges, reloads, diagLog, listeners };
}

/** 重置每个用例的存储与标签，但保留 chrome 对象（模块已持有引用） */
function reset(m) {
  m.local.clear();
  m.session.clear();
  m.tabs.clear();
  m.windows.clear();
  m.scripts.length = 0;
  m.granted.clear();
  m.messages.length = 0;
  m.badges.length = 0;
  m.reloads.length = 0;
}

/* ------------------------------------------------------------------ */
/* 加载真实模块                                                        */
/* ------------------------------------------------------------------ */

const m = makeChrome();
globalThis.chrome = m.chrome;

const rulesStore = await import('../src/background/rules-store.js');
const sessions = await import('../src/background/session-store.js');
const registrar = await import('../src/background/registrar.js');
const patrol = await import('../src/background/patrol.js');
const router = await import('../src/background/message-router.js');

/** @param {string} type @param {any} payload @param {any} sender */
async function call(type, payload, sender) {
  const handler = router.findHandler({ type, payload });
  if (!handler) throw new Error(`no handler for ${type}`);
  return handler({ type, payload }, sender || { tab: { id: 1 }, frameId: 0 });
}

/** 走 SW 的统一回包封装（与 service-worker.js 的 onMessage 等价） */
async function send(type, payload, sender) {
  try {
    const data = await call(type, payload, sender);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: { code: e.code || 'internal', message: e.message } };
  }
}

/* ------------------------------------------------------------------ */
/* 用例                                                               */
/* ------------------------------------------------------------------ */

async function t1Init() {
  console.log('\n[1] 初始化与迁移');
  reset(m);
  await rulesStore.ensureInitialized();
  const settings = await rulesStore.getSettings();
  ok('写入默认设置', settings.schemaVersion === 1 && settings.defaultIdleMinutes === 10);
  ok('规则表初始化为空数组', Array.isArray(m.local.get('ar:rules')));
  ok('未声明全局权限以外的东西', settings.globalEnabled === true);
}

async function t2RuleCrud() {
  console.log('\n[2] 规则增删改与校验');
  reset(m);
  await rulesStore.ensureInitialized();

  const r = await rulesStore.addRule({ pattern: 'oa.example.com/app', label: 'OA', idleMinutes: 1, mode: 'reload' });
  ok('自动补全为合法 match pattern', r.pattern === 'https://oa.example.com/app*', r.pattern);
  ok('id 形如 r_xxxxxx', /^r_[0-9a-f]{6}$/.test(r.id), r.id);
  ok('默认未授权', r.permissionGranted === false);

  let dup = null;
  try {
    await rulesStore.addRule({ pattern: 'https://oa.example.com/app*' });
  } catch (e) {
    dup = e;
  }
  ok('重复 pattern 被拒绝', dup && dup.code === 'duplicate-pattern');

  let bad = null;
  try {
    await rulesStore.addRule({ pattern: 'file:///c:/a.html' });
  } catch (e) {
    bad = e;
  }
  ok('非法 pattern 被拒绝', bad && bad.code === 'invalid-pattern');

  const upd = await rulesStore.updateRule(r.id, { idleMinutes: 999 });
  ok('阈值被夹到 180 上限', upd.idleMinutes === 180, String(upd.idleMinutes));

  const upd2 = await rulesStore.updateRule(r.id, { idleMinutes: 3, enabled: false });
  ok('停用生效', upd2.enabled === false && upd2.idleMinutes === 3);

  const { removed } = await rulesStore.removeRule(r.id);
  ok('删除生效', removed === 1 && (await rulesStore.listRules()).length === 0);
}

async function t3Register() {
  console.log('\n[3] 动态注册与幂等');
  reset(m);
  await rulesStore.ensureInitialized();

  const r = await rulesStore.addRule({ pattern: 'oa.example.com/app', idleMinutes: 1 });
  // 权限按域名授予（options 页也是这么申请的）
  const ORIGIN = 'https://oa.example.com/*';
  m.granted.add(ORIGIN);
  await rulesStore.updateRule(r.id, { permissionGranted: true });

  const res1 = await registrar.rebuild();
  ok('注册成功 1 条', res1.registered === 1 && res1.failed.length === 0, JSON.stringify(res1));
  ok('注册 id 带前缀', m.scripts[0]?.id === `ar-rule-${r.id}`);
  ok('allFrames 已开启', m.scripts[0]?.allFrames === true);
  ok('runAt 为 document_idle', m.scripts[0]?.runAt === 'document_idle');
  ok('持久化跨会话', m.scripts[0]?.persistAcrossSessions === true);
  ok('9 个 content 文件全部注入', m.scripts[0]?.js?.length === 9, String(m.scripts[0]?.js?.length));
  ok('99-main.js 是最后一个', String(m.scripts[0]?.js?.at(-1)).endsWith('99-main.js'));

  const res2 = await registrar.rebuild();
  ok('重复重建不重复注册（幂等）', res2.registered === 0 && m.scripts.length === 1, JSON.stringify(res2));

  // 撤销权限后重建：应注销并标记
  m.granted.delete(ORIGIN);
  await registrar.rebuild();
  const after = (await rulesStore.listRules())[0];
  ok('权限撤销后注销注册', m.scripts.length === 0);
  ok('权限撤销后标记 permissionGranted=false', after.permissionGranted === false);

  // 重新授权恢复
  m.granted.add(ORIGIN);
  await registrar.rebuild();
  ok('重新授权后自动恢复注册', m.scripts.length === 1 && (await rulesStore.listRules())[0].permissionGranted === true);
}

async function t4Hello() {
  console.log('\n[4] 会话登记与状态查询');
  reset(m);
  await rulesStore.ensureInitialized();
  const r = await rulesStore.addRule({ pattern: 'oa.example.com/app', idleMinutes: 2 });
  m.tabs.set(1, { active: true, status: 'complete', url: 'https://oa.example.com/app/list' });

  const res = await send('ar:content:hello', {
    url: 'https://oa.example.com/app/list?ticket=123',
    ruleId: r.id,
    idleMs: 120000,
    mode: 'reload',
  });
  ok('hello 返回 serverNow', res.ok && typeof res.data.serverNow === 'number');

  const s = await sessions.getSession(1);
  ok('会话按 tabId 落盘', s && s.tabId === 1 && s.ruleId === r.id);
  ok('URL 已脱敏（无 query）', s.url === 'https://oa.example.com/app/list', s.url);
  ok('初始未暂停', s.paused === false);

  const state = await send('ar:sw:getState', { tabId: 1 });
  ok('getState 返回规则与剩余时间', state.ok && state.data.rule.id === r.id && state.data.remainingMs <= 120000);
}

async function t5ActivityAndFrame() {
  console.log('\n[5] 活动上报与 iframe 转交');
  reset(m);
  await rulesStore.ensureInitialized();
  m.tabs.set(1, { active: true, status: 'complete' });

  await call('ar:content:hello', { url: 'https://oa.example.com/app/list', ruleId: 'r_1', idleMs: 60000, mode: 'reload' });

  const before = Date.now();
  await send('ar:content:activity', { lastActivityAt: before, visible: true }, { tab: { id: 1 }, frameId: 0 });
  let s = await sessions.getSession(1);
  ok('顶层活动更新时间戳', s.lastActivityAt === before);

  m.messages.length = 0;
  await send('ar:content:activity', { lastActivityAt: before + 5, visible: true }, { tab: { id: 1 }, frameId: 7 });
  s = await sessions.getSession(1);
  ok('子帧活动也归并到同一会话', s.lastActivityAt === before + 5);
  const fwd = m.messages.find((x) => x.msg.type === 'ar:tab:command');
  ok('子帧活动被转交给顶层帧', !!fwd && fwd.frameId === 0 && fwd.msg.payload.cmd === 'activity');
}

async function t6Pause() {
  console.log('\n[6] 暂停与恢复');
  reset(m);
  await rulesStore.ensureInitialized();
  m.tabs.set(1, { active: true, status: 'complete' });
  await call('ar:content:hello', { url: 'https://oa.example.com/app', ruleId: 'r_1', idleMs: 60000, mode: 'reload' });

  const res = await send('ar:sw:setPaused', { tabId: 1, paused: true });
  ok('暂停成功', res.ok === true);
  let s = await sessions.getSession(1);
  ok('会话标记为暂停', s.paused === true);
  ok('暂停指令已下发', m.messages.some((x) => x.msg.payload?.cmd === 'pause'));
  ok('角标显示暂停', m.badges.some((b) => b.text === '||'));

  await send('ar:sw:setPaused', { tabId: 1, paused: false });
  s = await sessions.getSession(1);
  ok('恢复后重新计时', s.paused === false && Date.now() - s.lastActivityAt < 500);

  const noSession = await send('ar:sw:setPaused', { tabId: 999, paused: true });
  ok('无会话时返回结构化错误', noSession.ok === false && noSession.error.code === 'no-session');
}

async function t7Patrol() {
  console.log('\n[7] 兜底巡检');
  reset(m);
  await rulesStore.ensureInitialized();
  m.tabs.set(1, { active: true, status: 'complete' });
  m.tabs.set(2, { active: false, status: 'loading' }); // 正在加载，不该被刷
  m.tabs.set(3, { active: false, status: 'complete', discarded: true }); // 被丢弃，需要救活

  const now = Date.now();
  await sessions.patchSession(1, { idleMs: 60000, lastActivityAt: now - 200000, lastExecAt: 0, mode: 'reload', paused: false });
  await sessions.patchSession(2, { idleMs: 60000, lastActivityAt: now - 200000, lastExecAt: 0, mode: 'reload', paused: false });
  await sessions.patchSession(3, { idleMs: 60000, lastActivityAt: now - 200000, lastExecAt: 0, mode: 'reload', paused: false });

  const res = await patrol.patrol();
  ok('超时标签被兜底刷新', m.reloads.includes(1));
  ok('加载中的标签跳过', !m.reloads.includes(2));
  ok('被 discard 的标签被救活', m.reloads.includes(3));
  ok('统计数量正确', res.reloaded === 2, JSON.stringify(res));

  const s1 = await sessions.getSession(1);
  ok('兜底后重置计时与防抖', s1.lastExecResult === 'patrol-reload' && s1.lastExecAt > 0);
  const diag = await sessions.getDiag();
  ok('写入 patrol-reload 诊断', diag.some((d) => d.event === 'patrol-reload'));

  // 宽限期内的会话不该被动（1.0.3 起 90 秒宽限只保"可见"标签）
  reset(m);
  m.tabs.set(4, { active: true, status: 'complete' });
  await sessions.patchSession(4, { idleMs: 60000, lastActivityAt: Date.now() - 70000, lastExecAt: 0, mode: 'reload' });
  await patrol.patrol();
  ok('可见标签阈值 + 90 秒宽限内不兜底（让 content 先执行）', !m.reloads.includes(4));

  // ping 模式且禁止降级：兜底不动
  reset(m);
  m.tabs.set(5, { active: false, status: 'complete' });
  await sessions.patchSession(5, {
    idleMs: 60000,
    lastActivityAt: Date.now() - 200000,
    lastExecAt: 0,
    mode: 'ping',
    allowPingFallback: false,
  });
  await patrol.patrol();
  ok('ping 模式禁止降级时不兜底刷新', !m.reloads.includes(5));

  // 标签已关闭：清理会话
  reset(m);
  await sessions.patchSession(6, { idleMs: 60000, lastActivityAt: Date.now() - 200000, lastExecAt: 0, mode: 'reload' });
  await patrol.patrol();
  ok('标签已关闭时清理会话', (await sessions.getSession(6)) === null);
}

async function t8AlarmAndGlobal() {
  console.log('\n[8] alarm 与全局开关');
  reset(m);
  await rulesStore.ensureInitialized();
  await patrol.ensureAlarm();
  const a = m.alarms.get('ar:patrol');
  ok('创建 30 秒周期 alarm', a && a.periodInMinutes === 0.5, JSON.stringify(a));

  await patrol.ensureAlarm();
  ok('重复创建不抛错（幂等）', m.alarms.size === 1);

  await send('ar:sw:setGlobal', { enabled: false });
  ok('全局开关落库', (await rulesStore.getSettings()).globalEnabled === false);

  m.tabs.set(1, { active: true, status: 'complete' });
  await sessions.patchSession(1, { idleMs: 60000, lastActivityAt: Date.now() - 200000, lastExecAt: 0, mode: 'reload' });
  await patrol.patrol();
  ok('全局关闭时不兜底刷新', m.reloads.length === 0);
}

async function t9RulesChanged() {
  console.log('\n[9] 规则变更触发重建');
  reset(m);
  await rulesStore.ensureInitialized();
  const r = await rulesStore.addRule({ pattern: 'oa.example.com', idleMinutes: 1 });
  m.granted.add('https://oa.example.com/*');
  await rulesStore.updateRule(r.id, { permissionGranted: true });

  const res = await send('ar:rules:changed', {});
  ok('重建返回注册数量', res.ok && res.data.registered === 1, JSON.stringify(res));
  ok('注册表已更新', m.scripts.length === 1);

  const second = await send('ar:rules:changed', {});
  ok('再次重建仍然只有 1 条', second.data.registered === 0 && m.scripts.length === 1);
}

async function t10Export() {
  console.log('\n[10] 诊断导出');
  reset(m);
  await rulesStore.ensureInitialized();
  await rulesStore.addRule({ pattern: 'oa.example.com/app', idleMinutes: 1 });
  m.tabs.set(1, { active: true, status: 'complete' });
  await call('ar:content:hello', { url: 'https://oa.example.com/app?token=secret', ruleId: 'r_1', idleMs: 60000, mode: 'reload' });

  const res = await send('ar:sw:exportDiag', {});
  const text = JSON.stringify(res.data);
  ok('导出成功', res.ok === true && !!res.data.settings && Array.isArray(res.data.rules));
  ok('导出不含 URL 的 query 参数', !text.includes('token=secret'), '发现敏感参数');
  ok('导出含诊断流水', Array.isArray(res.data.diag) && res.data.diag.length > 0);
}

/* ------------------------------------------------------------------ */
/* service worker 入口可直接加载                                        */
/* ------------------------------------------------------------------ */

async function t11ServiceWorkerLoads() {
  console.log('\n[11] service worker 入口');
  let loaded = true;
  try {
    await import('../src/background/service-worker.js');
  } catch (e) {
    loaded = false;
    console.error(e);
  }
  ok('service-worker.js 可加载且无语法/导入错误', loaded);
  await sleep(60);
  ok('引导后注册了 alarm', m.alarms.has('ar:patrol'));
}

async function t12TimelineGuard() {
  console.log('\n[12] 计时基准保护（1.0.2 回归：倒计时不得被非用户事件归满）');
  reset(m);
  await rulesStore.ensureInitialized();
  const r = await rulesStore.addRule({ pattern: 'oa.example.com/app', idleMinutes: 2 });
  m.granted.add('https://oa.example.com/*');
  await rulesStore.updateRule(r.id, { permissionGranted: true });
  m.tabs.set(1, { active: true, status: 'complete', url: 'https://oa.example.com/app/list' });

  // A. ensureInitialized 幂等：SW 每 30 秒被 alarm 唤醒都会重跑到这里，
  //    重复重写 settings 会触发全页面 storage.onChanged → resync 风暴
  const settingsBefore = m.local.get('ar:settings');
  await rulesStore.ensureInitialized();
  await rulesStore.ensureInitialized();
  ok('ensureInitialized 重复执行不重写 settings', m.local.get('ar:settings') === settingsBefore);

  // B. fresh hello（页面真正加载）：重开时间轴
  await call('ar:content:hello', {
    url: 'https://oa.example.com/app/list',
    ruleId: r.id,
    idleMs: 120000,
    mode: 'reload',
    fresh: true,
    lastActivityAt: Date.now() - 50000,
  });
  let s = await sessions.getSession(1);
  ok('fresh hello 以当前时间为基准', Date.now() - s.lastActivityAt < 1000, String(s.lastActivityAt));

  // C. 非 fresh hello（resync 元数据同步）：保留原时间轴，以 content 报的值为准
  const kept = Date.now() - 30000;
  await call('ar:content:hello', {
    url: 'https://oa.example.com/app/list',
    ruleId: r.id,
    idleMs: 120000,
    mode: 'reload',
    fresh: false,
    lastActivityAt: kept,
  });
  s = await sessions.getSession(1);
  ok('非 fresh hello 不重置计时', s.lastActivityAt === kept, `kept=${kept} got=${s.lastActivityAt}`);

  // D. 非 fresh 且未带时间戳：保留会话原值
  const kept2 = s.lastActivityAt;
  await call('ar:content:hello', { url: 'https://oa.example.com/app/list', ruleId: r.id, idleMs: 120000, mode: 'reload', fresh: false });
  s = await sessions.getSession(1);
  ok('非 fresh 且缺时间戳时保留原基准', s.lastActivityAt === kept2, String(s.lastActivityAt));

  // E. tabs.onUpdated URL 变化：不重置计时（曾有无条件 lastActivityAt: now 的写法）
  await import('../src/background/service-worker.js'); // 已在 t11 加载过，这里取缓存
  const onUpdated = m.listeners.tabsUpdated.at(-1);
  ok('SW 注册了 tabs.onUpdated 监听', typeof onUpdated === 'function');
  const kept3 = (await sessions.getSession(1)).lastActivityAt;
  await onUpdated(1, { url: 'https://oa.example.com/app/list2' }, { id: 1, active: true, status: 'complete' });
  await sleep(20);
  s = await sessions.getSession(1);
  ok('URL 变化不重置计时基准', !!s && s.lastActivityAt === kept3, `kept=${kept3} got=${s && s.lastActivityAt}`);
  ok('URL 变化只更新 url 字段', !!s && s.url === 'https://oa.example.com/app/list2', s && s.url);

  // F. URL 不再命中规则：清掉会话，防止巡检去刷不该刷的页面
  await onUpdated(1, { url: 'https://other.example.com/page' }, { id: 1, active: true, status: 'complete' });
  await sleep(20);
  ok('离开监控范围后会话被清理', (await sessions.getSession(1)) === null);

  // G. bye(rule-lost) 清会话；普通 pagehide 不清（可能是刷新，新页面马上会 hello）
  m.tabs.set(2, { active: true, status: 'complete' });
  await call('ar:content:hello', { url: 'https://oa.example.com/app', ruleId: r.id, idleMs: 120000, mode: 'reload', fresh: true }, { tab: { id: 2 }, frameId: 0 });
  await call('ar:content:bye', { reason: 'rule-lost' }, { tab: { id: 2 }, frameId: 0 });
  ok('rule-lost 告别清理会话', (await sessions.getSession(2)) === null);

  m.tabs.set(3, { active: true, status: 'complete' });
  await call('ar:content:hello', { url: 'https://oa.example.com/app', ruleId: r.id, idleMs: 120000, mode: 'reload', fresh: true }, { tab: { id: 3 }, frameId: 0 });
  await call('ar:content:bye', { reason: 'pagehide' }, { tab: { id: 3 }, frameId: 0 });
  ok('普通 pagehide 不清会话', (await sessions.getSession(3)) !== null);
}

async function t13ExecSyncsTimeline() {
  console.log('\n[13] 执行事件同步会话时间轴（1.0.2 回归）');
  reset(m);
  await rulesStore.ensureInitialized();
  m.tabs.set(1, { active: true, status: 'complete' });
  await call('ar:content:hello', { url: 'https://oa.example.com/app', ruleId: 'r_1', idleMs: 60000, mode: 'ping', fresh: true });

  // 把会话时间戳拨到"已过期"，模拟副本与判决方脱节
  const stale = Date.now() - 120000;
  await sessions.patchSession(1, { lastActivityAt: stale });

  await call('ar:content:exec', { event: 'ping-ok' });
  let s = await sessions.getSession(1);
  ok('ping-ok 后会话时间戳与 content 同步', Date.now() - s.lastActivityAt < 1000, String(s.lastActivityAt));
  ok('ping-ok 记入 lastExecAt 与计数', s.lastExecAt > 0 && s.pingOkCount === 1);

  await sessions.patchSession(1, { lastActivityAt: stale });
  await call('ar:content:exec', { event: 'reload-blocked' });
  s = await sessions.getSession(1);
  ok('reload-blocked 后会话时间戳与 content 同步', Date.now() - s.lastActivityAt < 1000, String(s.lastActivityAt));
  ok('reload-blocked 记入 blockedCount', s.blockedCount === 1);
}

async function t14HiddenEnforcement() {
  console.log('\n[14] 隐藏标签的到点执法（1.0.3 回归：最小化后到 0 也刷新）');
  // A. 窗口最小化 + 激活标签 + reload 模式：过隐藏宽限即由 SW 刷新
  reset(m);
  m.windows.set(10, { state: 'minimized' });
  m.tabs.set(7, { active: true, windowId: 10, status: 'complete' });
  await sessions.patchSession(7, { idleMs: 60000, lastActivityAt: Date.now() - 80000, lastExecAt: 0, mode: 'reload', paused: false });
  await patrol.patrol();
  ok('最小化窗口的标签到点即被 SW 刷新', m.reloads.includes(7), JSON.stringify(m.reloads));
  const s7 = await sessions.getSession(7);
  ok('隐藏执法后重置计时与结果标记', s7.lastExecResult === 'patrol-reload' && s7.lastExecAt > 0);
  const diag7 = await sessions.getDiag();
  ok('诊断流水带 hidden 标记', diag7.some((d) => d.event === 'patrol-reload' && d.detail.includes('hidden')));

  // B. 隐藏宽限（10 秒）未到：不刷，给降频的 content 留一轮 tick 机会
  reset(m);
  m.tabs.set(8, { active: false, status: 'complete' }); // 非激活 = 隐藏
  await sessions.patchSession(8, { idleMs: 60000, lastActivityAt: Date.now() - 65000, lastExecAt: 0, mode: 'reload', paused: false });
  await patrol.patrol();
  ok('隐藏宽限 10 秒内不兜底', !m.reloads.includes(8));

  // C. ping 模式即使隐藏也保持 90 秒宽限（保活只能在页面里发）
  reset(m);
  m.tabs.set(9, { active: false, status: 'complete' });
  await sessions.patchSession(9, { idleMs: 60000, lastActivityAt: Date.now() - 80000, lastExecAt: 0, mode: 'ping', allowPingFallback: true, paused: false });
  await patrol.patrol();
  ok('ping 模式隐藏时仍等 content（90 秒宽限）', !m.reloads.includes(9));

  // D. 可见标签保持 90 秒宽限（content 1 秒精度优先，防双刷）
  reset(m);
  m.windows.set(11, { state: 'normal' });
  m.tabs.set(12, { active: true, windowId: 11, status: 'complete' });
  await sessions.patchSession(12, { idleMs: 60000, lastActivityAt: Date.now() - 70000, lastExecAt: 0, mode: 'reload', paused: false });
  await patrol.patrol();
  ok('可见标签 90 秒宽限不变', !m.reloads.includes(12));

  // E. 渲染进程冻结（M132+ 的 tab.frozen）视同隐藏，即使标签是激活的
  reset(m);
  m.tabs.set(13, { active: true, status: 'complete', frozen: true });
  await sessions.patchSession(13, { idleMs: 60000, lastActivityAt: Date.now() - 80000, lastExecAt: 0, mode: 'reload', paused: false });
  await patrol.patrol();
  ok('冻结标签视同隐藏，到点即刷', m.reloads.includes(13));
}

try {
  await t1Init();
  await t2RuleCrud();
  await t3Register();
  await t4Hello();
  await t5ActivityAndFrame();
  await t6Pause();
  await t7Patrol();
  await t8AlarmAndGlobal();
  await t9RulesChanged();
  await t10Export();
  await t11ServiceWorkerLoads();
  await t12TimelineGuard();
  await t13ExecSyncsTimeline();
  await t14HiddenEnforcement();
} catch (e) {
  fails.push(`用例执行抛错：${e?.stack || e}`);
  console.error(e);
}

console.log('');
if (fails.length) {
  for (const f of fails) console.log(`  FAIL ${f}`);
  console.log(`\n${pass} 项通过，${fails.length} 项失败`);
  process.exit(1);
}
console.log(`全部 ${pass} 项通过`);
process.exit(0);
