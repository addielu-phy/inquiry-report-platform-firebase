// 探究與實作上台報告平台 — Firebase Realtime Database 版
// 學生頁只載入 Firebase（app / database / auth）；QR 與 Excel 套件只在老師端需要時才載入。
import { firebaseConfig, firebaseEmulator } from './firebase-config.js';

const FIREBASE_SDK_VERSION = '12.19.0'; // 修改版本時，index.html 的 modulepreload 網址也要一起改
const SDK_URL = (name) => `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-${name}.js`;
const QRIOUS_URL = 'https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js';
const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

const LS_KEY = 'inquiryPracticeReportPlatform.v2';
const STUDENT_ID_KEY = 'inquiryPracticeReportPlatform.studentIdentity.v1';
const SESSION_KEY = 'inquiryPracticeReportPlatform.firebaseSessionId.v1';
const ACTIVITIES_KEY = 'inquiryPracticeReportPlatform.activities.v1'; // 已儲存活動清單（跨週接續用）
const DEFAULT_GROUP_COUNT = 9;
const SUBMIT_TIMEOUT_MS = 8000;
const NET_TIMEOUT_MS = 25000; // 老師端單次讀寫的等待上限
const SDK_IMPORT_WAIT_MS = 20000; // 下載 SDK 每等這麼久更新一次提示（不放棄）
const SDK_IMPORT_MAX_WAITS = 4;
const AUTH_ATTEMPT_WAIT_MS = 35000; // Firebase Auth 自己約 30 秒（手機 60 秒）會回報網路錯誤
const AUTH_STATE_WAIT_MS = 10000;
const WS_WATCHDOG_MS = 7000; // 這麼久還沒連上資料庫 → 改用 long polling
const SLOW_HINT_MS = 45000; // 超過這個時間仍未連上，才提示可手動重新整理
const AUTO_RELOAD_KEY = 'inquiryPracticeReportPlatform.autoReload.v1';
const FATAL_CODES = new Set([
  'not-configured', 'auth/operation-not-allowed', 'auth/admin-restricted-operation', 'auth/configuration-not-found',
  'auth/api-key-not-valid', 'auth/invalid-api-key', 'auth/unauthorized-domain', 'auth/app-not-authorized',
  'auth/project-not-found', 'auth/invalid-app-id',
]);
const PHASE_LABEL = { setup: '設定中', report: '報告時間', question: '提問時間', rating: '評分／換場時間', done: '已完成' };
const DURATION = { rating: 180 }; // 評分／換場固定 3 分鐘
// 報告、提問時間可由老師調整（整數分鐘）
const MINUTES_RANGE = { report: { min: 3, max: 10, def: 5 }, question: { min: 1, max: 5, def: 3 } };
const normalizeMinutes = (kind, v) => {
  const r = MINUTES_RANGE[kind];
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? clamp(n, r.min, r.max) : r.def;
};
const normalizeDurations = (d = {}) => ({ reportMinutes: normalizeMinutes('report', d.reportMinutes), questionMinutes: normalizeMinutes('question', d.questionMinutes) });
const phaseSeconds = (phase) => (phase === 'report' ? state.durations.reportMinutes * 60 : phase === 'question' ? state.durations.questionMinutes * 60 : DURATION.rating);
const REPORT_CRITERIA = [
  { key: 'inquiryDesign', short: '問題與方法', label: '探究問題與方法設計', description: '問題意識、變因控制、方法合理性', avgId: 'reportInquiryAvg' },
  { key: 'evidenceAnalysis', short: '證據與分析', label: '資料證據與分析解釋', description: '數據品質、圖表呈現、證據支持結論', avgId: 'reportEvidenceAvg' },
  { key: 'communication', short: '表達與回應', label: '科學表達與回應能力', description: '結構清楚、時間掌握、回應提問', avgId: 'reportCommunicationAvg' },
];
// Firebase 路徑（key）不能包含這些字元
const FORBIDDEN_KEY_CHARS = /[.#$[\]/]/g;
const FULLWIDTH = { '.': '．', '#': '＃', '$': '＄', '[': '［', ']': '］', '/': '／' };

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isStudentMode = params.has('session');
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const safeText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const safeGroupName = (v) => safeText(v).replace(FORBIDDEN_KEY_CHARS, (ch) => FULLWIDTH[ch]).slice(0, 40);
const makeDefaultGroups = (count) => Array.from({ length: count }, (_, i) => `第${i + 1}組`);

// 盡早對資料庫主機做 DNS／TLS 預先連線（網址來自 firebase-config.js）
try {
  if (firebaseConfig?.databaseURL && !/YOUR_/.test(firebaseConfig.databaseURL)) {
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = new URL(firebaseConfig.databaseURL).origin;
    document.head.appendChild(link);
  }
} catch (_) { /* ignore */ }

let serverOffset = 0; // Firebase 伺服器時間 - 本機時間（毫秒），讓老師與學生手機的倒數一致
const serverNow = () => Date.now() + serverOffset;

let state = loadState();
let lastDoneKey = '';

// ---------------------------------------------------------------- 共用工具

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

class TimeoutError extends Error {
  constructor(message) { super(message); this.code = 'timeout'; }
}

function withTimeout(promise, ms, message = '逾時') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const scriptCache = new Map();
function loadScript(src) {
  if (!scriptCache.has(src)) {
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = () => { scriptCache.delete(src); reject(new Error(`無法載入 ${src}`)); };
      document.head.appendChild(s);
    });
    scriptCache.set(src, p);
  }
  return scriptCache.get(src);
}

function fbErrorText(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || err || '');
  if (code === 'not-configured') return msg;
  if (code === 'timeout') return msg || '連線逾時，請確認網路。';
  if (/PERMISSION_DENIED|permission[_-]denied/i.test(code + msg)) return '沒有權限（請確認 Firebase 安全性規則已貼上，且網址正確）。';
  if (code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation') return 'Firebase 尚未啟用「匿名登入」：請到 Authentication → 登入方式 開啟 Anonymous。';
  if (code === 'auth/configuration-not-found') return 'Firebase 專案尚未啟用 Authentication（請開啟匿名登入）。';
  if (code === 'auth/api-key-not-valid' || code === 'auth/invalid-api-key' || /api-key-not-valid/.test(msg)) return 'Firebase apiKey 錯誤：請檢查 src/firebase-config.js。';
  if (code === 'auth/unauthorized-domain') return '這個網域未被 Firebase 授權：請到 Authentication → 設定 → 授權網域 加入。';
  if (code === 'auth/network-request-failed') return '網路連線失敗（會自動重試）。';
  if (code === 'auth/too-many-requests') return '登入請求太頻繁，稍後會自動重試。';
  if (/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg)) return '無法下載 Firebase 程式庫（gstatic.com），請確認網路。';
  return msg || '未知錯誤';
}

function formatTime(value) {
  if (value === null || value === undefined || value === '') return '';
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('zh-TW', { hour12: false });
}

// ---------------------------------------------------------------- Firebase 初始化

function emulatorSettings() {
  if (firebaseEmulator) return firebaseEmulator;
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (isLocal && params.has('emulator')) return { host: '127.0.0.1', databasePort: 9000, authPort: 9099 };
  return null;
}

