/**
 * tools/simulate.mjs —— content 端运行时冒烟测试（无需真浏览器）
 *
 * 为什么需要它：content script 的绝大多数错误（拼错 API、依赖顺序错、comment 里误写
 * `*\/` 提前闭合块注释）在加载时才会暴露，而本地没有 Chrome 可加载。
 * 这里用一个极小的 DOM / chrome.* 桩把 9 个 content 文件按真实顺序跑起来，验证：
 *   · 装配不抛错、能进入 ready 状态
 *   · 空闲到点会调用 reload，且只调一次（防抖）
 *   · 提示模式下会插入 Shadow DOM 浮层，"稍后"能重置计时
 *   · ping 模式走 fetch 而不是 reload
 *   · 子帧只上报活动，绝不自己刷新
 *   · 未命中规则时零注入、零消息
 * 用法：node tools/simulate.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { CONTENT_JS } from '../src/background/content-manifest.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];

/** @param {string} name @param {boolean} cond @param {string} [detail] */
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
/* 最小 DOM 桩                                                        */
/* ------------------------------------------------------------------ */

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    childNodes: [],
    style: { cssText: '' },
    className: '',
    id: '',
    title: '',
    textContent: '',
    dataset: {},
    attrs: {},
    parentNode: null,
    isConnected: true,
    _l: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k];
    },
    appendChild(c) {
      c.parentNode = this;
      this.children.push(c);
      this.childNodes.push(c);
      return c;
    },
    append(...cs) {
      for (const c of cs) if (c) this.appendChild(c);
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      const j = this.childNodes.indexOf(c);
      if (j >= 0) this.childNodes.splice(j, 1);
      c.parentNode = null;
      return c;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    addEventListener(type, fn) {
      this._l[type] = fn;
    },
    removeEventListener(type) {
      delete this._l[type];
    },
    attachShadow() {
      const sh = makeElement('#shadow-root');
      this.shadowRoot = sh;
      return sh;
    },
    focus() {},
    scrollIntoView() {},
    click() {
      if (this._l.click) this._l.click({ target: this });
    },
    closest() {
      return null;
    },
    querySelector() {
      return null;
    },
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c);
      },
      remove(c) {
        this._set.delete(c);
      },
      toggle(c, on) {
        if (on === undefined) {
          if (this._set.has(c)) this._set.delete(c);
          else this._set.add(c);
        } else if (on) this._set.add(c);
        else this._set.delete(c);
      },
      contains(c) {
        return this._set.has(c);
      },
    },
  };
  return el;
}

/**
 * 构造一个 content 运行环境。
 * @param {{href?:string, isTop?:boolean, rules?:any[], settings?:any, fetchImpl?:Function}} opt
 */