function isConfigured(cfg) {
  return Boolean(cfg && cfg.apiKey && cfg.databaseURL && !/YOUR_/.test(JSON.stringify(cfg)));
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const isFatalFirebaseError = (e) => FATAL_CODES.has(String(e?.code || '')) || /api-key-not-valid/.test(String(e?.message || ''));

// 連線進度回報（學生端顯示在狀態列，老師端顯示在 Session 狀態）
let onFirebaseProgress = () => {};
const reportProgress = (text) => { try { onFirebaseProgress(text); } catch (_) { /* ignore */ } };

// 瀏覽器會把「下載失敗的 ES module」記住，同一頁面重試 import 不會重新下載；
// 因此下載失敗時自動重新載入頁面（2 分鐘內最多 2 次），避免學生要自己按重新整理。
function tryAutoReload() {
  let rec = { count: 0, first: Date.now() };
  try { rec = JSON.parse(sessionStorage.getItem(AUTO_RELOAD_KEY) || 'null') || rec; } catch (_) { /* ignore */ }
  if (Date.now() - rec.first > 120000) rec = { count: 0, first: Date.now() };
  if (rec.count >= 2) return false;
  rec.count += 1;
  try { sessionStorage.setItem(AUTO_RELOAD_KEY, JSON.stringify(rec)); } catch (_) { return false; }
  setTimeout(() => location.reload(), 600);
  return true;
}

async function importFirebaseSdk() {
  // 與 index.html 的 <link rel="modulepreload"> 是同一組網址，會直接使用已預先下載的檔案
  const pending = Promise.all([import(SDK_URL('app')), import(SDK_URL('database')), import(SDK_URL('auth'))]);
  for (let wait = 1; ; wait++) {
    try {
      return await withTimeout(pending, SDK_IMPORT_WAIT_MS, 'sdk-timeout');
    } catch (e) {
      if (e.code === 'timeout' && wait < SDK_IMPORT_MAX_WAITS) { reportProgress(`下載程式庫較慢，仍在等待…（已等 ${Math.round((wait * SDK_IMPORT_WAIT_MS) / 1000)} 秒）`); continue; }
      if (tryAutoReload()) { reportProgress('程式庫下載失敗，自動重新載入頁面…'); await new Promise(() => {}); }
      const err = new Error('無法下載 Firebase 程式庫（www.gstatic.com），請確認網路後重新整理。');
      err.code = 'sdk-load-failed';
      throw err;
    }
  }
}

let fbCorePromise = null;
let fbCore = null;
async function getFirebaseCore() {
  if (fbCore) return fbCore;
  if (!fbCorePromise) {
    fbCorePromise = (async () => {
      const emu = emulatorSettings();
      let cfg = firebaseConfig;
      if (emu) { // Emulator 一律用 demo 專案，避免誤連正式資料庫
        cfg = { apiKey: 'demo-api-key', authDomain: 'demo-ipr.firebaseapp.com', projectId: 'demo-ipr', databaseURL: `http://${emu.host}:${emu.databasePort}?ns=demo-ipr-default-rtdb` };
      }
      if (!isConfigured(cfg)) {
        const e = new Error('尚未設定 Firebase：請依 README 編輯 src/firebase-config.js。');
        e.code = 'not-configured';
        throw e;
      }
      reportProgress('下載程式庫中…');
      const [appMod, dbMod, authMod] = await importFirebaseSdk();
      const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(cfg);
      const db = dbMod.getDatabase(app);
      const auth = authMod.getAuth(app);
      if (emu) {
        dbMod.connectDatabaseEmulator(db, emu.host, emu.databasePort);
        authMod.connectAuthEmulator(auth, `http://${emu.host}:${emu.authPort}`, { disableWarnings: true });
      }
      fbCore = { app, db, auth, authMod, ...dbMod, uid: null, connected: false, everConnected: false, longPolling: false, signInPromise: null };
      // 立刻開始連資料庫（與匿名登入同時進行，不互相等待）
      dbMod.onValue(dbMod.ref(db, '.info/serverTimeOffset'), (snap) => { serverOffset = Number(snap.val()) || 0; });
      dbMod.onValue(dbMod.ref(db, '.info/connected'), (snap) => {
        fbCore.connected = snap.val() === true;
        if (fbCore.connected) fbCore.everConnected = true;
      });
      startConnectionWatchdog(fbCore);
      return fbCore;
    })();
    fbCorePromise.catch(() => { fbCorePromise = null; });
  }
  return fbCorePromise;
}

// Realtime Database SDK 預設只用 WebSocket，若 WebSocket 卡住（不回應也不斷線），
// SDK 要等 30 秒才會放棄並改用 long polling。這裡 7 秒沒連上就主動切換。
function startConnectionWatchdog(core) {
  const timer = setInterval(() => {
    if (core.everConnected || core.longPolling) { clearInterval(timer); return; }
    if (!navigator.onLine) return;
    core.longPolling = true;
    clearInterval(timer);
    console.warn(`Realtime Database ${WS_WATCHDOG_MS / 1000} 秒內未連上，改用 long polling`);
    reportProgress('改用相容模式連線中…');
    try {
      core.goOffline(core.db);
      core.forceLongPolling();
      core.goOnline(core.db);
    } catch (e) { console.warn(e); }
  }, WS_WATCHDOG_MS);
}

// 匿名登入：自動重試（指數退避），只有設定錯誤才會放棄
async function signInWithRetry(core) {
  reportProgress('登入中…');
  try { await withTimeout(core.auth.authStateReady(), AUTH_STATE_WAIT_MS, 'auth-state'); } catch (_) { /* 繼續嘗試登入 */ }
  let attempt = 0;
  let delay = 1000;
  let pending = null;
  while (!core.auth.currentUser) {
    attempt += 1;
    if (attempt > 1) reportProgress(`登入中…（第 ${attempt} 次嘗試）`);
    // 上一次請求還沒結束就繼續等它，不重複送出（避免產生多個匿名帳號）
    if (!pending) pending = core.authMod.signInAnonymously(core.auth).finally(() => { pending = null; });
    try {
      await withTimeout(pending, AUTH_ATTEMPT_WAIT_MS, 'auth-timeout');
    } catch (e) {
      if (core.auth.currentUser) break;
      if (isFatalFirebaseError(e)) throw e;
      if (e.code === 'timeout') { reportProgress('登入較慢，仍在等待回應…'); continue; }
      console.warn('signInAnonymously 失敗，稍後重試', e);
      reportProgress(`登入暫時失敗（網路不穩），${Math.round(delay / 1000)} 秒後自動重試…（第 ${attempt} 次）`);
      await sleep(delay);
      delay = Math.min(delay * 2, 15000);
    }
  }
  core.uid = core.auth.currentUser.uid;
  return core;
}

// 取得 Firebase 並以匿名身分登入（同一瀏覽器重新整理後 uid 不變）
async function initFirebase() {
  const core = await getFirebaseCore();
  if (core.uid) return core;
  if (!core.signInPromise) core.signInPromise = signInWithRetry(core).finally(() => { core.signInPromise = null; });
  return core.signInPromise;
}

const dbRef = (core, path) => core.ref(core.db, path);

// ---------------------------------------------------------------- 狀態與計分邏輯（與舊版相同）

function defaultState() {
  const groups = makeDefaultGroups(DEFAULT_GROUP_COUNT);
  const [reportOrder, questionOrder] = makeDerangedOrders(groups);
  return {
    schemaVersion: 3,
    title: '探究與實作上台報告',
    groups,
    reportOrder,
    questionOrder,
    currentIndex: 0,
    phase: 'setup',
    timer: { running: false, phase: 'setup', duration: 0, startedAt: null, endsAt: null },
    durations: normalizeDurations(),
    exclusion: { presented: [], asked: [], manual: false },
    scores: {},
    updatedAt: new Date().toISOString(),
  };
}

function loadState() {
  const base = defaultState();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return base;
    return normalizeLoadedState(JSON.parse(raw), base);
  } catch (_) {
    return base;
  }
}

function normalizeLoadedState(parsed, base = defaultState()) {
  const groups = Array.isArray(parsed.groups) && parsed.groups.length >= 2 ? parsed.groups.map(safeGroupName).filter(Boolean) : base.groups;
  let reportOrder = Array.isArray(parsed.reportOrder) ? parsed.reportOrder.map(safeGroupName).filter(Boolean) : [];
  let questionOrder = Array.isArray(parsed.questionOrder) ? parsed.questionOrder.map(safeGroupName).filter(Boolean) : [];
  const orderLooksValid = reportOrder.length === groups.length && questionOrder.length === groups.length && groups.every((g) => reportOrder.includes(g) && questionOrder.includes(g));
  if (!orderLooksValid) [reportOrder, questionOrder] = makeDerangedOrders(groups);
  return {
    ...base,
    ...parsed,
    schemaVersion: 3,
    groups,
    reportOrder,
    questionOrder,
    currentIndex: clamp(Number(parsed.currentIndex || 0), 0, Math.max(0, groups.length - 1)),
    timer: parsed.timer || base.timer,
    durations: normalizeDurations(parsed.durations),
    exclusion: normalizeExclusion(parsed.exclusion, groups),
    scores: normalizeScoresTree(parsed.scores),
  };
}

function toList(v) { return Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []; }
function normalizeExclusion(ex, groups) {
  const gs = new Set(groups || []);
  return {
    presented: toList(ex?.presented).map(safeGroupName).filter((g) => gs.has(g)),
    asked: toList(ex?.asked).map(safeGroupName).filter((g) => gs.has(g)),
    manual: Boolean(ex?.manual),
    basePresented: toList(ex?.basePresented).map(safeGroupName).filter((g) => gs.has(g)),
    baseAsked: toList(ex?.baseAsked).map(safeGroupName).filter((g) => gs.has(g)),
  };
}

// Realtime Database 遇到 0,1,2… 這種數字 key 時會回傳陣列；統一轉成物件
function normalizeScoresTree(val) {
  const out = {};
  if (!val || typeof val !== 'object') return out;
  for (const [round, records] of Object.entries(val)) {
    if (records && typeof records === 'object') out[round] = { ...records };
  }
  return out;
}

function saveLocal() {
  state.updatedAt = new Date().toISOString();
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { console.warn(e); }
  recordActivity();
}

// 老師端每次改動：存到 localStorage（備份）並同步公開狀態到 Firebase
function saveState() {
  saveLocal();
  pushPublicState();
}

function parseGroups(raw) {
  const seen = new Set();
  return String(raw || '')
    .split(/[\n,，、;；]+/)
    .map(safeGroupName)
    .filter(Boolean)
    .filter((g) => (seen.has(g) ? false : (seen.add(g), true)));
}

function randomShuffle(arr) {
  const out = arr.slice();
  const bytes = new Uint32Array(out.length || 1);
  crypto.getRandomValues(bytes);
  for (let i = out.length - 1; i > 0; i--) {
    const j = bytes[i] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function makeDerangedOrders(groups) {
  const report = randomShuffle(groups);
  if (groups.length < 2) return [report, report.slice()];
  for (let i = 0; i < 500; i++) {
    const question = randomShuffle(groups);
    if (question.every((g, idx) => g !== report[idx])) return [report, question];
  }
  return [report, report.slice(1).concat(report[0])];
}

function currentRound(s = state) {
  const total = Math.min(s?.reportOrder?.length || 0, s?.questionOrder?.length || 0);
  if (!total) return { index: 0, roundNo: 0, total: 0, reportGroup: null, questionGroup: null };
  const index = clamp(Number(s.currentIndex || 0), 0, total - 1);
  return { index, roundNo: index + 1, total, reportGroup: s.reportOrder[index], questionGroup: s.questionOrder[index] };
}

function timerView(s = state) {
  const t = s?.timer || {};
  let remaining = Number(t.duration || 0);
  let done = false;
  if (t.running && t.endsAt) {
    remaining = Math.max(0, Math.ceil((Number(t.endsAt) - serverNow()) / 1000));
    done = remaining <= 0;
  }
  return { ...t, remaining, done, label: PHASE_LABEL[t.phase || s?.phase] || '設定中' };
}

function expectedScorers(roundIndex, s = state) {
  const report = s.reportOrder?.[roundIndex];
  const question = s.questionOrder?.[roundIndex];
  return (s.groups || []).filter((g) => g !== report && g !== question);
}

function validScore(value) {
  const n = Number(value);
  return value !== null && value !== '' && Number.isFinite(n) && n >= 1 && n <= 10;
}

function avg(values) {
  const nums = values.filter((v) => v !== null && v !== undefined && v !== '').map(Number).filter(Number.isFinite);
  return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null;
}

function scoreText(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function normalizeScoreRecord(entryKey, record = {}) {
  const keyParts = String(entryKey).split('::');
  const scorerGroup = safeGroupName(record.scorerGroup) || safeGroupName(keyParts[0]);
  const seatNo = safeText(record.seatNo) || safeText(keyParts[1]);
  const reportScores = {};
  for (const criterion of REPORT_CRITERIA) {
    const raw = record.reportScores?.[criterion.key];
    if (validScore(raw)) reportScores[criterion.key] = Number(raw);
    else if (validScore(record.reportScore)) reportScores[criterion.key] = Number(record.reportScore);
  }
  return {
    ...record,
    scorerGroup,
    seatNo,
    reportScores,
    reportScore: avg(REPORT_CRITERIA.map((c) => reportScores[c.key])),
    questionScore: validScore(record.questionScore) ? Number(record.questionScore) : null,
  };
}

// 只計入「有效組別、且不是本輪報告組／提問組」的評分
function roundRecords(roundIndex, s = state) {
  const excluded = new Set([s.reportOrder?.[roundIndex], s.questionOrder?.[roundIndex]]);
  const groups = new Set(s.groups || []);
  return Object.entries(s.scores?.[roundIndex] || {})
    .filter(([, record]) => record && typeof record === 'object')
    .map(([entryKey, record]) => normalizeScoreRecord(entryKey, record))
    .filter((r) => groups.has(r.scorerGroup) && !excluded.has(r.scorerGroup));
}

function roundStats(roundIndex, s = state) {
  const records = roundRecords(roundIndex, s);
  const submittedGroups = new Set(records.map((r) => r.scorerGroup).filter(Boolean));
  const missing = expectedScorers(roundIndex, s).filter((g) => !submittedGroups.has(g));
  const criteriaAvgs = {};
  for (const criterion of REPORT_CRITERIA) criteriaAvgs[criterion.key] = avg(records.map((r) => r.reportScores?.[criterion.key]));
  return {
    roundNo: roundIndex + 1,
    reportGroup: s.reportOrder?.[roundIndex] || '',
    questionGroup: s.questionOrder?.[roundIndex] || '',
    reportAvg: avg(records.map((r) => r.reportScore)),
    reportCriteriaAvgs: criteriaAvgs,
    questionAvg: avg(records.map((r) => r.questionScore)),
    responseCount: records.length,
    submittedGroupCount: submittedGroups.size,
    expectedCount: expectedScorers(roundIndex, s).length,
    missingGroups: missing,
  };
}

// 寫到 Firebase 的公開狀態（學生讀這份）。不可含 undefined。
function publicState() {
  const cr = currentRound(state);
  const t = state.timer || {};
  const groupSet = {};
  for (const g of state.groups) groupSet[g] = true;
  return {
    title: state.title || '探究與實作上台報告',
    groups: state.groups,
    groupSet,
    reportOrder: state.reportOrder,
    questionOrder: state.questionOrder,
    currentIndex: cr.index,
    currentRoundKey: String(cr.index),
    phase: state.phase || 'setup',
    timer: {
      running: Boolean(t.running),
      phase: t.phase || state.phase || 'setup',
      duration: Number(t.duration || 0),
      startedAt: Number.isFinite(Number(t.startedAt)) && t.startedAt !== null ? Number(t.startedAt) : null,
      endsAt: Number.isFinite(Number(t.endsAt)) && t.endsAt !== null ? Number(t.endsAt) : null,
    },
    durations: normalizeDurations(state.durations),
    exclusion: { presented: state.exclusion?.presented || [], asked: state.exclusion?.asked || [], manual: Boolean(state.exclusion?.manual), basePresented: state.exclusion?.basePresented || [], baseAsked: state.exclusion?.baseAsked || [] },
    updatedAt: new Date().toISOString(),
  };
}

// 轉成符合安全性規則的評分紀錄（匯入／上傳本機資料用）
function toRemoteScoresTree(scores, s = state) {
  const tree = {};
  const total = Math.min(s.reportOrder.length, s.questionOrder.length);
  for (const [roundKey, records] of Object.entries(normalizeScoresTree(scores))) {
    const idx = Number(roundKey);
    if (!Number.isInteger(idx) || idx < 0 || idx >= total) continue;
    for (const r of roundRecords(idx, { ...s, scores: { [idx]: records } })) {
      if (seatProblem(r.seatNo)) continue;
      if (!REPORT_CRITERIA.every((c) => validScore(r.reportScores[c.key])) || !validScore(r.questionScore)) continue;
      const submittedAt = typeof r.submittedAt === 'number' || typeof r.submittedAt === 'string' ? r.submittedAt : new Date().toISOString();
      tree[idx] = tree[idx] || {};
      tree[idx][`${r.scorerGroup}::${r.seatNo}`] = {
        scorerGroup: r.scorerGroup,
        seatNo: r.seatNo,
        reportScores: Object.fromEntries(REPORT_CRITERIA.map((c) => [c.key, Number(r.reportScores[c.key])])),
        reportScore: r.reportScore,
        questionScore: Number(r.questionScore),
        comment: safeText(r.comment).slice(0, 500),
        submittedAt,
        uid: typeof r.uid === 'string' && r.uid ? r.uid : 'imported',
      };
    }
  }
  return tree;
}

function hasAnyScores(scores) {
  return Object.values(scores || {}).some((round) => round && Object.keys(round).length > 0);
}

function mmss(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

// Web Audio 課堂鈴聲：共用 AudioContext，首次點擊／觸控後解鎖（符合手機自動播放政策）
let audioCtx = null;
let audioUnlockInstalled = false;
let studentLastDoneKey = '';

function getAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { console.warn(e); return null; }
  }
  return audioCtx;
}

function unlockAudio() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    // iOS：極短靜音 buffer 有助於真正解鎖
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch (e) { console.warn(e); }
}

function installAudioUnlock() {
  if (audioUnlockInstalled) return;
  audioUnlockInstalled = true;
  const unlock = () => unlockAudio();
  for (const ev of ['pointerdown', 'touchstart', 'keydown']) {
    document.addEventListener(ev, unlock, { capture: true, passive: true });
  }
}

// 主輸出：前級增益 → 壓縮／限幅器 → 喇叭。讓鈴聲又大聲又不破音（投影筆電喇叭也聽得清楚）
let audioOut = null;
function getAudioOut(ctx) {
  if (audioOut && audioOut.ctx === ctx) return audioOut.input;
  const input = ctx.createGain();
  input.gain.value = 1.8;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 4;
  comp.ratio.value = 16;
  comp.attack.value = 0.002;
  comp.release.value = 0.12;
  const makeup = ctx.createGain();
  makeup.gain.value = 1.9;
  const limiter = ctx.createDynamicsCompressor(); // 第二級當限幅器，避免削波
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.05;
  input.connect(comp); comp.connect(makeup); makeup.connect(limiter); limiter.connect(ctx.destination);
  audioOut = { ctx, input };
  return input;
}

// 一個「響亮的音」：正弦基音＋八度泛音＋少量方波（人耳對 1–3 kHz 最敏感，小喇叭也放得出來）
function loudTone(ctx, out, f, start, dur, peak = 0.9) {
  const layers = [
    { type: 'sine', mul: 1, g: 1 },
    { type: 'sine', mul: 2, g: 0.35 },
    { type: 'square', mul: 1, g: 0.12 },
    { type: 'triangle', mul: 3, g: 0.12 },
  ];
  for (const l of layers) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = l.type;
    osc.frequency.value = f * l.mul;
    const p = Math.max(0.0002, peak * l.g);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(p, start + 0.012);
    gain.gain.setValueAtTime(p, start + Math.max(0.02, dur * 0.55));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain); gain.connect(out);
    osc.start(start); osc.stop(start + dur + 0.05);
  }
}

/** 課堂鈴聲：上行大調琶音（G5–B5–D6–G6），結束時連響 3 次、開始時響 1 次 */
function bell(repeats = 1) {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const out = getAudioOut(ctx);
    const tones = [
      { f: 784, at: 0, dur: 0.22 },
      { f: 988, at: 0.2, dur: 0.22 },
      { f: 1175, at: 0.4, dur: 0.24 },
      { f: 1568, at: 0.62, dur: 0.7 },
    ];
    const gap = 1.45;
    for (let r = 0; r < repeats; r++) {
      for (const { f, at, dur } of tones) loudTone(ctx, out, f, ctx.currentTime + 0.03 + r * gap + at, dur);
    }
  } catch (e) { console.warn(e); }
}

/** 剩 30 秒提醒：兩聲短嗶 */
function warnBeep() {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const out = getAudioOut(ctx);
    const t = ctx.currentTime + 0.03;
    loudTone(ctx, out, 1319, t, 0.16, 0.8);
    loudTone(ctx, out, 1319, t + 0.26, 0.16, 0.8);
  } catch (e) { console.warn(e); }
}

const END_BELL_REPEATS = 3;
let lastWarnKey = '';

/** 倒數到 0 時連響 3 次（以 phase+endsAt 去重；老師／學生各自追蹤）；老師端剩 30 秒時短嗶提醒 */
function maybeBellWhenDone(tv, which) {
  if (!(tv.running && tv.endsAt)) return;
  const key = `${tv.phase}:${tv.endsAt}`;
  if (!tv.done) {
    if (which === 'teacher' && tv.duration >= 60 && tv.remaining <= 30 && tv.remaining >= 27 && key !== lastWarnKey) {
      lastWarnKey = key;
      warnBeep();
    }
    return;
  }
  // 太久以前就結束的計時（例如重新整理或叫出舊活動）不再響
  if (serverNow() - Number(tv.endsAt) > 15000) {
    if (which === 'student') studentLastDoneKey = key; else lastDoneKey = key;
    return;
  }
  if (which === 'student') {
    if (key === studentLastDoneKey) return;
    studentLastDoneKey = key;
  } else {
    if (key === lastDoneKey) return;
    lastDoneKey = key;
  }
  bell(END_BELL_REPEATS);
}

// ---------------------------------------------------------------- 老師端

const teacher = {
  sessionId: null,
  unsubs: [],
  presenceCount: 0,
  connected: false,
  status: '尚未建立',
  statusKind: 'muted',
  busy: false,
};

function setTeacherStatus(text, kind = 'muted') {
  teacher.status = text; teacher.statusKind = kind;
  const el = $('sessionStatus');
  if (el) { el.textContent = text; el.className = `pill ${kind}`; }
}

function startPhase(phase, duration) {
  unlockAudio();
  state.phase = phase;
  const start = serverNow();
  state.timer = { running: true, phase, duration, startedAt: start, endsAt: start + duration * 1000 };
  saveState();
  renderTeacher();
  bell(1);
}

function updateGroupCountHint() {
  const groups = parseGroups($('groupsInput')?.value || '');
  const count = groups.length || state.groups.length || 0;
  if ($('groupCountHint')) $('groupCountHint').textContent = `目前 ${count} 組`;
  if ($('groupCountInput') && document.activeElement !== $('groupCountInput')) $('groupCountInput').value = count;
}