function buildEnv(opt) {
  const o = {
    href: 'https://oa.example.com/app/list',
    isTop: true,
    rules: [],
    settings: {},
    ...opt,
  };

  const store = { 'ar:rules': o.rules, 'ar:settings': o.settings };
  /** @type {Array<any>} */
  const sent = [];
  /** @type {Array<any>} */
  const fetchCalls = [];
  let reloads = 0;
  /** @type {Function | null} */
  let msgListener = null;

  const docListeners = {};
  const storageListeners = [];
  const document = {
    documentElement: makeElement('html'),
    body: makeElement('body'),
    visibilityState: 'visible',
    createElement: (t) => makeElement(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    addEventListener: (t, fn) => {
      docListeners[t] = fn;
    },
    removeEventListener: (t) => {
      delete docListeners[t];
    },
    getElementById: () => null,
    querySelector: () => null,
  };

  const location = {
    href: o.href,
    origin: new URL(o.href).origin,
    pathname: new URL(o.href).pathname,
    reload: () => {
      reloads += 1;
    },
    assign: () => {},
  };

  const sessionMap = new Map();
  const sessionStorage = {
    getItem: (k) => (sessionMap.has(k) ? sessionMap.get(k) : null),
    setItem: (k, v) => sessionMap.set(k, String(v)),
    removeItem: (k) => sessionMap.delete(k),
  };

  const chromeStub = {
    runtime: {
      id: 'test-ext',
      sendMessage: (msg) => {
        sent.push(msg);
        return Promise.resolve({ ok: true, data: { serverNow: Date.now() } });
      },
      onMessage: {
        addListener: (fn) => {
          msgListener = fn;
        },
      },
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          const list = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (k in store) out[k] = store[k];
          return out;
        },
        set: async () => {},
      },
      onChanged: {
        addListener: (fn) => {
          storageListeners.push(fn);
        },
      },
    },
  };

  const fetchImpl =
    o.fetchImpl ||
    (async (url, init) => {
      fetchCalls.push({ url, init });
      return { ok: true, status: 200 };
    });

  const winListeners = {};
  const windowStub = {
    addEventListener: (t, fn) => {
      (winListeners[t] || (winListeners[t] = [])).push(fn);
    },
    removeEventListener: (t, fn) => {
      const arr = winListeners[t];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    /** 测试用：派发一个事件，模拟真实用户操作 */
    dispatch: (t) => {
      for (const fn of (winListeners[t] || []).slice()) fn({ type: t });
    },
    scrollY: 0,
    scrollTo: () => {},
    pageYOffset: 0,
  };
  windowStub.window = windowStub;
  windowStub.top = o.isTop ? windowStub : {};
  windowStub.document = document;
  windowStub.location = location;
  windowStub.chrome = chromeStub;
  windowStub.sessionStorage = sessionStorage;
  windowStub.fetch = fetchImpl;
  windowStub.console = console;
  windowStub.setTimeout = setTimeout;
  windowStub.clearTimeout = clearTimeout;
  windowStub.setInterval = setInterval;
  windowStub.clearInterval = clearInterval;
  windowStub.AbortController = AbortController;

  const sandbox = {
    window: windowStub,
    document,
    location,
    chrome: chromeStub,
    sessionStorage,
    fetch: fetchImpl,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    navigator: { userAgent: 'node-sim' },
    URL,
    JSON,
    Math,
    Date,
    Promise,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Error,
    RegExp,
    Map,
    Set,
  };

  return {
    sandbox,
    sent,
    fetchCalls,
    get reloads() {
      return reloads;
    },
    document,
    window: windowStub,
    /** 测试用：直接改 storage.local 的内容，模拟用户在设置页保存 */
    setStore: (rules, settings) => {
      if (rules) store['ar:rules'] = rules;
      if (settings) store['ar:settings'] = settings;
    },
    /** 测试用：模拟 SW 向 content 下发消息 */
    deliver: (msg) => {
      if (!msgListener) return;
      return msgListener(msg, {}, () => {});
    },
    /** 测试用：模拟最小化 / 切标签 / 恢复（触发 visibilitychange） */
    setVisibility: (state) => {
      document.visibilityState = state;
      const fn = docListeners.visibilitychange;
      if (fn) fn({ type: 'visibilitychange' });
    },
    /** 测试用：模拟 SW 侧 storage 写入触发 onChanged（如设置保存 / SW 唤醒初始化） */
    fireStorageChange: (area, keys) => {
      const changes = {};
      for (const k of keys) changes[k] = { oldValue: undefined, newValue: undefined };
      for (const fn of storageListeners.slice()) fn(changes, area);
    },
  };
}

/**
 * 按真实顺序加载全部 content 脚本。
 * @param {ReturnType<typeof buildEnv>} env
 */
function loadContent(env) {
  const ctx = vm.createContext(env.sandbox);
  for (const rel of CONTENT_JS) {
    const code = readFileSync(join(ROOT, rel), 'utf8');
    vm.runInContext(code, ctx, { filename: rel });
  }
  env.ctx = ctx;
  return ctx;
}

/** 顶层帧：拿到 AR 命名空间 */
function getAR(ctx) {
  const w = vm.runInContext('window', ctx);
  return w.AR || w.__AR__;
}

/* ------------------------------------------------------------------ */
/* 用例                                                               */
/* ------------------------------------------------------------------ */

const RULE_RELOAD = {
  id: 'r_abc123',
  label: 'OA 后台',
  pattern: 'https://oa.example.com/app/*',
  enabled: true,
  idleMinutes: 1,
  mode: 'reload',
  promptSeconds: 0,
  keepScroll: true,
  allowPingFallback: true,
  permissionGranted: true,
  createdAt: 1,
  updatedAt: 1,
};

const SETTINGS = {
  schemaVersion: 1,
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
};