function setupTeacher() {
  installAudioUnlock();
  $('teacherApp').classList.remove('hidden');
  $('titleInput').value = state.title;
  $('groupsInput').value = state.groups.join('\n');
  $('groupCountInput').value = state.groups.length;
  updateGroupCountHint();

  $('groupsInput').addEventListener('input', updateGroupCountHint);
  $('applyGroupCountBtn').onclick = () => {
    const count = clamp(Math.floor(Number($('groupCountInput').value) || DEFAULT_GROUP_COUNT), 2, 50);
    $('groupCountInput').value = count;
    $('groupsInput').value = makeDefaultGroups(count).join('\n');
    updateGroupCountHint();
  };
  $('saveShuffleBtn').onclick = () => {
    const groups = parseGroups($('groupsInput').value);
    if (groups.length < 2) return alert('至少需要 2 個組別。');
    if (hasAnyScores(state.scores) && !confirm('重新抽籤會清空目前所有評分資料（建議先下載 Excel／JSON）。確定繼續？')) return;
    const [reportOrder, questionOrder] = makeDerangedOrders(groups);
    state = { ...state, schemaVersion: 3, title: safeText($('titleInput').value) || '探究與實作上台報告', groups, reportOrder, questionOrder, currentIndex: 0, scores: {}, exclusion: { presented: [], asked: [], manual: false }, phase: 'setup', timer: { running: false, phase: 'setup', duration: 0, startedAt: null, endsAt: null } };
    saveState(); clearRemoteScores(); renderTeacher();
  };
  $('reshuffleBtn').onclick = () => {
    const groups = parseGroups($('groupsInput').value);
    if (groups.length < 2) return alert('至少需要 2 個組別。');
    if (hasAnyScores(state.scores) && !confirm('重新抽籤會清空目前所有評分資料（建議先下載 Excel／JSON）。確定繼續？')) return;
    const [reportOrder, questionOrder] = makeDerangedOrders(groups);
    state.groups = groups;
    state.reportOrder = reportOrder; state.questionOrder = questionOrder; state.currentIndex = 0; state.scores = {}; state.phase = 'setup';
    state.exclusion = { presented: [], asked: [], manual: false };
    state.timer = { running: false, phase: 'setup', duration: 0, startedAt: null, endsAt: null };
    saveState(); clearRemoteScores(); renderTeacher();
  };
  $('resetScoresBtn').onclick = () => {
    if (confirm('確定要清空所有評分資料？')) { state.scores = {}; saveState(); clearRemoteScores(); renderTeacher(); }
  };
  $('startSessionBtn').onclick = () => {
    const saved = localStorage.getItem(SESSION_KEY);
    if (teacher.sessionId) return alert('即時收分 Session 已在運作中。若要換新的 QR，請按「開新 Session」。');
    if (saved) resumeSession(saved); else createSession();
  };
  $('newSessionBtn').onclick = () => {
    if (teacher.sessionId && !confirm('開新 Session 會產生新的 QR Code，學生需重新掃描。目前的評分會保留並帶到新 Session。確定？')) return;
    createSession();
  };
  $('copyStudentUrlBtn').onclick = async () => {
    const text = $('studentUrl').textContent;
    try { await navigator.clipboard.writeText(text); alert('已複製學生網址'); } catch (_) { prompt('請複製學生網址', text); }
  };
  // 報告／提問時間設定：只影響「下一次開始」的計時，不會改動正在倒數的時間
  fillMinuteSelect('reportMinutesSelect', 'report');
  fillMinuteSelect('questionMinutesSelect', 'question');
  const onMinutesChange = () => {
    state.durations = normalizeDurations({ reportMinutes: $('reportMinutesSelect').value, questionMinutes: $('questionMinutesSelect').value });
    saveState();
    renderTeacher(false);
  };
  $('reportMinutesSelect').onchange = onMinutesChange;
  $('questionMinutesSelect').onchange = onMinutesChange;
  $('startReportBtn').onclick = () => startPhase('report', phaseSeconds('report'));
  $('startQuestionBtn').onclick = () => startPhase('question', phaseSeconds('question'));
  $('startRatingBtn').onclick = () => startPhase('rating', phaseSeconds('rating'));
  $('nextRoundBtn').onclick = () => {
    const cr = currentRound();
    if (cr.total && cr.index < cr.total - 1) { state.currentIndex = cr.index + 1; startPhase('report', phaseSeconds('report')); }
    else { state.phase = 'done'; state.timer = { running: false, phase: 'done', duration: 0, startedAt: null, endsAt: null }; saveState(); renderTeacher(); alert('已到最後一輪。'); }
  };
  $('exportXlsxBtn').onclick = exportXlsx;
  $('exportJsonBtn').onclick = exportJson;
  $('importJsonInput').onchange = importJson;
  setupContinuation();
  renderTeacher();
  setInterval(() => { renderTeacher(false); }, 1000);

  onFirebaseProgress = (text) => { if (teacher.busy) setTeacherStatus(text, 'warn'); };
  // 重新整理後自動恢復上次的 Session（同一個 QR）
  const saved = localStorage.getItem(SESSION_KEY);
  if (!isConfigured(firebaseConfig) && !emulatorSettings()) setTeacherStatus('尚未設定 Firebase（見 README）', 'bad');
  else if (saved) resumeSession(saved, { silent: true });
}

function makeSessionId() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function createSession() {
  if (teacher.busy) return;
  teacher.busy = true;
  setTeacherStatus('建立中…', 'warn');
  try {
    const core = await initFirebase();
    const previous = teacher.sessionId || localStorage.getItem(SESSION_KEY);
    const id = makeSessionId();
    await withTimeout(core.set(dbRef(core, `sessions/${id}/meta`), { ownerUid: core.uid, createdAt: core.serverTimestamp(), title: state.title.slice(0, 100) }), NET_TIMEOUT_MS, '建立 Session 逾時，請確認網路。');
    localStorage.setItem(SESSION_KEY, id);
    await attachSession(core, id, { uploadLocalScores: true });
    // 通知仍停在舊 QR 的學生手機自動跳到新 Session（舊 Session 若不是自己的，規則會拒絕，忽略即可）
    if (previous && previous !== id) {
      core.update(dbRef(core, `sessions/${previous}/state`), { movedTo: id }).catch((e) => console.warn('movedTo', e));
    }
  } catch (e) {
    console.error(e);
    setTeacherStatus(`建立失敗：${fbErrorText(e)}`, 'bad');
  } finally {
    teacher.busy = false;
  }
}

async function resumeSession(id, { silent = false } = {}) {
  if (teacher.busy) return;
  teacher.busy = true;
  setTeacherStatus('恢復上次 Session 中…', 'warn');
  try {
    const core = await initFirebase();
    const snap = await withTimeout(core.get(dbRef(core, `sessions/${id}/meta`)), NET_TIMEOUT_MS, '讀取 Session 逾時，請確認網路。');
    if (!snap.exists()) { setTeacherStatus('找不到上次的 Session，請按「開新 Session」', 'bad'); return; }
    if (snap.val().ownerUid !== core.uid) {
      setTeacherStatus('上次的 Session 由其他瀏覽器建立（或瀏覽器資料已清除），請按「開新 Session」', 'bad');
      return;
    }
    await attachSession(core, id, { uploadLocalScores: false });
  } catch (e) {
    console.error(e);
    setTeacherStatus(`${silent ? '自動恢復失敗' : '恢復失敗'}：${fbErrorText(e)}`, 'bad');
  } finally {
    teacher.busy = false;
  }
}

function detachSession() {
  for (const off of teacher.unsubs) { try { off(); } catch (_) { /* ignore */ } }
  teacher.unsubs = [];
  teacher.sessionId = null;
  teacher.presenceCount = 0;
}

async function attachSession(core, id, { uploadLocalScores }) {
  detachSession();
  teacher.sessionId = id;
  updateStudentUrl(id);
  await withTimeout(core.set(dbRef(core, `sessions/${id}/state`), publicState()), NET_TIMEOUT_MS, '同步狀態逾時，請確認網路。');
  if (uploadLocalScores && hasAnyScores(state.scores)) await uploadAllScores();

  let firstSnapshot = true;
  teacher.unsubs.push(core.onValue(dbRef(core, `sessions/${id}/scores`), (snap) => {
    const remote = normalizeScoresTree(snap.val());
    // 雲端沒有資料但本機有（例如雲端被清掉）：以本機備份為準重新上傳，避免覆蓋掉本機資料
    if (firstSnapshot && !hasAnyScores(remote) && hasAnyScores(state.scores)) {
      firstSnapshot = false;
      uploadAllScores();
      return;
    }
    firstSnapshot = false;
    state.scores = remote;
    saveLocal();
    renderTeacher(false);
  }, (err) => setTeacherStatus(`讀取評分失敗：${fbErrorText(err)}`, 'bad')));
  teacher.unsubs.push(core.onValue(dbRef(core, `sessions/${id}/presence`), (snap) => {
    teacher.presenceCount = snap.exists() ? Object.keys(snap.val() || {}).length : 0;
    renderTeacher(false);
  }, (err) => console.warn('presence', err)));
  teacher.unsubs.push(core.onValue(dbRef(core, '.info/connected'), (snap) => {
    teacher.connected = snap.val() === true;
    if (teacher.sessionId) setTeacherStatus(teacher.connected ? `即時收分中：${id}` : `暫時離線，網路恢復後自動同步（${id}）`, teacher.connected ? 'ok' : 'warn');
  }));
  setTeacherStatus(`即時收分中：${id}`, 'ok');
}

function pushPublicState() {
  if (!teacher.sessionId || !fbCore) return Promise.resolve();
  const id = teacher.sessionId;
  return fbCore.set(dbRef(fbCore, `sessions/${id}/state`), publicState())
    .catch((e) => { console.error(e); setTeacherStatus(`同步狀態失敗：${fbErrorText(e)}`, 'bad'); });
}

function clearRemoteScores() {
  if (!teacher.sessionId || !fbCore) return Promise.resolve();
  return fbCore.set(dbRef(fbCore, `sessions/${teacher.sessionId}/scores`), null)
    .catch((e) => { console.error(e); setTeacherStatus(`清空雲端評分失敗：${fbErrorText(e)}`, 'bad'); });
}

// 以本機資料覆蓋雲端評分（新 Session、匯入 JSON 時使用）。需先寫入 state（規則會檢查報告組／提問組）。
function uploadAllScores() {
  if (!teacher.sessionId || !fbCore) return Promise.resolve();
  const tree = toRemoteScoresTree(state.scores);
  return fbCore.set(dbRef(fbCore, `sessions/${teacher.sessionId}/scores`), Object.keys(tree).length ? tree : null)
    .catch((e) => { console.error(e); alert(`上傳評分到 Firebase 失敗：${fbErrorText(e)}\n本機資料仍保留，請先下載 JSON 備份。`); });
}