async function caseReload() {
  console.log('\n[1] 顶层帧 · reload 模式到点刷新');
  const env = buildEnv({ rules: [RULE_RELOAD], settings: SETTINGS });
  loadContent(env);
  await sleep(30);
  const AR = getAR(env.ctx);

  ok('装配后进入 ready', AR.state.ready === true, `ready=${AR.state.ready}`);
  ok('命中规则', AR.state.rule?.id === 'r_abc123');
  ok('阈值换算为 60000ms', AR.state.idleMs === 60000, String(AR.state.idleMs));
  const bootHello = env.sent.find((m) => m.type === 'ar:content:hello');
  ok('已向 SW 登记会话', !!bootHello);
  ok('启动 hello 标记 fresh=true', !!bootHello && bootHello.payload.fresh === true);

  const st = AR.state;
  st.lastActivityAt = Date.now() - 61000;
  st.lastTickAt = Date.now();
  st.lastExecAt = 0;
  AR.judge.tick();
  await sleep(10);

  ok('到点触发了一次 reload', env.reloads === 1, `reloads=${env.reloads}`);
  ok('上报了 reload-start', env.sent.some((m) => m.type === 'ar:content:exec' && m.payload.event === 'reload-start'));

  // 防抖：紧接着再判决一次，不应重复刷新
  st.lastActivityAt = Date.now() - 61000;
  AR.judge.tick();
  await sleep(10);
  ok('30 秒内不重复刷新', env.reloads === 1, `reloads=${env.reloads}`);

  AR.judge.stop();
  return env;
}

async function caseActivityResets() {
  console.log('\n[2] 有操作时不刷新');
  const env = buildEnv({ rules: [RULE_RELOAD], settings: SETTINGS });
  loadContent(env);
  await sleep(30);
  const AR = getAR(env.ctx);
  const st = AR.state;

  st.lastActivityAt = Date.now() - 30000;
  // 走真实链路：派发 mousemove → 20-activity → onUserSignal → 判决重置 + 节流上报
  env.window.dispatch('mousemove');
  await sleep(10);
  AR.judge.tick();
  await sleep(10);
  ok('活动后 30 秒不刷新', env.reloads === 0, `reloads=${env.reloads}`);
  ok('活动被节流上报到了 SW', env.sent.some((m) => m.type === 'ar:content:activity'));

  AR.judge.stop();
}

async function casePrompt() {
  console.log('\n[3] 提示模式：浮层 + 稍后');
  const rule = { ...RULE_RELOAD, promptSeconds: 15 };
  const env = buildEnv({ rules: [rule], settings: SETTINGS });
  loadContent(env);
  await sleep(30);
  const AR = getAR(env.ctx);
  const st = AR.state;

  st.lastActivityAt = Date.now() - 50000; // 距到点还有 10 秒
  st.lastTickAt = Date.now();
  st.lastExecAt = 0;
  AR.judge.tick();
  await sleep(10);

  const host = env.document.documentElement.children[0];
  ok('浮层宿主已挂到 documentElement', !!host && host.id === 'ar-overlay-host');
  const card = host?.shadowRoot?.children?.find((c) => c.className === 'ar-card');
  ok('浮层含 role=status 卡片', !!card && card.attrs.role === 'status');
  ok('未到点不刷新', env.reloads === 0);

  // 点"稍后"：应重置计时并移除浮层
  const actions = card?.children?.[2];
  const btn = actions?.children?.[0];
  ok('浮层有"稍后"按钮', !!btn && btn.tagName === 'BUTTON');
  btn.click();
  await sleep(10);
  ok('点稍后后计时被重置', Date.now() - st.lastActivityAt < 1000);
  ok('点稍后后浮层被移除', !env.document.documentElement.children[0] || !st.promptShown);

  AR.judge.stop();
}

async function casePing() {
  console.log('\n[4] ping 模式：发请求而不是刷新');
  const rule = { ...RULE_RELOAD, mode: 'ping' };
  const env = buildEnv({ rules: [rule], settings: SETTINGS });
  loadContent(env);
  await sleep(30);
  const AR = getAR(env.ctx);
  const st = AR.state;

  st.lastActivityAt = Date.now() - 61000;
  st.lastTickAt = Date.now();
  st.lastExecAt = 0;
  AR.judge.tick();
  await sleep(50);

  ok('没有刷新页面', env.reloads === 0, `reloads=${env.reloads}`);
  ok('发出了同源 HEAD 请求', env.fetchCalls.length === 1 && env.fetchCalls[0].init.method === 'HEAD');
  ok('请求带 credentials', env.fetchCalls[0]?.init?.credentials === 'include');
  ok('保活成功后重置计时', Date.now() - st.lastActivityAt < 1000);
  ok('上报了 ping-ok', env.sent.some((m) => m.type === 'ar:content:exec' && m.payload.event === 'ping-ok'));

  AR.judge.stop();
}