async function updateStudentUrl(sessionId) {
  const url = new URL(location.href);
  const sp = new URLSearchParams();
  sp.set('session', sessionId);
  if (params.has('emulator')) sp.set('emulator', '1');
  url.search = `?${sp.toString()}`;
  url.hash = '';
  $('studentUrl').textContent = url.toString();
  try {
    await loadScript(QRIOUS_URL);
    // eslint-disable-next-line no-new
    new window.QRious({ element: $('qrCanvas'), value: url.toString(), size: 220, padding: 8, level: 'M' });
  } catch (e) {
    console.error(e);
    $('studentUrl').textContent = `${url.toString()}（QR 套件載入失敗，請改用複製網址）`;
  }
}

function fillMinuteSelect(id, kind) {
  const r = MINUTES_RANGE[kind];
  const opts = [];
  for (let m = r.min; m <= r.max; m++) opts.push(`<option value="${m}">${m} 分鐘${m === r.def ? '（預設）' : ''}</option>`);
  $(id).innerHTML = opts.join('');
}

function renderDurationControls() {
  const d = state.durations;
  if (document.activeElement !== $('reportMinutesSelect')) $('reportMinutesSelect').value = String(d.reportMinutes);
  if (document.activeElement !== $('questionMinutesSelect')) $('questionMinutesSelect').value = String(d.questionMinutes);
  $('startReportBtn').textContent = `開始報告 ${mmss(d.reportMinutes * 60).replace(/^0/, '')}`;
  $('startQuestionBtn').textContent = `開始提問 ${mmss(d.questionMinutes * 60).replace(/^0/, '')}`;
  $('nextRoundBtn').textContent = `下一輪＋開始報告 ${mmss(d.reportMinutes * 60).replace(/^0/, '')}`;
}

function renderTeacher(updateInputs = true) {
  renderDurationControls();
  if (updateInputs && document.activeElement !== $('titleInput')) $('titleInput').value = state.title;
  if (updateInputs && document.activeElement !== $('groupsInput')) $('groupsInput').value = state.groups.join('\n');
  updateGroupCountHint();
  const cr = currentRound(); const tv = timerView();
  $('roundInfo').textContent = cr.total ? `第 ${cr.roundNo} / ${cr.total} 輪` : '尚未抽籤';
  $('phaseLabel').textContent = tv.label;
  $('timerText').textContent = mmss(tv.remaining);
  $('timerBar').style.width = tv.duration ? `${clamp(100 * (1 - tv.remaining / tv.duration), 0, 100)}%` : '0%';
  $('reportGroup').textContent = cr.reportGroup || '—';
  $('questionGroup').textContent = cr.questionGroup || '—';
  $('connectionCount').textContent = String(teacher.presenceCount);
  maybeBellWhenDone(tv, 'teacher');
  const cs = cr.total ? roundStats(cr.index) : null;
  $('reportAvg').textContent = scoreText(cs?.reportAvg);
  $('questionAvg').textContent = scoreText(cs?.questionAvg);
  for (const criterion of REPORT_CRITERIA) $(criterion.avgId).textContent = scoreText(cs?.reportCriteriaAvgs?.[criterion.key]);
  $('scoreCount').textContent = cs ? `${cs.responseCount}人 / ${cs.submittedGroupCount}/${cs.expectedCount}組` : '0人 / 0組';
  $('missingGroups').textContent = `未評分組別：${cs?.missingGroups?.join('、') || '—'}`;
  renderOrderTable(); renderStatsTable(); renderExclusion();
}

function renderRows(tableId, rows) {
  $(tableId).innerHTML = rows.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${escapeHtml(c)}</td>` : `<th>${escapeHtml(c)}</th>`)).join('')}</tr>`).join('');
}

function renderOrderTable() {
  const rows = [['順位', '上台報告', '負責提問', '檢查', '進度']];
  const total = Math.min(state.reportOrder.length, state.questionOrder.length);
  const done = doneRoundSet();
  const cur = currentRound().index;
  for (let i = 0; i < total; i++) rows.push([i + 1, state.reportOrder[i], state.questionOrder[i], state.reportOrder[i] === state.questionOrder[i] ? '衝突' : 'OK', done.has(i) ? '✅ 已完成' : i === cur ? '▶ 本輪' : '待報告']);
  $('orderTable').innerHTML = rows.map((r, i) => `<tr class="${i && r[3] !== 'OK' ? 'conflict' : i && r[4].startsWith('✅') ? 'done-row' : ''}">${r.map((c) => (i ? `<td>${escapeHtml(c)}</td>` : `<th>${escapeHtml(c)}</th>`)).join('')}</tr>`).join('');
}

function renderStatsTable() {
  const total = Math.min(state.reportOrder.length, state.questionOrder.length);
  const rows = [['順位', '報告組', '提問組', '報告總平均', '問題與方法', '證據與分析', '表達與回應', '提問平均', '評分進度', '未評分']];
  for (let i = 0; i < total; i++) {
    const s = roundStats(i);
    rows.push([
      s.roundNo, s.reportGroup, s.questionGroup, scoreText(s.reportAvg),
      scoreText(s.reportCriteriaAvgs.inquiryDesign), scoreText(s.reportCriteriaAvgs.evidenceAnalysis), scoreText(s.reportCriteriaAvgs.communication),
      scoreText(s.questionAvg), `${s.responseCount}人 / ${s.submittedGroupCount}/${s.expectedCount}組`, s.missingGroups.join('、') || '—',
    ]);
  }
  renderRows('statsTable', rows);
}

function exportRows() {
  const total = Math.min(state.reportOrder.length, state.questionOrder.length);
  const summary = [[state.title], ['匯出時間', new Date().toLocaleString('zh-TW', { hour12: false })], [], ['順位', '報告組別', '提問組別', '報告總平均', '探究問題與方法設計', '資料證據與分析解釋', '科學表達與回應能力', '提問平均', '評分人數', '已評分組數', '應評分組數', '未評分組別']];
  for (let i = 0; i < total; i++) {
    const s = roundStats(i);
    summary.push([s.roundNo, s.reportGroup, s.questionGroup, s.reportAvg, s.reportCriteriaAvgs.inquiryDesign, s.reportCriteriaAvgs.evidenceAnalysis, s.reportCriteriaAvgs.communication, s.questionAvg, s.responseCount, s.submittedGroupCount, s.expectedCount, s.missingGroups.join('、')]);
  }
  const groupSummary = [['組別', '報告順位', '報告總平均', '探究問題與方法設計', '資料證據與分析解釋', '科學表達與回應能力', '提問順位', '提問平均']];
  for (const g of state.groups) {
    const ri = state.reportOrder.indexOf(g); const qi = state.questionOrder.indexOf(g);
    const rs = ri >= 0 ? roundStats(ri) : null;
    const qs = qi >= 0 ? roundStats(qi) : null;
    groupSummary.push([g, ri >= 0 ? ri + 1 : '', rs?.reportAvg ?? '', rs?.reportCriteriaAvgs?.inquiryDesign ?? '', rs?.reportCriteriaAvgs?.evidenceAnalysis ?? '', rs?.reportCriteriaAvgs?.communication ?? '', qi >= 0 ? qi + 1 : '', qs?.questionAvg ?? '']);
  }
  const raw = [['順位', '報告組別', '提問組別', '評分組別', '評分者座號', '探究問題與方法設計', '資料證據與分析解釋', '科學表達與回應能力', '報告總平均', '提問分數', '送出時間', '備註']];
  for (let i = 0; i < total; i++) {
    for (const r of roundRecords(i)) {
      raw.push([i + 1, state.reportOrder[i], state.questionOrder[i], r.scorerGroup, r.seatNo, r.reportScores.inquiryDesign, r.reportScores.evidenceAnalysis, r.reportScores.communication, r.reportScore, r.questionScore, formatTime(r.submittedAt), r.comment || '']);
    }
  }
  const order = [['順位', '報告組別', '提問組別', '是否衝突']];
  for (let i = 0; i < total; i++) order.push([i + 1, state.reportOrder[i], state.questionOrder[i], state.reportOrder[i] === state.questionOrder[i] ? '衝突' : 'OK']);
  return { summary, groupSummary, raw, order };
}

async function exportXlsx() {
  const filename = `${state.title || '探究與實作上台報告'}_評分資料_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.xlsx`;
  try {
    await loadScript(XLSX_URL);
  } catch (_) {
    alert('Excel 套件載入失敗，請確認網路；也可以先下載 JSON 備份。');
    return;
  }
  const XLSX = window.XLSX;
  const rows = exportRows();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows.summary), '總表');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows.groupSummary), '組別總結');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows.raw), '原始評分');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows.order), '抽籤排序');
  XLSX.writeFile(wb, filename);
}