async function caseChildFrame() {
  console.log('\n[5] 子帧：只上报活动，不判决不刷新');
  const env = buildEnv({ rules: [RULE_RELOAD], settings: SETTINGS, isTop: false });
  loadContent(env);
  await sleep(30);
  const AR = getAR(env.ctx);

  ok('子帧不计时', AR.state.ready === false && AR.state.tickTimer === 0);
  ok('子帧不登记 hello', !env.sent.some((m) => m.type === 'ar:content:hello'));
  ok('子帧未触发刷新', env.reloads === 0);
}

async function caseNoMatch() {
  console.log('\n[6] 未命中规则：零注入零消息');
  const env = buildEnv({ href: 'https://oa.example.com/home', rules: [RULE_RELOAD], settings: SETTINGS });
  loadContent(env);
  await sleep(30);
  const AR = getAR(env.ctx);

  ok('未命中不进入 ready', AR.state.ready === false);
  ok('未命中不发任何消息', env.sent.length === 0, JSON.stringify(env.sent.map((m) => m.type)));
  ok('未命中不起定时器', AR.state.tickTimer === 0);
}

async function caseGlobalOff() {
  console.log('\n[7] 全局开关关闭：不启动；打开后就地唤醒');
  const env = buildEnv({ rules: [RULE_RELOAD], settings: { ...SETTINGS, globalEnabled: false } });
  loadContent(env);
  await sleep(30);
  const AR = getAR(env.ctx);

  ok('全局关闭时不启动', AR.state.ready === false);
  ok('全局关闭不发消息', env.sent.length === 0);

  // 用户在设置页打开全局开关：SW 广播 + storage 变化 → content 就地 resync
  env.setStore(null, { ...SETTINGS, globalEnabled: true });
  env.deliver({ type: 'ar:tab:command', payload: { cmd: 'resync' } });
  await sleep(40);
  ok('打开开关后无需刷新页面即生效', AR.state.ready === true && AR.state.idleMs === 60000);
  ok('唤醒后向 SW 登记会话', env.sent.some((m) => m.type === 'ar:content:hello'));

  AR.judge.stop();
}

async function caseWakeGrace() {
  console.log('\n[8] 休眠唤醒宽限');
  const env = buildEnv({ rules: [RULE_RELOAD], settings: { ...SETTINGS, wakeGraceMs: 5000 } });
  loadContent(env);
  await sleep(30);
  const AR = getAR(env.ctx);
  const st = AR.state;

  st.lastActivityAt = Date.now() - 3 * 3600 * 1000; // 合盖 3 小时
  st.lastTickAt = Date.now() - 3 * 3600 * 1000; // 上一 tick 也在 3 小时前 → 判定为冻结
  st.lastExecAt = 0;
  AR.judge.tick();
  await sleep(10);
  ok('唤醒瞬间不刷新（宽限内）', env.reloads === 0, `reloads=${env.reloads}`);
  ok('已记录唤醒时间点', st.wakeAt > 0);

  // 宽限过后再判一次：应当刷新
  st.wakeAt = Date.now() - 6000;
  AR.judge.tick();
  await sleep(10);
  ok('宽限期结束后刷新', env.reloads === 1, `reloads=${env.reloads}`);

  AR.judge.stop();
}

async function caseVisibilityRestore() {
  console.log('\n[10] 最小化 / 恢复可见：不重置计时');
  const env = buildEnv({ rules: [RULE_RELOAD], settings: SETTINGS });
  loadContent(env);
  await sleep(30);
  const AR = getAR(env.ctx);
  const st = AR.state;

  // 阈值 1 分钟，已空闲 30 秒；此时最小化再打开
  st.lastActivityAt = Date.now() - 30 * 1000;
  const before = st.lastActivityAt;

  env.setVisibility('hidden');
  await sleep(10);
  env.setVisibility('visible');
  await sleep(10);

  ok('恢复可见不改写 lastActivityAt', st.lastActivityAt === before, `before=${before} after=${st.lastActivityAt}`);
  ok('空闲未到点时不刷新', env.reloads === 0);
  const remain = st.idleMs - (Date.now() - st.lastActivityAt);
  ok('剩余时间没有回到满值', remain < st.idleMs, `remain=${Math.round(remain / 1000)}s idleMs=${st.idleMs / 1000}s`);

  // 部分浏览器会在窗口重新获得焦点时补发焦点事件，这类"伪活动"不能重置计时
  env.window.dispatch('focusin');
  await sleep(10);
  ok('focusin 不再被当作活动', st.lastActivityAt === before, `after=${st.lastActivityAt}`);

  AR.judge.stop();
}

async function caseHiddenThrottled() {
  console.log('\n[11] 隐藏页面被降频时仍能自行执行');
  // 这是"最小化后永远不刷新、只能等巡检"的根因回归测试
  const env = buildEnv({ rules: [RULE_RELOAD], settings: { ...SETTINGS, wakeGraceMs: 5000 } });
  env.document.visibilityState = 'hidden';
  loadContent(env);
  await sleep(30);
  const AR = getAR(env.ctx);
  const st = AR.state;

  st.lastActivityAt = Date.now() - 11 * 60000; // 已超阈值
  st.lastTickAt = Date.now() - 60 * 1000; // 上一次 tick 在 60 秒前（降频到 1 次/分钟）
  st.lastExecAt = 0;

  AR.judge.tick();
  await sleep(20);
  ok('降频场景不会被唤醒宽限无限续期', env.reloads === 1, `reloads=${env.reloads}`);

  AR.judge.stop();
}

async function caseClockRollback() {
  console.log('\n[9] 系统时间回拨');
  const env = buildEnv({ rules: [RULE_RELOAD], settings: SETTINGS });
  loadContent(env);
  await sleep(30);
  const AR = getAR(env.ctx);
  const st = AR.state;

  st.lastActivityAt = Date.now() + 3600 * 1000; // 时间被回拨：活动时间在"未来"
  st.lastTickAt = Date.now();
  AR.judge.tick();
  await sleep(10);
  ok('回拨后不刷新', env.reloads === 0);
  ok('回拨后基准被重设', st.lastActivityAt <= Date.now() + 50);

  AR.judge.stop();
}

async function caseResyncKeepsTimeline() {
  console.log('\n[12] 配置原样的 resync：不重置计时（1.0.2 回归）');
  const env = buildEnv({ rules: [RULE_RELOAD], settings: SETTINGS });
  loadContent(env);
  await sleep(30);
  const AR = getAR(env.ctx);
  const st = AR.state;

  // 静置 30 秒后，模拟"SW 唤醒 / 无关设置写入"触发的 resync
  st.lastActivityAt = Date.now() - 30 * 1000;
  const before = st.lastActivityAt;

  env.setStore([RULE_RELOAD], { ...SETTINGS }); // 内容原样
  env.fireStorageChange('local', ['ar:settings']);
  await sleep(40);

  ok('resync 后仍在监控', st.ready === true);
  ok('配置原样的 resync 不重置计时', st.lastActivityAt === before, `before=${before} after=${st.lastActivityAt}`);
  const hello = [...env.sent].reverse().find((m) => m.type === 'ar:content:hello');
  ok('resync 的 hello 标记 fresh=false', !!hello && hello.payload.fresh === false);
  ok('resync 的 hello 携带当前计时基准', !!hello && hello.payload.lastActivityAt === before);

  // 阈值变化也不重置：旧基准对新阈值同样成立
  env.setStore([{ ...RULE_RELOAD, idleMinutes: 5 }], { ...SETTINGS });
  env.fireStorageChange('local', ['ar:rules']);
  await sleep(40);
  ok('阈值变化不重置时间轴', st.lastActivityAt === before, `after=${st.lastActivityAt}`);
  ok('新阈值已生效', st.idleMs === 300000, String(st.idleMs));

  // 停用规则：停表
  env.setStore([{ ...RULE_RELOAD, enabled: false }], { ...SETTINGS });
  env.fireStorageChange('local', ['ar:rules']);
  await sleep(40);
  ok('规则停用后停止计时', st.ready === false && st.tickTimer === 0);

  // 重新启用：这是真正的"从无到有"，从现在起算
  const tEnable = Date.now();
  env.setStore([{ ...RULE_RELOAD, enabled: true }], { ...SETTINGS });
  env.fireStorageChange('local', ['ar:rules']);
  await sleep(40);
  ok('重新启用后恢复计时', st.ready === true && st.tickTimer !== 0);
  ok('重新启用重置了计时基准', st.lastActivityAt >= tEnable, String(st.lastActivityAt));

  AR.judge.stop();
}

/* ------------------------------------------------------------------ */

try {
  await caseReload();
  await caseActivityResets();
  await casePrompt();
  await casePing();
  await caseChildFrame();
  await caseNoMatch();
  await caseGlobalOff();
  await caseWakeGrace();
  await caseClockRollback();
  await caseVisibilityRestore();
  await caseHiddenThrottled();
  await caseResyncKeepsTimeline();
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