function exportJson() {
  const blob = new Blob([JSON.stringify({ ...state, sessionId: teacher.sessionId || localStorage.getItem(SESSION_KEY) || null }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.title || '探究與實作上台報告'}_備份.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importJson(ev) {
  const file = ev.target.files?.[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      delete parsed.sessionId;
      state = normalizeLoadedState(parsed);
      saveLocal();
      renderTeacher();
      if (teacher.sessionId) { await pushPublicState(); await uploadAllScores(); }
      renderActivities();
      alert(teacher.sessionId ? '已匯入備份，並同步到目前的 QR Session。' : '已匯入備份。請按「建立／恢復即時收分 Session」開始收分。');
    } catch (e) { alert('匯入失敗：' + e.message); }
    ev.target.value = '';
  };
  reader.readAsText(file, 'utf-8');
}

// ---------------------------------------------------------------- 跨週接續：已儲存活動

function loadActivities() {
  try { const v = JSON.parse(localStorage.getItem(ACTIVITIES_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}
function storeActivities(list) {
  try { localStorage.setItem(ACTIVITIES_KEY, JSON.stringify(list)); } catch (e) { console.warn(e); }
}

// 每次老師端資料變動都自動記錄到「已儲存活動」（以 Session ID 為鍵；資料本身也在 Firebase）
function recordActivity(force = false) {
  if (isStudentMode) return;
  const id = teacher.sessionId;
  if (!id) return;
  const list = loadActivities();
  const total = Math.min(state.reportOrder.length, state.questionOrder.length);
  list[id] = {
    id,
    title: state.title || '探究與實作上台報告',
    updatedAt: Date.now(),
    createdAt: list[id]?.createdAt || Date.now(),
    doneRounds: doneRoundSet().size,
    totalRounds: total,
    groupCount: state.groups.length,
    snapshot: { ...state, timer: { running: false, phase: 'setup', duration: 0, startedAt: null, endsAt: null } },
  };
  storeActivities(list);
  scheduleRenderActivities();
}

let renderActTimer = null;
function scheduleRenderActivities() {
  if (renderActTimer) return;
  renderActTimer = setTimeout(() => { renderActTimer = null; renderActivities(); }, 300);
}

function renderActivities() {
  const box = $('activityList');
  if (!box) return;
  const items = Object.values(loadActivities()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!items.length) { box.innerHTML = '<p class="hint">還沒有儲存的活動。建立 Session 後會自動儲存，也可以按「儲存目前進度」。</p>'; return; }
  box.innerHTML = items.map((a) => {
    const current = a.id === teacher.sessionId;
    const remain = Math.max(0, (a.totalRounds || 0) - (a.doneRounds || 0));
    return `<div class="activity-item${current ? ' current' : ''}">
      <div>
        <strong>${escapeHtml(a.title)}</strong>${current ? ' <span class="pill ok">使用中</span>' : ''}
        <div class="hint">最後更新：${escapeHtml(formatTime(a.updatedAt))}｜${a.groupCount || 0} 組｜已完成 ${a.doneRounds || 0} / ${a.totalRounds || 0} 輪（剩 ${remain} 組）｜ID ${escapeHtml(a.id)}</div>
      </div>
      <div class="activity-btns">
        ${current ? '' : `<button type="button" class="primary" data-act="load" data-id="${escapeHtml(a.id)}">叫出來繼續</button>`}
        <button type="button" class="danger-outline" data-act="remove" data-id="${escapeHtml(a.id)}">從清單移除</button>
      </div>
    </div>`;
  }).join('');
}

function setupContinuation() {
  $('saveActivityBtn').onclick = saveActivityNow;
  $('newActivityBtn').onclick = startNewActivity;
  $('activityList').onclick = (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === 'load') loadActivity(id);
    if (btn.dataset.act === 'remove') {
      const a = loadActivities()[id];
      if (!confirm(`從清單移除「${a?.title || id}」？（只移除這台電腦上的清單，不會刪除已下載的 Excel／JSON）`)) return;
      const list = loadActivities(); delete list[id]; storeActivities(list); renderActivities();
    }
  };
  $('testBellBtn').onclick = () => { unlockAudio(); bell(1); };
  // 排除與重新抽籤
  $('exclusionGrid').onchange = (ev) => {
    if (!ev.target.matches('input[type=checkbox]')) return;
    const presented = []; const asked = [];
    for (const cb of $('exclusionGrid').querySelectorAll('input[type=checkbox]:checked')) (cb.dataset.kind === 'presented' ? presented : asked).push(cb.dataset.group);
    setExclusion(presented, asked, true);
  };
  const onText = () => {
    setExclusion(parseGroupRefs($('presentedInput').value), parseGroupRefs($('askedInput').value), true, { keepText: true });
  };
  $('presentedInput').addEventListener('change', onText);
  $('askedInput').addEventListener('change', onText);
  $('presentedInput').addEventListener('input', onText);
  $('askedInput').addEventListener('input', onText);
  $('autoExclusionBtn').onclick = () => { state.exclusion = { ...state.exclusion, ...autoExclusion(), manual: false }; exclusionKey = ''; saveState(); renderTeacher(false); };
  $('clearExclusionBtn').onclick = () => { setExclusion([], [], true); };
  $('redrawBtn').onclick = redrawExcluding;
  renderActivities();
}

async function saveActivityNow() {
  const title = safeText($('titleInput').value);
  if (title) state.title = title;
  if (!teacher.sessionId) {
    saveLocal();
    await createSession();
    if (!teacher.sessionId) return alert('尚未建立 Session，無法儲存到雲端；本機仍有備份，也可以先下載 JSON。');
  } else {
    saveState();
  }
  recordActivity(true);
  renderActivities();
  setTeacherStatus(`已儲存「${state.title}」（${formatTime(Date.now())}）`, 'ok');
  setTimeout(() => { if (teacher.sessionId) setTeacherStatus(teacher.connected ? `即時收分中：${teacher.sessionId}` : `暫時離線，網路恢復後自動同步（${teacher.sessionId}）`, teacher.connected ? 'ok' : 'warn'); }, 4000);
}

async function startNewActivity() {
  const title = prompt('新活動名稱（例如：高二5班 探究與實作 第2次報告）', state.title || '探究與實作上台報告');
  if (title === null) return;
  if (teacher.sessionId) recordActivity(true); // 目前活動先存好
  const groups = parseGroups($('groupsInput').value);
  const base = defaultState();
  const gs = groups.length >= 2 ? groups : state.groups;
  const [reportOrder, questionOrder] = makeDerangedOrders(gs);
  state = { ...base, title: safeText(title) || base.title, groups: gs, reportOrder, questionOrder, durations: state.durations };
  lastDoneKey = ''; exclusionKey = '';
  saveLocalOnly();
  renderTeacher();
  await createSession();
  renderActivities();
}

const idleTimer = () => ({ running: false, phase: 'setup', duration: 0, startedAt: null, endsAt: null });

async function loadActivity(id) {
  const entry = loadActivities()[id];
  if (!entry) return;
  if (id === teacher.sessionId) return;
  if (!confirm(`叫出「${entry.title}」繼續使用？\n目前的活動已自動儲存，之後也可以再叫回來。`)) return;
  if (teacher.busy) return alert('正在連線中，請稍候再試。');
  if (teacher.sessionId) recordActivity(true);
  const previous = teacher.sessionId;
  teacher.busy = true;
  setTeacherStatus('讀取已儲存的活動中…', 'warn');
  let useSnapshot = false;
  try {
    const core = await initFirebase();
    const metaSnap = await withTimeout(core.get(dbRef(core, `sessions/${id}/meta`)), NET_TIMEOUT_MS, '讀取活動逾時，請確認網路。');
    if (metaSnap.exists() && metaSnap.val().ownerUid === core.uid) {
      const [stSnap, scSnap] = await Promise.all([
        withTimeout(core.get(dbRef(core, `sessions/${id}/state`)), NET_TIMEOUT_MS, '讀取活動逾時'),
        withTimeout(core.get(dbRef(core, `sessions/${id}/scores`)), NET_TIMEOUT_MS, '讀取評分逾時'),
      ]);
      const remoteState = stSnap.val() || {};
      const remoteScores = normalizeScoresTree(scSnap.val());
      const snap = entry.snapshot || {};
      const merged = { ...snap, ...remoteState, groups: toList(remoteState.groups).length ? toList(remoteState.groups) : snap.groups, reportOrder: toList(remoteState.reportOrder).length ? toList(remoteState.reportOrder) : snap.reportOrder, questionOrder: toList(remoteState.questionOrder).length ? toList(remoteState.questionOrder) : snap.questionOrder, exclusion: remoteState.exclusion || snap.exclusion, scores: hasAnyScores(remoteScores) ? remoteScores : snap.scores };
      delete merged.movedTo; delete merged.groupSet; delete merged.currentRoundKey;
      state = normalizeLoadedState(merged);
      state.timer = idleTimer();
      if (state.phase !== 'done') state.phase = 'setup';
      lastDoneKey = ''; exclusionKey = '';
      saveLocalOnly();
      localStorage.setItem(SESSION_KEY, id);
      await attachSession(core, id, { uploadLocalScores: !hasAnyScores(remoteScores) && hasAnyScores(state.scores) });
      if (previous && previous !== id) core.update(dbRef(core, `sessions/${previous}/state`), { movedTo: id }).catch((e) => console.warn('movedTo', e));
      recordActivity(true);
      renderTeacher();
      alert(`已叫出「${state.title}」。\n學生掃原本這個活動的 QR（或還停在上一個活動頁面）都會自動接上。`);
    } else {
      useSnapshot = true;
    }
  } catch (e) {
    console.error(e);
    if (entry.snapshot && confirm(`雲端讀取失敗：${fbErrorText(e)}\n要改用這台電腦上的備份叫出（會產生新的 QR Code）？`)) useSnapshot = true;
    else setTeacherStatus(`叫出活動失敗：${fbErrorText(e)}`, 'bad');
  } finally {
    teacher.busy = false;
  }
  if (useSnapshot) {
    if (!entry.snapshot) return setTeacherStatus('找不到這個活動的資料', 'bad');
    state = normalizeLoadedState(entry.snapshot);
    state.timer = idleTimer();
    if (state.phase !== 'done') state.phase = 'setup';
    lastDoneKey = ''; exclusionKey = '';
    saveLocalOnly();
    renderTeacher();
    await createSession(); // 會把評分一起上傳到新 Session
    renderActivities();
    alert(`已用本機備份叫出「${state.title}」，並建立新的 QR Code（原 Session 不屬於這個瀏覽器）。請學生重新掃描。`);
  }
}

function saveLocalOnly() {
  state.updatedAt = new Date().toISOString();
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { console.warn(e); }
}

// ---------------------------------------------------------------- 排除已報告／已提問組別後重新抽籤

// 已完成的輪次：在目前輪次之前的，或目前輪次已進入提問／評分、已有人評分、或活動已結束
function doneRoundSet(s = state) {
  const out = new Set();
  const total = Math.min(s.reportOrder?.length || 0, s.questionOrder?.length || 0);
  const cur = currentRound(s).index;
  for (let i = 0; i < total; i++) {
    if (i < cur) out.add(i);
    else if (i === cur && (s.phase === 'question' || s.phase === 'rating' || s.phase === 'done' || Object.keys(s.scores?.[i] || {}).length > 0)) out.add(i);
  }
  return out;
}

function autoExclusion(s = state) {
  const done = [...doneRoundSet(s)];
  const bp = new Set(s.exclusion?.basePresented || []); const ba = new Set(s.exclusion?.baseAsked || []);
  return {
    presented: s.groups.filter((g) => bp.has(g) || done.some((i) => s.reportOrder[i] === g)),
    asked: s.groups.filter((g) => ba.has(g) || done.some((i) => s.questionOrder[i] === g)),
  };
}

function currentExclusion() {
  if (!state.exclusion?.manual) return autoExclusion();
  return { presented: state.exclusion.presented || [], asked: state.exclusion.asked || [] };
}

// 「1,3,5」「第1組、第3組」或直接打組名都可以；數字代表名單上第幾組
function parseGroupRefs(text) {
  const out = [];
  for (const tok of String(text || '').split(/[\s,，、;；]+/).map((t) => t.trim()).filter(Boolean)) {
    let g = null;
    const exact = state.groups.find((x) => x === safeGroupName(tok));
    if (exact) g = exact;
    else {
      const range = tok.match(/^(\d+)\s*[-~～]\s*(\d+)$/);
      if (range) {
        for (let n = Number(range[1]); n <= Number(range[2]); n++) if (state.groups[n - 1] && !out.includes(state.groups[n - 1])) out.push(state.groups[n - 1]);
        continue;
      }
      const m = tok.match(/^第?\s*(\d+)\s*組?$/);
      if (m && state.groups[Number(m[1]) - 1]) g = state.groups[Number(m[1]) - 1];
    }
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}

const groupNo = (g) => state.groups.indexOf(g) + 1;
const refsText = (list) => list.map(groupNo).filter((n) => n > 0).sort((a, b) => a - b).join(',');

function setExclusion(presented, asked, manual, { keepText = false } = {}) {
  state.exclusion = { ...state.exclusion, presented: state.groups.filter((g) => presented.includes(g)), asked: state.groups.filter((g) => asked.includes(g)), manual };
  saveState();
  renderExclusion(keepText);
}

let exclusionKey = '';
function renderExclusion(keepText = false) {
  const grid = $('exclusionGrid');
  if (!grid) return;
  const ex = currentExclusion();
  const key = JSON.stringify([state.groups, ex, Boolean(state.exclusion?.manual)]);
  if (key === exclusionKey && !keepText) return;
  exclusionKey = key;
  const p = new Set(ex.presented); const a = new Set(ex.asked);
  grid.innerHTML = '<div class="ex-row ex-head"><span>組別</span><span>已報告</span><span>已提問</span></div>' + state.groups.map((g, i) => `<div class="ex-row${p.has(g) ? ' is-presented' : ''}">
      <span>${i + 1}．${escapeHtml(g)}</span>
      <label class="ex-check"><input type="checkbox" data-kind="presented" data-group="${escapeHtml(g)}" ${p.has(g) ? 'checked' : ''} /></label>
      <label class="ex-check"><input type="checkbox" data-kind="asked" data-group="${escapeHtml(g)}" ${a.has(g) ? 'checked' : ''} /></label>
    </div>`).join('');
  if (!keepText || document.activeElement !== $('presentedInput')) $('presentedInput').value = refsText(ex.presented);
  if (!keepText || document.activeElement !== $('askedInput')) $('askedInput').value = refsText(ex.asked);
  const remainReport = state.groups.filter((g) => !p.has(g));
  const remainAsk = state.groups.filter((g) => !a.has(g));
  $('exclusionMode').textContent = state.exclusion?.manual ? '手動調整中' : '依紀錄自動帶入';
  $('exclusionMode').className = `pill ${state.exclusion?.manual ? 'warn' : 'ok'}`;
  $('remainingInfo').innerHTML = `<div><strong>還沒報告（${remainReport.length} 組）：</strong>${escapeHtml(remainReport.join('、') || '—（全部都報告過了）')}</div>
    <div><strong>還沒提問（${remainAsk.length} 組）：</strong>${escapeHtml(remainAsk.join('、') || '—（全部都提問過了）')}</div>`;
}

// 為剩下的報告組配提問組：優先用「還沒提問過」的組，不夠時再從已提問過的組補，且不可與報告組相同
function assignQuestioners(reporters, fresh, all) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const pool = randomShuffle(fresh).concat(randomShuffle(all.filter((g) => !fresh.includes(g))));
    const result = [];
    let ok = true;
    for (const r of reporters) {
      const idx = pool.findIndex((g) => g !== r);
      if (idx < 0) { ok = false; break; }
      result.push(pool.splice(idx, 1)[0]);
    }
    // 若「還沒提問」的組數 ≥ 報告組數，就要求全部由還沒提問的組擔任
    const freshNeeded = Math.min(fresh.length, reporters.length);
    if (ok && result.filter((g) => fresh.includes(g)).length >= freshNeeded) return result;
  }
  // 理論上不會到這裡：退而求其次，只保證不與報告組相同
  return reporters.map((r, i) => all.filter((g) => g !== r)[i % Math.max(1, all.length - 1)]);
}

async function redrawExcluding() {
  const ex = currentExclusion();
  const presented = new Set(ex.presented); const asked = new Set(ex.asked);
  const reporters = randomShuffle(state.groups.filter((g) => !presented.has(g)));
  if (!reporters.length) return alert('所有組別都已標記為「已報告」，沒有需要重新抽籤的組別。');
  if (state.groups.length < 2) return alert('至少需要 2 個組別。');
  const fresh = state.groups.filter((g) => !asked.has(g));
  // 保留已完成、且報告組被標記為已報告的輪次（連同分數）
  const done = doneRoundSet();
  const total = Math.min(state.reportOrder.length, state.questionOrder.length);
  const kept = [];
  for (let i = 0; i < total; i++) if (done.has(i) && presented.has(state.reportOrder[i])) kept.push(i);
  const keptText = kept.length ? `\n保留已完成的 ${kept.length} 輪（含分數）：${kept.map((i) => state.reportOrder[i]).join('、')}` : '';
  const droppedScored = [];
  for (let i = 0; i < total; i++) if (!kept.includes(i) && Object.keys(state.scores?.[i] || {}).length) droppedScored.push(state.reportOrder[i]);
  const dropText = droppedScored.length ? `\n⚠️ 這些輪次已有評分但不會保留：${droppedScored.join('、')}（建議先下載 Excel／JSON）` : '';
  if (!confirm(`排除已報告組別後重新抽籤：\n要抽的報告組 ${reporters.length} 組：${reporters.join('、')}${keptText}${dropText}\n確定？`)) return;
  const questioners = assignQuestioners(reporters, fresh, state.groups);
  const newScores = {};
  kept.forEach((oldIdx, newIdx) => { if (state.scores?.[oldIdx]) newScores[newIdx] = state.scores[oldIdx]; });
  state.reportOrder = kept.map((i) => state.reportOrder[i]).concat(reporters);
  state.questionOrder = kept.map((i) => state.questionOrder[i]).concat(questioners);
  state.scores = newScores;
  state.currentIndex = kept.length;
  state.phase = 'setup';
  state.timer = idleTimer();
  // 之後的進度會在這組標記之上自動累加（例如下週報告完的組別會自動算進「已報告」）
  state.exclusion = { presented: [], asked: [], manual: false, basePresented: [...presented], baseAsked: [...asked] };
  exclusionKey = '';
  saveLocal();
  await pushPublicState();
  if (teacher.sessionId) await uploadAllScores();
  // 重抽後：已完成輪次之外都還沒報告，讓「已報告」維持老師的標記
  renderTeacher();
  const unusedFresh = fresh.filter((g) => !questioners.includes(g));
  alert(`已重新抽籤！本次從第 ${kept.length + 1} 輪開始：${reporters[0]} 報告、${questioners[0]} 提問。` + (unusedFresh.length ? `\n（還沒提問的組比報告組多，這次沒排到提問：${unusedFresh.join('、')}）` : ''));
}

// ---------------------------------------------------------------- 學生端

const student = {
  sessionId: null,
  core: null,
  state: null,
  groupsKey: '',
  roundKey: '',
  connected: false,
  everConnected: false,
  stage: '連線中…',
  startedAt: Date.now(),
  error: '',
  submitting: false,
  attempt: 0,
  submittedRound: null,
};

function loadStudentIdentity() {
  try { return JSON.parse(localStorage.getItem(STUDENT_ID_KEY) || '{}') || {}; } catch (_) { return {}; }
}

function saveStudentIdentity() {
  const group = $('studentGroupSelect').value || loadStudentIdentity().group || '';
  try { localStorage.setItem(STUDENT_ID_KEY, JSON.stringify({ group, seatNo: safeText($('studentSeatNo').value) })); } catch (_) { /* ignore */ }
}

function renderStudentConn() {
  const el = $('studentConn');
  let text; let kind;
  if (student.error) { text = student.error; kind = 'bad'; }
  else if (!navigator.onLine) { text = '📴 手機目前離線，恢復網路後會自動重連'; kind = 'bad'; }
  else if (student.connected && student.state) { text = '🟢 已連線'; kind = 'ok'; }
  else if (student.connected) { text = '已連線，讀取老師端資料中…'; kind = 'warn'; }
  else if (student.everConnected) { text = '🟡 重新連線中…（會自動恢復）'; kind = 'warn'; }
  else {
    const sec = Math.round((Date.now() - student.startedAt) / 1000);
    text = `${student.stage}${sec >= 3 ? `（${sec} 秒）` : ''}`;
    if (Date.now() - student.startedAt > SLOW_HINT_MS) text += '　網路較慢，仍在自動重試；若超過 1–2 分鐘，可重新整理頁面。';
    kind = sec >= 3 ? 'warn' : 'muted';
  }
  el.textContent = text;
  el.className = `pill ${kind}`;
}

function setSubmitMsg(text, kind = 'muted') {
  const el = $('submitMsg');
  el.textContent = text;
  el.style.color = kind === 'ok' ? 'var(--success)' : kind === 'bad' ? 'var(--danger)' : 'var(--muted)';
}

async function setupStudent() {
  installAudioUnlock();
  $('studentApp').classList.remove('hidden');
  const saved = loadStudentIdentity();
  $('studentSeatNo').value = safeText(saved.seatNo);
  for (const criterion of REPORT_CRITERIA) {
    const input = $(`studentReport_${criterion.key}`);
    const text = $(`studentReport_${criterion.key}_Text`);
    input.oninput = () => { text.textContent = input.value; };
  }
  $('studentQuestionScore').oninput = () => { $('studentQuestionScoreText').textContent = $('studentQuestionScore').value; };
  $('studentGroupSelect').onchange = () => { unlockAudio(); saveStudentIdentity(); renderStudentEligibility(); };
  $('studentSeatNo').addEventListener('input', () => { unlockAudio(); saveStudentIdentity(); renderStudentEligibility(); });
  $('submitScoreBtn').onclick = () => { unlockAudio(); submitStudentScore(); };
  $('submitScoreBtn').disabled = true;
  window.addEventListener('online', renderStudentConn);
  window.addEventListener('offline', renderStudentConn);
  setInterval(renderStudentTimer, 500);

  const sessionId = params.get('session') || '';
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(sessionId)) {
    student.error = '網址缺少有效的 session，請重新掃描老師投影的 QR Code';
    renderStudentConn();
    return;
  }
  student.sessionId = sessionId;
  student.startedAt = Date.now();
  onFirebaseProgress = (text) => { student.stage = text; renderStudentConn(); };
  setInterval(renderStudentConn, 1000);
  renderStudentConn();
  connectStudent();
}

async function connectStudent() {
  const sessionId = student.sessionId;
  let core;
  try {
    core = await initFirebase(); // 內部會自動重試，只有設定錯誤或程式庫無法下載才會失敗
  } catch (e) {
    console.error(e);
    student.error = `連線失敗：${fbErrorText(e)}`;
    renderStudentConn();
    return;
  }
  student.core = core;
  student.stage = '連線資料庫中…';
  student.connected = core.connected;
  renderStudentConn();

  // 登入完成立刻讀取老師端狀態（不等 .info/connected，也不等 presence）
  listenStudentState(core, sessionId);

  const presenceRef = dbRef(core, `sessions/${sessionId}/presence/${core.uid}`);
  core.onValue(dbRef(core, '.info/connected'), (snap) => {
    student.connected = snap.val() === true;
    if (student.connected) student.everConnected = true;
    renderStudentConn();
    if (student.connected) {
      core.onDisconnect(presenceRef).remove()
        .then(() => core.set(presenceRef, core.serverTimestamp()))
        .catch((e) => console.warn('presence', e));
    }
  });
}

function listenStudentState(core, sessionId) {
  core.onValue(dbRef(core, `sessions/${sessionId}/state`), (snap) => {
    if (!snap.exists()) {
      student.state = null;
      student.error = '找不到這個評分 Session（老師可能已開新 Session），請重新掃描 QR Code';
      renderStudentConn();
      renderStudentEligibility();
      return;
    }
    const val = snap.val();
    if (val.movedTo && /^[A-Za-z0-9_-]{6,40}$/.test(val.movedTo)) {
      student.state = null;
      student.error = '老師已開新的評分 Session，正在自動切換…';
      renderStudentConn();
      renderStudentEligibility();
      const next = new URL(location.href);
      next.searchParams.set('session', val.movedTo);
      setTimeout(() => location.replace(next.toString()), 800);
      return;
    }
    student.error = '';
    student.state = val;
    renderStudent();
    renderStudentConn();
  }, (err) => {
    console.error(err);
    if (/PERMISSION_DENIED|permission/i.test(String(err?.code) + String(err?.message))) {
      student.error = `讀取失敗：${fbErrorText(err)}`;
      renderStudentConn();
      return;
    }
    // 其他暫時性錯誤：3 秒後自動重新監聽
    student.stage = '讀取失敗，自動重試中…';
    renderStudentConn();
    setTimeout(() => listenStudentState(core, sessionId), 3000);
  });
}

function renderStudentTimer() {
  const s = student.state;
  if (!s) return;
  const cr = currentRound(s);
  const tv = timerView(s);
  $('studentRoundInfo').textContent = cr.total ? `第 ${cr.roundNo} / ${cr.total} 輪｜${tv.label}｜剩餘 ${mmss(tv.remaining)}` : '尚未開始';
  maybeBellWhenDone(tv, 'student');
}

function renderStudent() {
  const s = student.state;
  if (!s) return;
  $('studentTitle').textContent = s.title || '探究與實作上台報告';
  const cr = currentRound(s);
  $('studentReportGroup').textContent = cr.reportGroup || '—';
  $('studentQuestionGroup').textContent = cr.questionGroup || '—';
  renderStudentTimer();

  // 只有組別名單改變時才重建下拉選單，避免手機上正在選擇時被關掉
  const groups = Array.isArray(s.groups) ? s.groups : Object.values(s.groups || {});
  const groupsKey = JSON.stringify(groups);
  if (groupsKey !== student.groupsKey) {
    student.groupsKey = groupsKey;
    const select = $('studentGroupSelect');
    const old = select.value || loadStudentIdentity().group || '';
    select.innerHTML = '<option value="">請選擇你的組別</option>' + groups.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
    if (old && groups.includes(old)) select.value = old;
  }

  // 換輪時清除上一輪的送出訊息與備註
  const roundKey = `${cr.index}:${(s.reportOrder || []).join('|')}`;
  if (student.roundKey && roundKey !== student.roundKey) {
    student.submittedRound = null;
    if (!student.submitting) {
      setSubmitMsg(`已進入第 ${cr.roundNo} 輪，請為本輪評分。`);
      $('studentComment').value = '';
      $('submitScoreBtn').textContent = '送出／更新本輪評分';
    }
  }
  student.roundKey = roundKey;
  renderStudentEligibility();
}

function seatProblem(seatNo) {
  if (!seatNo) return '請填寫座號。';
  if (seatNo.length > 12) return '座號太長，請填 1–12 個字元。';
  if (/[.#$[\]/]/.test(seatNo)) return '座號不可包含 . # $ [ ] / 等符號。';
  return '';
}

function renderStudentEligibility() {
  const g = $('studentGroupSelect').value;
  const seatNo = safeText($('studentSeatNo').value);
  const s = student.state;
  const cr = currentRound(s);
  const msg = $('eligibilityMsg');
  const btn = $('submitScoreBtn');
  const block = (text, cls = 'notice mini') => { msg.className = cls; msg.textContent = text; btn.disabled = true; };
  if (!s) return block('等待老師端資料…');
  if (!cr.total) return block('老師尚未完成抽籤。');
  if (!g || !seatNo) return block('請先選擇你的組別並填寫座號。');
  const problem = seatProblem(seatNo);
  if (problem) return block(problem, 'notice mini bad');
  if (g === cr.reportGroup) return block('你們本輪是上台報告組，不需要評分。', 'notice mini bad');
  if (g === cr.questionGroup) return block('你們本輪是負責提問組，不需要評分。', 'notice mini bad');
  msg.className = 'notice mini ok';
  msg.textContent = '你們本輪是聽講評分組，請評分報告組三項能力與提問組問題品質。';
  btn.disabled = student.submitting;
}

async function submitStudentScore() {
  if (student.submitting) return;
  const core = student.core;
  const s = student.state;
  if (!core || !s) return setSubmitMsg('尚未連上老師的評分 Session，請稍候或重新整理。', 'bad');
  const scorerGroup = $('studentGroupSelect').value;
  const seatNo = safeText($('studentSeatNo').value);
  if (!scorerGroup) return setSubmitMsg('請選擇你的組別。', 'bad');
  const problem = seatProblem(seatNo);
  if (problem) return setSubmitMsg(problem, 'bad');
  const cr = currentRound(s);
  if ([cr.reportGroup, cr.questionGroup].includes(scorerGroup)) return setSubmitMsg('本輪報告組與提問組不需評分。', 'bad');

  const reportScores = {};
  for (const criterion of REPORT_CRITERIA) reportScores[criterion.key] = Number($(`studentReport_${criterion.key}`).value);
  const questionScore = Number($('studentQuestionScore').value);
  if (!REPORT_CRITERIA.every((c) => validScore(reportScores[c.key])) || !validScore(questionScore)) return setSubmitMsg('分數必須都是 1–10。', 'bad');
  const record = {
    scorerGroup,
    seatNo,
    reportScores,
    reportScore: avg(REPORT_CRITERIA.map((c) => reportScores[c.key])),
    questionScore,
    comment: safeText($('studentComment').value).slice(0, 500),
    submittedAt: core.serverTimestamp(),
    uid: core.uid,
  };
  saveStudentIdentity();

  const btn = $('submitScoreBtn');
  const attempt = ++student.attempt;
  const roundNo = cr.roundNo;
  student.submitting = true;
  btn.disabled = true;
  btn.textContent = '送出中…';
  setSubmitMsg('送出中…');
  const writePromise = core.set(dbRef(core, `sessions/${student.sessionId}/scores/${cr.index}/${scorerGroup}::${seatNo}`), record);
  try {
    await withTimeout(writePromise, SUBMIT_TIMEOUT_MS, 'timeout');
    student.submittedRound = cr.index;
    setSubmitMsg(`✅ 已送出第 ${roundNo} 輪評分（${new Date().toLocaleTimeString('zh-TW', { hour12: false })}）。要修改可再送出一次。`, 'ok');
    btn.textContent = '送出／更新本輪評分';
  } catch (e) {
    console.error(e);
    btn.textContent = '重試送出';
    if (e.code === 'timeout') {
      setSubmitMsg(`⚠️ 送出逾時（${SUBMIT_TIMEOUT_MS / 1000} 秒內沒有收到確認）。請確認網路後按「重試送出」。`, 'bad');
      // 網路恢復後，原本排隊中的寫入仍可能成功；成功就更新訊息
      writePromise.then(() => {
        if (attempt === student.attempt && !student.submitting) {
          student.submittedRound = cr.index;
          setSubmitMsg(`✅ 已送出第 ${roundNo} 輪評分（網路恢復後完成）。`, 'ok');
          btn.textContent = '送出／更新本輪評分';
        }
      }).catch(() => {});
    } else if (/PERMISSION_DENIED|permission/i.test(String(e.code) + String(e.message))) {
      setSubmitMsg('❌ 送出被拒絕：可能老師已換到下一輪（畫面更新後請重新送出），或這個「組別＋座號」已經由另一支手機／瀏覽器送出過（請用原本的手機修改，或請老師處理）。', 'bad');
    } else {
      setSubmitMsg(`❌ 送出失敗：${fbErrorText(e)}`, 'bad');
    }
  } finally {
    student.submitting = false;
    renderStudentEligibility();
  }
}

// ---------------------------------------------------------------- 啟動

function main() {
  const boot = $('bootMsg');
  if (boot) boot.remove();
  if (isStudentMode) setupStudent(); else setupTeacher();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
else main();
