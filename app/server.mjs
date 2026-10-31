#!/usr/bin/env node
// 应用层 HTTP 服务（CONTRACT §4）。服务端纯 ESM · 仅监听 127.0.0.1
// 生成管线使用 iconv-lite 将 DelphiScript 源码写为 GBK（中文/Ω 描述）。
//
// 生成链路：/api/build 不再自己拼 emitAltiumJob，而是以子进程方式执行
//   node altium/run-stages.mjs <C编号>     （cwd = 工程根）
// 该脚本负责：EasyEDA 数据接口取元件 → 本地生成 out\<C>_SCH.SchDoc / _PCB.PcbDoc
//             → 回读解析 → 每个阶段一个全新 Altium 进程用脚本 API 生成/合并
//               SchLib / PcbLib（全程无浏览器、无 UIA、无鼠标点击）→ 打印 COUNT/DONE/RESULT。
// 服务只做输入解析、实时搬运日志、分类失败原因、汇总产物。
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createUpdateChecker } from './lib/update-check.mjs';
import { renderSymbolSvg, renderFootprintSvg } from './lib/preview-svg.mjs';

// ───────────────────────────── 基础配置 ─────────────────────────────
const APP_DIR = path.dirname(fileURLToPath(import.meta.url)); // <root>/app
const ROOT_DIR = path.dirname(APP_DIR);                        // <root>
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const LIB_DIR = path.join(APP_DIR, 'lib');
const PIPELINE_SCRIPT = path.join(ROOT_DIR, 'altium', 'run-stages.mjs');

const HOST = '127.0.0.1';

// Altium Designer 主程序：优先级 环境变量 ALTIUM_EXE > 页面保存的配置 > 默认值。
// 页面里可随时改，保存后写进 state 目录的 ui-prefs.json，关闭程序/重启服务都不会丢。
const DEFAULT_ALTIUM_EXE = 'E:\\AD\\AD\\X2.EXE';
const ALTIUM_EXE_ENV = String(process.env.ALTIUM_EXE || '').trim();

// 管线的输出位置是写死的（altium/run-stages.mjs 只认 <cwd>/out 与 <cwd>/library/MyLib.*，
// 没有提供 OUT_DIR/LIB_* 之类的环境变量），所以这里如实声明“生效路径”，不假装可配。
const DEFAULTS = {
  outDir: path.join(ROOT_DIR, 'out'),
  schLib: path.join(ROOT_DIR, 'library', 'MyLib.SchLib'),
  pcbLib: path.join(ROOT_DIR, 'library', 'MyLib.PcbLib'),
  altiumExe: DEFAULT_ALTIUM_EXE,
};
// altium/run-stages.mjs 从这些环境变量读输出位置；请求里的三个路径就通过它们传给管线
const PATH_ENV = { outDir: 'OUT_DIR', schLib: 'LIB_SCH', pcbLib: 'LIB_PCB' };

// ─────────────────────── UI 常用路径（服务端持久化） ───────────────────────
// 浏览器 localStorage 会随端口/站点数据清理而丢失（便携版尤其明显），
// 所以把「常用目录 / 常用 SchLib / 常用 PcbLib」以及上次使用的路径写到
// 启动器同一个 state 目录；关闭程序、重启服务后仍然保留。
const PREF_KEYS = ['outDir', 'schLib', 'pcbLib', 'altiumExe'];
function expandEnvVars(value) {
  return String(value).replace(/%([^%]+)%/g, (all, name) => {
    const v = process.env[name] ?? process.env[name.toUpperCase()];
    return v == null ? all : v;
  });
}
function resolveStateDir() {
  let dir = String(process.env.LCEDA2ALTIUM_STATE_DIR || '').trim();
  if (!dir) {
    try {
      const marker = path.join(ROOT_DIR, 'state-dir.txt');
      if (fs.existsSync(marker)) dir = fs.readFileSync(marker, 'utf8').trim();
    } catch { /* 没有 state-dir.txt 就用下面的默认值 */ }
  }
  if (dir) dir = expandEnvVars(dir);
  if (!dir) dir = path.join(process.env.LOCALAPPDATA || process.env.HOME || ROOT_DIR, 'LCEDA2Altium');
  return path.resolve(dir);
}
const PREFS_FILE = path.join(resolveStateDir(), 'ui-prefs.json');
const emptyPrefs = () => ({
  paths: {}, lists: { outDir: [], schLib: [], pcbLib: [], altiumExe: [] }, options: {},
});

function cleanPathList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const v = item.trim();
    if (!v || v.length > 1024) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= 20) break;
  }
  return out;
}
/** Merge a partial payload into `base`; only known keys/types are kept. */
function cleanPrefs(input, base = emptyPrefs()) {
  const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  if (src.paths && typeof src.paths === 'object') {
    for (const key of PREF_KEYS) {
      if (typeof src.paths[key] === 'string' && src.paths[key].trim()) {
        base.paths[key] = src.paths[key].trim().slice(0, 1024);
      }
    }
  }
  if (src.lists && typeof src.lists === 'object') {
    for (const key of PREF_KEYS) {
      if (Array.isArray(src.lists[key])) base.lists[key] = cleanPathList(src.lists[key]);
    }
  }
  if (src.options && typeof src.options === 'object') {
    base.options.keepDocs = src.options.keepDocs === true;
    base.options.makePartLibs = src.options.makePartLibs === true;
  }
  return base;
}
async function readPrefs() {
  try {
    return cleanPrefs(JSON.parse(await fsp.readFile(PREFS_FILE, 'utf8')));
  } catch {
    return emptyPrefs();
  }
}
async function writePrefs(prefs) {
  await fsp.mkdir(path.dirname(PREFS_FILE), { recursive: true });
  const tmp = PREFS_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(prefs, null, 2), 'utf8');
  await fsp.rename(tmp, PREFS_FILE);
}

/** 实际生效的 Altium 可执行文件：环境变量 > 页面保存值 > 默认值。 */
function resolveAltiumExe(prefs) {
  if (ALTIUM_EXE_ENV) return { exe: expandEnvVars(ALTIUM_EXE_ENV), source: 'env' };
  const saved = String((prefs && prefs.paths && prefs.paths.altiumExe) || '').trim();
  if (saved) return { exe: expandEnvVars(saved), source: 'prefs' };
  return { exe: DEFAULT_ALTIUM_EXE, source: 'default' };
}
const ALTIUM_SOURCE_LABEL = { env: '环境变量 ALTIUM_EXE', prefs: '页面配置', default: '默认值' };
/** 给 UI 用的配置快照：生效路径、来源、文件是否存在。 */
async function altiumInfo() {
  const { exe, source } = resolveAltiumExe(await readPrefs());
  let exists = false;
  try { exists = (await fsp.stat(exe)).isFile(); } catch { exists = false; }
  return { path: exe, source, sourceLabel: ALTIUM_SOURCE_LABEL[source], exists, default: DEFAULT_ALTIUM_EXE };
}

const SEARCH_TIMEOUT_MS = 30000;
const DATA_TIMEOUT_MS = 60000;
// 选中候选后右侧显示符号/封装预览：数据只读，渲染结果缓存 10 分钟，
// 避免在候选列表里来回点时重复打 EasyEDA 接口。
const PREVIEW_TIMEOUT_MS = 30000;
const PREVIEW_CACHE_TTL_MS = 10 * 60 * 1000;
const PREVIEW_CACHE_MAX = 40;
const PIPELINE_TIMEOUT_MS = positiveInt(process.env.PIPELINE_TIMEOUT_MS) ?? 20 * 60 * 1000;
const PICK_SCRIPT = path.join(ROOT_DIR, 'tools', 'pick-path.ps1');
const PICK_TIMEOUT_MS = 10 * 60 * 1000;
const PICK_MODES = new Set(['folder', 'schlib', 'pcblib', 'exe']);
const MAX_LOG_LINES = 3000;
const LOG_TAIL_LINES = 400;
const KEEP_JOBS = 20;
const LCSC_RE = /^c\d+$/i;

const JOB_STEP_NAMES = ['解析输入', '获取元件数据并生成文档', 'Altium 脚本 PcbLib', 'Altium 脚本 SchLib', '校验产物'];

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const PORT = positiveInt(cliFlagValue('--port')) ?? positiveInt(process.env.PORT) ?? 43180;
const OPEN_BROWSER = process.argv.includes('--open');
const APP_VERSION = '1.0.0';
const STARTED_AT = new Date().toISOString();

// 更新检查：比对远端 origin 的版本 tag 与本地当前 tag；结果缓存 10 分钟。
// 它只读（git ls-remote，不 fetch、不改本地仓库），页面拿到结果后弹窗提示，
// 用户可以「暂不更新」或「忽略此版本」，服务端不会自动更新代码。
const UPDATER = createUpdateChecker({
  rootDir: ROOT_DIR,
  stateDir: resolveStateDir(),
  appVersion: APP_VERSION,
});

// ───────────────────────── 数据层（延迟加载） ─────────────────────────
const LAYERS = {
  data: { file: 'fetch-component.mjs', label: '数据层', contract: '§2',
    exports: ['searchComponents', 'resolveComponent', 'fetchComponentModel'] },
};
const layerCache = new Map();

function layerMissing(spec) {
  const err = new Error(
    spec.label + '模块缺失：app/lib/' + spec.file + ' 尚未就绪' +
    '（契约 ' + spec.contract + ' 由对应模块提供）。服务本身可正常启动，' +
    '该功能待模块文件到位后自动可用，无需重启。');
  err.code = 'LAYER_MISSING';
  return err;
}

async function loadLayer(key) {
  if (layerCache.has(key)) return layerCache.get(key);
  const spec = LAYERS[key];
  const absPath = path.join(LIB_DIR, spec.file);

  let stat = null;
  try { stat = await fsp.stat(absPath); } catch { /* 不存在 */ }
  if (!stat || !stat.isFile()) throw layerMissing(spec);

  let mod;
  try {
    mod = await import(pathToFileURL(absPath).href);
  } catch (err) {
    const e = new Error(spec.label + '模块加载失败：app/lib/' + spec.file + ' → ' + err.message);
    e.code = 'LAYER_LOAD_FAILED';
    throw e;
  }
  const missing = spec.exports.filter((name) => typeof mod[name] !== 'function');
  if (missing.length) {
    const e = new Error(spec.label + '模块缺少导出函数：' + missing.join(', ') +
      '（app/lib/' + spec.file + '，契约 ' + spec.contract + '）');
    e.code = 'LAYER_BAD_EXPORTS';
    throw e;
  }
  layerCache.set(key, mod);
  return mod;
}

// ───────────────────────────── 作业管理 ─────────────────────────────
/** @type {Map<string, any>} */
const jobs = new Map();
let activeJobId = null;
// 同一时刻只允许一个原生文件选择框（它们会抢焦点，且用户只能操作一个）。
let pickInFlight = false;

const nowMs = () => Date.now();

function createJob({ query, requested, options }) {
  const id = nowMs().toString(36) + '-' + randomUUID().slice(0, 8);
  const job = {
    id, query,
    state: 'running',
    createdAt: nowMs(),
    finishedAt: null,
    lcsc: null,
    steps: JOB_STEP_NAMES.map((name) => ({ name, status: 'pending', detail: '' })),
    artifacts: [],
    log: [],
    error: null,
    options: options || { keepDocs: false, makePartLibs: false },
    // 先按请求回显；管线跑完后用 RESULT_JSON 里的真实生效值覆盖
    paths: {
      outDir: requested.outDir,
      schLib: requested.schLib,
      pcbLib: requested.pcbLib,
      requested,
    },
    result: null,
    counts: null,
    reason: null,
    pipeline: { script: PIPELINE_SCRIPT, cwd: ROOT_DIR, pid: null, exitCode: null },
    _problems: [],
    _stageErrors: [],
  };
  jobs.set(id, job);
  activeJobId = id;
  trimJobs();
  return job;
}

function trimJobs() {
  if (jobs.size <= KEEP_JOBS) return;
  for (const [id, job] of jobs) {
    if (jobs.size <= KEEP_JOBS) break;
    if (id !== activeJobId && job.state !== 'running') jobs.delete(id);
  }
}

function setStep(job, name, status, detail = '') {
  let step = job.steps.find((s) => s.name === name);
  if (!step) { step = { name, status, detail }; job.steps.push(step); }
  step.status = status;
  if (detail) step.detail = detail;
  if (status === 'running') step.startedAt = nowMs();
  if (status === 'ok' || status === 'error' || status === 'warn') step.endedAt = nowMs();
}

function stepStatus(job, name) {
  const s = job.steps.find((x) => x.name === name);
  return s ? s.status : 'pending';
}

function logLine(job, text) {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    job.log.push('[' + hh + ':' + mm + ':' + ss + '] ' + raw.replace(/\s+$/, ''));
  }
  if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
}

function jobView(job) {
  return {
    ok: true,
    jobId: job.id,
    state: job.state,
    query: job.query,
    lcsc: job.lcsc,
    paths: job.paths,
    counts: job.counts,
    reason: job.reason,
    pipeline: job.pipeline,
    steps: job.steps,
    artifacts: job.artifacts,
    log: job.log.slice(-LOG_TAIL_LINES).join('\n'),
    error: job.error,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    elapsedMs: (job.finishedAt ?? nowMs()) - job.createdAt,
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function readableError(err) {
  if (err == null) return '未知错误';
  return err instanceof Error ? (err.message || String(err)) : String(err);
}

async function ensureDir(dir, label) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    return true;
  } catch (err) {
    throw new Error('无法创建' + label + '目录：' + dir + ' → ' + err.message);
  }
}

// ───────────────────────────── 产物清单 ─────────────────────────────
function artifactSpecs(lcsc, paths) {
  // Intermediates (SchDoc/PcbDoc/_source/job.log) are deleted by the pipeline after
  // a successful run; only the target libraries are deliverables.
  return [
    { name: '原理图库 SchLib', kind: 'lib', path: paths.schLib },
    { name: '封装库 PcbLib', kind: 'lib', path: paths.pcbLib },
  ];
}

async function refreshArtifacts(job) {
  if (!job.lcsc) return;
  const known = new Map(job.artifacts.map((a) => [a.path, a]));
  const specs = artifactSpecs(job.lcsc, job.paths);
  // 管线 RESULT_JSON 里报的产物也并进来（去重）
  const reported = job.result && Array.isArray(job.result.artifacts) ? job.result.artifacts : [];
  for (const extra of reported) {
    if (!extra || typeof extra.path !== 'string') continue;
    const full = path.resolve(extra.path);
    if (!specs.some((s) => path.resolve(s.path) === full)) {
      specs.push({ name: path.basename(full), kind: 'pipeline', path: full });
    }
  }
  for (const spec of specs) {
    let item = known.get(spec.path);
    if (!item) {
      item = { name: spec.name, kind: spec.kind, path: spec.path, exists: false, size: 0, mtime: 0 };
      job.artifacts.push(item);
      known.set(spec.path, item);
    }
    try {
      const st = await fsp.stat(spec.path);
      item.exists = st.isFile();
      item.size = st.isFile() ? st.size : 0;
      item.mtime = st.isFile() ? st.mtimeMs : 0;
    } catch {
      item.exists = false;
      item.size = 0;
      item.mtime = 0;
    }
  }
}

// ───────────────────── 管线输出 → 步骤/失败分类 ─────────────────────
const STAGE_STEP = {
  schlib_part: 'Altium 脚本 SchLib', schlib: 'Altium 脚本 SchLib',
  pcblib_part: 'Altium 脚本 PcbLib', pcblib: 'Altium 脚本 PcbLib',
};

function handlePipelineLine(job, line) {
  const t = line.replace(/\s+$/, '');
  if (!t.trim()) return;
  logLine(job, t);
  const trimmed = t.trim();

  // 结构化的最终结果（管线最后一行），优先于所有文本启发
  if (trimmed.startsWith('RESULT_JSON ')) {
    try {
      const obj = JSON.parse(trimmed.slice('RESULT_JSON '.length));
      job.result = obj;
      if (obj && obj.lcsc) job.lcsc = obj.lcsc;
      if (obj && obj.ok === true) {
        if (obj.outDir) job.paths.outDir = obj.outDir;
        if (obj.schLib) job.paths.schLib = obj.schLib;
        if (obj.pcbLib) job.paths.pcbLib = obj.pcbLib;
        if (obj.counts) job.counts = obj.counts;
        setStep(job, '校验产物', 'ok', '管线自检通过（RESULT_JSON ok）');
      } else if (obj && obj.reason) {
        job.reason = String(obj.reason);
      }
    } catch {
      logLine(job, '（RESULT_JSON 解析失败，这一行已忽略）');
    }
    return;
  }

  if (/^model: /.test(trimmed)) {
    setStep(job, '获取元件数据并生成文档', 'running', trimmed.slice(0, 160));
  } else if (/^P1 source=easyeda-api/.test(trimmed)) {
    const sch = trimmed.match(/sch=(\d+)B/);
    const pcb = trimmed.match(/pcb=(\d+)B/);
    setStep(job, '获取元件数据并生成文档', 'ok',
      '已生成并解析 SchDoc/PcbDoc' + (sch && pcb ? '（' + sch[1] + ' / ' + pcb[1] + ' 字节）' : '')
      + '；临时文档成功后会清理');
  } else if (/^STAGE (\w+) ok=(true|false)/.test(trimmed)) {
    const m = trimmed.match(/^STAGE (\w+) ok=(true|false)(?:.*elapsed=(\d+)ms)?/);
    const name = STAGE_STEP[m[1]] || ('Altium 阶段 ' + m[1]);
    const okStage = m[2] === 'true';
    setStep(job, name, okStage ? 'ok' : 'error',
      okStage ? (m[3] ? '耗时 ' + (Number(m[3]) / 1000).toFixed(0) + ' 秒' : '完成') : '该阶段失败，见日志');
  } else if (/^RESULT: FAILED at stage (\w+)/.test(trimmed)) {
    const stage = trimmed.match(/^RESULT: FAILED at stage (\w+)/)[1];
    const name = STAGE_STEP[stage] || ('Altium 阶段 ' + stage);
    if (stepStatus(job, name) !== 'error') setStep(job, name, 'error', '该阶段失败');
  } else if (/^RESULT: FAILED assertions/.test(trimmed)) {
    setStep(job, '校验产物', 'error', '产物断言未通过');
  } else if (/^RESULT: PASS/.test(trimmed)) {
    setStep(job, '校验产物', 'ok', '全部断言通过');
  }

  if (/^PROBLEM: /.test(trimmed)) job._problems.push(trimmed.replace(/^PROBLEM: /, ''));
  if (/^error: /.test(trimmed)) job._stageErrors.push(trimmed.replace(/^error: /, ''));
}

/** 从 stderr 里挑一条“有意义”的原文，跳过 node 版本号与堆栈帧。 */
function bestStderrLine(job) {
  const lines = job._stageErrors.filter((l) =>
    !/^\[stderr\]\s*(at |return |file:\/\/\/|Node\.js v|\^|\s*$)/.test(l));
  return lines.find((l) => /^\[stderr\]\s*Error: /.test(l))
    || lines.find((l) => /easyeda api error|Error:|error:/i.test(l))
    || lines.slice(-1)[0] || '';
}

/** 管线因为“已有 Altium 在运行”而主动中止时，给出一条明确提示（不当普通失败处理）。 */
function altiumBusyMessage(job, { code }) {
  const text = job.log.join('\n') + '\n' + (job.reason || '');
  const hit = code === 2 || /检测到有?\s*Altium\s*(正在运行|进程在运行)/.test(text);
  if (!hit) return null;
  const m = text.match(/PID\s*([\d,]+)/);
  return '已中止：检测到 Altium 正在运行' + (m ? '（PID ' + m[1] + '）' : '') +
    '。为了不打断你正在编辑的工程，本作业没有启动 Altium，也没有关闭任何已有实例。'
    + '请先保存并关闭 Altium 后重试；如果确实希望由程序接管（会强制结束已有 Altium），'
    + '在启动服务前设置环境变量 ALLOW_KILL_EXISTING=1。';
}

/** 依据管线输出把失败翻译成可读原因（不同原因给不同提示）。 */
function classifyFailure(job, { code, timedOut }) {
  const text = job.log.join('\n');
  const low = text.toLowerCase();
  const tail = bestStderrLine(job);

  if (timedOut) {
    return '管线超时（' + Math.round(PIPELINE_TIMEOUT_MS / 60000) + ' 分钟）：已终止子进程。'
      + '常见原因是 EasyEDA 数据接口慢、Altium 冷启动慢或弹窗卡住；可用环境变量 PIPELINE_TIMEOUT_MS 放宽上限。';
  }
  if (/未保存文档/.test(text)) {
    return 'Altium 里有未保存文档：请先按 Ctrl+S 保存（不用关闭 Altium），再重试。';
  }
  // 元件根本不存在：管线在取模型时就抛了
  const notFound = /component not found|not an lcsc c-number|easyeda api error for c\d+: code=404/.test(low);
  if (notFound) {
    return '元件不存在：立创商城查不到「' + (job.lcsc || job.query) + '」（上游返回 Component not found）。'
      + '请确认 C 编号是否正确，或先用搜索框按名称找编号。'
      + (tail ? ' 原文：' + tail : '');
  }
  if (/easyeda api|network error|fetch failed|enotfound|etimedout|econnreset|http 403|http 429/.test(low)) {
    return '立创数据接口请求失败（网络、限流或接口变更）。请检查网络后重试，或直接输入 C 编号。'
      + (tail ? ' 原文：' + tail : '');
  }
  if (/生成的 schdoc|生成的 pcbdoc|doc parse|parse failed|文档生成/.test(low)) {
    return 'Altium 文档生成/回读校验失败：生成的 SchDoc/PcbDoc 与元件数据不一致。'
      + '请看上面的 DOCS 日志与 jobs\\' + (job.lcsc || '<C编号>') + '\\parsed-docs.json。'
      + (tail ? ' 原文：' + tail : '');
  }
  if (/failed at stage schlib|failed at stage pcblib/.test(low)) {
    if (job.altiumPresent === false) {
      return 'Altium 未安装或路径不对：找不到 ' + (job.altiumExe || DEFAULT_ALTIUM_EXE) + '。'
        + '请在页面「输出位置 → Altium Designer 程序」里改成正确的 X2.EXE 路径（保存后重启仍生效），'
        + '或用环境变量 ALTIUM_EXE 指定。';
    }
    const stage = /failed at stage (\w+)/.exec(low)[1];
    return 'Altium 脚本阶段失败（' + stage + '）：Altium 已启动但脚本没跑完，通常是弹窗/超时/对话框拦住。'
      + '详见上面的 STAGE 日志与实时日志（中间文件在成功后清理）。'
      + (tail ? ' 原文：' + tail : '');
  }
  if (/failed assertions/.test(low) || job._problems.length) {
    return '产物断言未通过：' + (job._problems.slice(0, 3).join('；') || '见日志 PROBLEM 行')
      + (job._problems.length > 3 ? ' 等 ' + job._problems.length + ' 条' : '');
  }
  return '管线失败（退出码 ' + code + '）' + (tail ? '：' + tail : '，详见日志。')
    + '（完整输出见下面的实时日志；中间文件在成功后会清理）';
}

// ───────────────────────────── 管线执行 ─────────────────────────────
// Windows 上子进程的 stderr 可能是 GBK（PowerShell/Altium），UTF-8 解不出来就退回 GBK。
const utf8Decoder = new TextDecoder('utf-8');
let gbkDecoder = null;
try { gbkDecoder = new TextDecoder('gbk'); } catch { gbkDecoder = null; }

function decodeMaybeGbk(buf) {
  const text = utf8Decoder.decode(buf);
  if (gbkDecoder && text.includes('\uFFFD')) {
    try {
      const alt = gbkDecoder.decode(buf);
      if (alt && !alt.includes('\uFFFD')) return alt;
    } catch { /* 保留 utf8 结果 */ }
  }
  return text;
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    try {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    } catch { resolve(); }
  });
}

function runPipeline(job, lcsc, paths, options = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    env[PATH_ENV.outDir] = paths.outDir;
    env[PATH_ENV.schLib] = paths.schLib;
    env[PATH_ENV.pcbLib] = paths.pcbLib;
    env.KEEP_DOCS = options.keepDocs ? '1' : '0';
    env.MAKE_PART_LIBS = options.makePartLibs ? '1' : '0';
    // 页面里配置的 Altium 路径通过环境变量传给管线（run-stages/emit-*/run-altium 都读它）。
    env.ALTIUM_EXE = job.altiumExe || DEFAULT_ALTIUM_EXE;
    // UI 不暴露 fixture 开关：只有运维在服务进程环境里显式设置 ALLOW_FIXTURE=1 才会用 test/tmp-out 的调试数据
    delete env.ALLOW_FIXTURE;
    const child = spawn(process.execPath, [PIPELINE_SCRIPT, lcsc], {
      cwd: ROOT_DIR,
      windowsHide: true,
      env,
    });
    job.pipeline.pid = child.pid;

    let pending = '';
    let timedOut = false;
    const timer = setTimeout(async () => {
      timedOut = true;
      logLine(job, '管线超过 ' + Math.round(PIPELINE_TIMEOUT_MS / 1000) + ' 秒未结束，终止子进程…');
      await killTree(child.pid);
    }, PIPELINE_TIMEOUT_MS);

    child.stdout.on('data', (buf) => {
      pending += decodeMaybeGbk(buf);
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i).replace(/\r$/, '');
        pending = pending.slice(i + 1);
        handlePipelineLine(job, line);
      }
    });

    child.stderr.on('data', (buf) => {
      for (const line of decodeMaybeGbk(buf).split(/\r?\n/)) {
        if (!line.trim()) continue;
        job._stageErrors.push('[stderr] ' + line.trim());
        logLine(job, '[stderr] ' + line);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error('无法启动管线进程：' + err.message));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (pending.trim()) handlePipelineLine(job, pending);
      job.pipeline.exitCode = code;
      job.pipeline.signal = signal;
      resolve({ code, signal, timedOut });
    });
  });
}

async function resolveToLcsc(job) {
  const q = job.query.trim();
  if (LCSC_RE.test(q)) {
    const lcsc = 'C' + q.slice(1);
    logLine(job, '输入是立创编号，直接使用：' + lcsc);
    return lcsc;
  }
  logLine(job, '输入不是 C 编号，用数据层把名称解析成编号：' + q);
  setStep(job, '解析输入', 'running', '按名称解析：' + q);
  let data;
  try {
    data = await loadLayer('data');
  } catch (err) {
    throw new Error('按名称解析需要数据层：' + readableError(err) +
      '；也可以直接输入立创编号（C 开头）绕过这一步。');
  }
  let resolved;
  try {
    resolved = await withTimeout(data.resolveComponent(q), DATA_TIMEOUT_MS,
      '解析名称超时（' + Math.round(DATA_TIMEOUT_MS / 1000) + ' 秒），请检查网络或直接填 C 编号');
  } catch (err) {
    throw new Error('未找到元件「' + q + '」：' + readableError(err) +
      '。请换个名称，或直接输入立创编号（C 开头）。');
  }
  const chosen = resolved && resolved.chosen;
  if (!chosen || !chosen.lcsc) {
    throw new Error('未找到元件「' + q + '」：数据层没有返回可用候选。请换个名称，或直接输入立创编号（C 开头）。');
  }
  logLine(job, '名称解析结果：' + chosen.lcsc + ' ' + (chosen.mpn || '') + ' ' + (chosen.package || ''));
  return chosen.lcsc;
}

// ───────────────────────────── 作业主流程 ─────────────────────────────
async function runBuildJob(job) {
  try {
    logLine(job, '作业开始：输入=' + job.query);
    logLine(job, '执行管线：node altium/run-stages.mjs <C编号>（cwd=' + ROOT_DIR + '）');
    logLine(job, '本次输出目录：' + job.paths.outDir);
    logLine(job, '本次原理图库：' + job.paths.schLib);
    logLine(job, '本次封装库  ：' + job.paths.pcbLib);

    const altium = resolveAltiumExe(await readPrefs());
    job.altiumExe = altium.exe;
    logLine(job, '本次 Altium：' + altium.exe + '（来源：' + ALTIUM_SOURCE_LABEL[altium.source] + '）');
    try {
      const st = await fsp.stat(altium.exe);
      job.altiumPresent = st.isFile();
    } catch { job.altiumPresent = false; }
    if (!job.altiumPresent) {
      logLine(job, '警告：未找到 ' + altium.exe + ' —— 文档生成仍可完成，但 Altium 脚本阶段会失败。');
      setStep(job, '环境检查', 'warn', '未找到 ' + altium.exe);
    }

    // 1. 解析输入
    setStep(job, '解析输入', 'running', job.query);
    const lcsc = await resolveToLcsc(job);
    job.lcsc = lcsc;
    job.artifacts = [];
    logLine(job, '目标元件：' + lcsc);
    setStep(job, '解析输入', 'ok', lcsc);
    await refreshArtifacts(job);

    // 2. 跑管线（数据 API → 本地文档 + 四个 Altium 脚本阶段，无浏览器/无点击）
    setStep(job, '获取元件数据并生成文档', 'running', '正在获取元件数据并生成文档…');
    await ensureDir(job.paths.outDir, '输出');
    await ensureDir(path.dirname(job.paths.schLib), '原理图库');
    await ensureDir(path.dirname(job.paths.pcbLib), '封装库');
    const result = await runPipeline(job, lcsc, job.paths, job.options);
    await refreshArtifacts(job);

    const pipelineOk = job.result && job.result.ok === true;
    const busy = altiumBusyMessage(job, result);
    if (busy) {
      for (const name of ['获取元件数据并生成文档', 'Altium 脚本 SchLib', 'Altium 脚本 PcbLib']) {
        if (stepStatus(job, name) === 'running') setStep(job, name, 'pending', '未开始（作业已中止）');
      }
      setStep(job, '环境检查', 'error', '检测到 Altium 正在运行 —— 本作业主动中止，没有关闭你的 Altium');
      throw new Error(busy);
    }
    if (result.timedOut) throw new Error(classifyFailure(job, result));
    if (!pipelineOk) {
      if (stepStatus(job, '获取元件数据并生成文档') !== 'ok') {
        setStep(job, '获取元件数据并生成文档', 'error', '文档生成失败');
      }
      for (const name of ['Altium 脚本 SchLib', 'Altium 脚本 PcbLib']) {
        if (stepStatus(job, name) === 'running') setStep(job, name, 'error', '未完成');
      }
      throw new Error(classifyFailure(job, result));
    }
    if (job.counts) {
      logLine(job, '管线自检计数：引脚 ' + (job.counts.schPins ?? '?') + ' / 焊盘 ' + (job.counts.pcbPads ?? '?'));
    }
    if (stepStatus(job, '获取元件数据并生成文档') !== 'ok') {
      setStep(job, '获取元件数据并生成文档', 'ok', '已完成');
    }
    for (const name of ['Altium 脚本 SchLib', 'Altium 脚本 PcbLib']) {
      if (stepStatus(job, name) === 'pending') setStep(job, name, 'warn', '管线未报告该阶段');
    }

    // 3. 校验产物
    setStep(job, '校验产物', 'running', '检查磁盘文件');
    await refreshArtifacts(job);
    const docs = job.artifacts.filter((a) => a.kind !== 'log');
    const missing = docs.filter((a) => !a.exists);
    if (missing.length) {
      throw new Error('产物缺失：' + missing.map((a) => a.path).join('；') + '（管线报告成功但文件不在磁盘上）');
    }
    for (const doc of docs) logLine(job, '产物 OK：' + doc.path + '（' + doc.size + ' 字节）');
    setStep(job, '校验产物', 'ok', docs.length + ' 个文件已落盘');

    job.state = 'done';
    logLine(job, '完成：作业 ' + job.id);
  } catch (err) {
    job.state = 'error';
    job.error = readableError(err);
    const running = job.steps.find((s) => s.status === 'running');
    if (running) setStep(job, running.name, 'error', '失败');
    logLine(job, '错误：' + job.error);
    await refreshArtifacts(job).catch(() => {});
  } finally {
    job.finishedAt = nowMs();
    if (activeJobId === job.id) activeJobId = null;
    logLine(job, '作业结束：state=' + job.state + '，耗时 ' + ((job.finishedAt - job.createdAt) / 1000).toFixed(1) + ' 秒');
  }
}

// ───────────────────────────── HTTP 工具 ─────────────────────────────
function sendJson(res, obj, status = 200) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(res.headOnly ? undefined : buf);
}

function sendText(res, status, text) {
  const buf = Buffer.from(text + '\n', 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(res.headOnly ? undefined : buf);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大（上限 ' + Math.round(limit / 1024) + ' KB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return reject(new Error('请求体必须是 JSON 对象'));
        }
        resolve(value);
      } catch {
        reject(new Error('请求体不是合法 JSON：' + raw.slice(0, 120)));
      }
    });
    req.on('error', (err) => reject(new Error('读取请求体失败：' + err.message)));
  });
}

const DEFAULT_HINT = '（不填则用默认值：outDir=' + DEFAULTS.outDir + '，schLib=' +
  DEFAULTS.schLib + '，pcbLib=' + DEFAULTS.pcbLib + '）';

function resolvePathInput(value, fallback) {
  if (typeof value !== 'string') return fallback;
  let v = value.trim();
  if (!v) return fallback;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  if (!v) return fallback;
  return path.resolve(v);
}

// ───────────────────────────── 静态资源 ─────────────────────────────
async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let full = path.resolve(PUBLIC_DIR, rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
    return sendText(res, 403, '403 Forbidden：不允许访问 app/public 之外的路径');
  }
  let stat = null;
  try { stat = await fsp.stat(full); } catch { stat = null; }
  if (stat && stat.isDirectory()) {
    full = path.join(full, 'index.html');
    try { stat = await fsp.stat(full); } catch { stat = null; }
  }
  if (!stat || !stat.isFile()) {
    return sendText(res, 404, '404 Not Found：' + pathname + '（静态资源仅限 app/public 目录）');
  }
  let data;
  try { data = await fsp.readFile(full); }
  catch (err) { return sendText(res, 500, '500 读取文件失败：' + err.message); }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  res.end(res.headOnly ? undefined : data);
}

// ───────────────────────────── API 处理 ─────────────────────────────
/** 只接受本服务页面发起的写请求（避免其它网站偷偷改“忽略此版本”）。 */
function isLocalOrigin(req) {
  const origin = String(req.headers.origin || '');
  return !origin || origin === 'http://' + HOST + ':' + PORT || origin === 'http://localhost:' + PORT;
}

// 启动器用它判断“这个端口上跑的是不是本工程的服务”，并取得 pid 用于停止。
// 服务仅监听 127.0.0.1，返回内容不含敏感信息。
async function apiHealth(res) {
  return sendJson(res, {
    ok: true,
    app: 'lceda2altium',
    version: APP_VERSION,
    pid: process.pid,
    port: PORT,
    root: ROOT_DIR,
    startedAt: STARTED_AT,
    busy: Boolean(activeJobId),
    // 便携版/多副本时，UI 的默认路径必须跟随本实例的根目录，而不是写死原工程路径。
    defaults: DEFAULTS,
    prefsFile: PREFS_FILE,
    altium: await altiumInfo(),
  });
}

// GET /api/prefs -> 常用路径列表、上次使用的三个路径、复选框状态。
async function apiPrefsGet(res) {
  const prefs = await readPrefs();
  return sendJson(res, { ok: true, prefs, defaults: DEFAULTS, file: PREFS_FILE, altium: await altiumInfo() });
}

// POST /api/prefs { prefs?: { paths?, lists?, options? } }
// 也接受不带 prefs 包装的对象。与已保存内容合并，未提供的字段保持不变。
async function apiPrefsPost(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, { ok: false, error: readableError(err) }); }
  const payload = (body.prefs && typeof body.prefs === 'object') ? body.prefs : body;
  try {
    const next = cleanPrefs(payload, await readPrefs());
    await writePrefs(next);
    // 顺带回传生效的 Altium 路径与是否存在，UI 可以立刻提示“路径不对”。
    return sendJson(res, { ok: true, prefs: next, file: PREFS_FILE, altium: await altiumInfo() });
  } catch (err) {
    return sendJson(res, { ok: false, error: '保存常用路径失败：' + readableError(err) });
  }
}

/** 对外只暴露 UI 需要的字段（hasUpdateRaw 是内部比较结果）。 */
function publicUpdateStatus(status) {
  if (!status || typeof status !== 'object') return status;
  const { hasUpdateRaw, ...rest } = status;
  return rest;
}

// GET /api/update -> 缓存的更新状态；缓存过期时在后台刷新，不阻塞页面加载。
async function apiUpdateGet(res) {
  const first = UPDATER.peek();
  if ((!first.result || first.stale) && !first.checking) void UPDATER.refresh().catch(() => {});
  const state = UPDATER.peek();
  const payload = publicUpdateStatus(state.result) || {
    ok: true, supported: null, hasUpdate: false, checking: true, checkedAt: null,
  };
  return sendJson(res, { ...payload, checking: state.checking });
}

// POST /api/update/check -> 强制重新检查（页面上的「检查更新」）。
async function apiUpdateCheck(req, res) {
  if (!isLocalOrigin(req)) return sendJson(res, { ok: false, error: '拒绝跨站请求' }, 403);
  const result = await UPDATER.refresh({ force: true });
  return sendJson(res, publicUpdateStatus(result));
}

// POST /api/update/dismiss { tag, clear? }
//   tag  = 用户选择「忽略此版本」的 tag（写入 state 目录，重启/换浏览器后仍生效）
//   clear=true → 恢复提醒
async function apiUpdateDismiss(req, res) {
  if (!isLocalOrigin(req)) return sendJson(res, { ok: false, error: '拒绝跨站请求' }, 403);
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, { ok: false, error: readableError(err) }); }
  const tag = typeof body.tag === 'string' ? body.tag.trim() : '';
  const clear = body.clear === true;
  if (!clear && !tag) return sendJson(res, { ok: false, error: '缺少要忽略的 tag' });
  if (!clear && tag.length > 128) return sendJson(res, { ok: false, error: 'tag 太长' });
  try {
    const status = await UPDATER.setDismissed(tag, { clear });
    return sendJson(res, { ok: true, status: publicUpdateStatus(status || UPDATER.peek().result) });
  } catch (err) {
    return sendJson(res, { ok: false, error: '保存忽略状态失败：' + readableError(err) });
  }
}

async function apiSearch(url, res) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) {
    return sendJson(res, { ok: false, error: '缺少查询参数 q（元件名称或立创编号，例如 C25804 / 10K 0603）' });
  }
  try {
    const data = await loadLayer('data');
    const candidates = await withTimeout(
      data.searchComponents(q, { limit: 20 }), SEARCH_TIMEOUT_MS,
      '搜索超时（' + Math.round(SEARCH_TIMEOUT_MS / 1000) + ' 秒），请检查网络或换个关键词');
    const list = Array.isArray(candidates) ? candidates : [];
    console.log('[search] ' + q + ' → ' + list.length + ' 条候选');
    return sendJson(res, { ok: true, candidates: list });
  } catch (err) {
    const error = readableError(err);
    console.warn('[search] 失败：' + error);
    return sendJson(res, { ok: false, error });
  }
}

/* ─────────────────── 预览（符号 SchLib / 封装 PcbLib） ─────────────────── */
/** lcsc -> { at, payload }；payload 就是接口返回体（SVG 已渲染），命中直接复用。 */
const previewCache = new Map();

function previewCacheGet(lcsc) {
  const hit = previewCache.get(lcsc);
  if (!hit) return null;
  if (nowMs() - hit.at > PREVIEW_CACHE_TTL_MS) {
    previewCache.delete(lcsc);
    return null;
  }
  return hit.payload;
}

function previewCacheSet(lcsc, payload) {
  previewCache.delete(lcsc);
  previewCache.set(lcsc, { at: nowMs(), payload });
  while (previewCache.size > PREVIEW_CACHE_MAX) {
    const oldest = previewCache.keys().next().value;
    previewCache.delete(oldest);
  }
}

async function apiPreview(url, res) {
  const raw = (url.searchParams.get('lcsc') || url.searchParams.get('q') || '').trim();
  if (!raw) {
    return sendJson(res, { ok: false, error: '缺少查询参数 lcsc（立创编号，例如 C25804）' });
  }
  if (!LCSC_RE.test(raw)) {
    return sendJson(res, { ok: false, error: '预览只支持立创编号（C 开头），收到：' + raw });
  }
  const lcsc = 'C' + raw.slice(1).toUpperCase();

  const cached = previewCacheGet(lcsc);
  if (cached) return sendJson(res, { ...cached, cached: true });

  try {
    const data = await loadLayer('data');
    const model = await withTimeout(
      data.fetchComponentModel(lcsc), PREVIEW_TIMEOUT_MS,
      '预览加载超时（' + Math.round(PREVIEW_TIMEOUT_MS / 1000) + ' 秒），请检查网络后重试');
    if (!model || typeof model !== 'object') {
      return sendJson(res, { ok: false, error: '预览数据为空：' + lcsc });
    }
    const payload = {
      ok: true,
      lcsc: model.lcsc || lcsc,
      mpn: model.mpn || '',
      package: model.package || '',
      value: model.value || '',
      description: model.description || '',
      pinCount: Array.isArray(model.symbol && model.symbol.pins) ? model.symbol.pins.length : 0,
      padCount: Array.isArray(model.footprint && model.footprint.pads) ? model.footprint.pads.length : 0,
      symbolSvg: renderSymbolSvg(model),
      footprintSvg: renderFootprintSvg(model),
    };
    previewCacheSet(lcsc, payload);
    console.log('[preview] ' + lcsc + ' 符号 ' + (payload.symbolSvg ? '✓' : '—') +
      ' 封装 ' + (payload.footprintSvg ? '✓' : '—') +
      '（引脚 ' + payload.pinCount + ' / 焊盘 ' + payload.padCount + '）');
    return sendJson(res, payload);
  } catch (err) {
    const error = readableError(err);
    console.warn('[preview] 失败：' + error);
    return sendJson(res, { ok: false, error: '预览加载失败：' + error });
  }
}

async function apiBuild(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, { ok: false, error: readableError(err) }); }

  const query = typeof body.query === 'string' ? body.query.trim()
    : (typeof body.q === 'string' ? body.q.trim() : '');
  if (!query) {
    return sendJson(res, { ok: false, error: '缺少 query（元件名称或立创编号）' + DEFAULT_HINT });
  }
  if (activeJobId && jobs.get(activeJobId)) {
    const busy = jobs.get(activeJobId);
    const error = '已有作业正在运行（jobId=' + busy.id + '，输入「' + busy.query +
      '」），同一时刻只允许一个作业（Altium 是单实例 GUI），请等待其完成后再派发。';
    console.warn('[build] 拒绝重复派发：' + error);
    return sendJson(res, { ok: false, error, jobId: busy.id });
  }

  const requested = {
    outDir: resolvePathInput(body.outDir, DEFAULTS.outDir),
    schLib: resolvePathInput(body.schLib, DEFAULTS.schLib),
    pcbLib: resolvePathInput(body.pcbLib, DEFAULTS.pcbLib),
  };
  const options = {
    keepDocs: body.keepDocs === true,
    makePartLibs: body.makePartLibs === true,
  };
  const job = createJob({ query, requested, options });
  console.log('[build] 派发作业 ' + job.id + '：' + query + ' options=' + JSON.stringify(options));
  sendJson(res, { ok: true, jobId: job.id, state: job.state, query, paths: job.paths, options: job.options, defaults: DEFAULTS });
  void runBuildJob(job);
}

async function apiJob(url, res) {
  const id = (url.searchParams.get('id') || '').trim();
  if (!id) return sendJson(res, { ok: false, error: '缺少查询参数 id（POST /api/build 返回的 jobId）' });
  const job = jobs.get(id);
  if (!job) {
    return sendJson(res, { ok: false, error: '作业不存在：' + id + '（作业记录仅保存在内存中，服务重启后旧 id 失效）' });
  }
  await refreshArtifacts(job).catch(() => {});
  return sendJson(res, jobView(job));
}

// POST /api/pick-path { mode: 'folder'|'schlib'|'pcblib', current?: string }
// 浏览器出于安全限制拿不到本地绝对路径，所以由本机服务弹出 Windows 原生选择框。
// 同时只允许一个选择框；页面关闭时把子进程一起结束。
async function apiPickPath(req, res) {
  const origin = String(req.headers.origin || '');
  if (origin && origin !== 'http://' + HOST + ':' + PORT && origin !== 'http://localhost:' + PORT) {
    return sendJson(res, { ok: false, error: '拒绝跨站请求' }, 403);
  }
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return sendJson(res, { ok: false, error: '请求必须是 application/json' }, 415);
  }
  if (pickInFlight) {
    return sendJson(res, { ok: false, error: '已有一个文件选择框打开，请先完成或取消它。' }, 409);
  }
  pickInFlight = true;

  let child = null;
  let timer = null;
  const release = () => {
    pickInFlight = false;
    if (timer) { clearTimeout(timer); timer = null; }
  };
  const reply = (status, payload) => {
    if (!res.headersSent && !res.destroyed) sendJson(res, payload, status);
  };
  const killChild = () => {
    if (!child || !child.pid) return;
    try { child.kill(); } catch { /* already gone */ }
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
    catch { /* ignore */ }
  };

  try {
    const body = await readJsonBody(req);
    const mode = String(body.mode || '');
    if (!PICK_MODES.has(mode)) {
      release();
      return reply(400, { ok: false, error: '未知的选择类型：' + mode });
    }
    const fallback = mode === 'folder' ? DEFAULTS.outDir
      : (mode === 'schlib' ? DEFAULTS.schLib
        : (mode === 'pcblib' ? DEFAULTS.pcbLib : resolveAltiumExe(await readPrefs()).exe));
    const target = resolvePathInput(body.current, fallback);
    const initialDir = mode === 'folder' ? target : path.dirname(target);
    const fileName = mode === 'folder' ? '' : path.basename(target);

    const args = ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', PICK_SCRIPT, '-Mode', mode, '-InitialDir', initialDir];
    if (fileName) args.push('-FileName', fileName);
    child = spawn('powershell.exe', args, { windowsHide: true });

    const outcome = await new Promise((resolve) => {
      // Accumulate Buffers: decoding each chunk separately can split a
      // multi-byte UTF-8 character (e.g. a Chinese path) across chunks.
      const outChunks = [];
      const errChunks = [];
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      timer = setTimeout(() => {
        killChild();
        settle({ status: 504, payload: { ok: false, error: '文件选择框等待超时（10 分钟）。' } });
      }, PICK_TIMEOUT_MS);
      child.stdout.on('data', (chunk) => outChunks.push(chunk));
      child.stderr.on('data', (chunk) => errChunks.push(chunk));
      child.on('error', (err) => settle({
        status: 500, payload: { ok: false, error: '无法启动文件选择框：' + err.message },
      }));
      child.on('close', (code) => {
        const stdout = Buffer.concat(outChunks).toString('utf8');
        const stderr = Buffer.concat(errChunks).toString('utf8');
        if (code === 0) {
          const selected = stdout.replace(/\r/g, '').split('\n')
            .map((s) => s.trim()).filter(Boolean).pop() || '';
          settle({ status: 200, payload: { ok: true, path: selected } });
        } else if (code === 2) {
          settle({ status: 200, payload: { ok: true, path: '', canceled: true } });
        } else {
          settle({
            status: 500,
            payload: {
              ok: false,
              error: '文件选择框异常退出（code=' + code + '）' +
                (stderr.trim() ? '：' + stderr.trim() : ''),
            },
          });
        }
      });
      // 页面关闭/刷新时把选择框一起关掉，避免它留在桌面上。
      res.on('close', () => {
        if (!res.writableEnded) killChild();
        settle({ status: 499, payload: { ok: false, error: '页面已关闭' } });
      });
    });

    release();
    return reply(outcome.status, outcome.payload);
  } catch (err) {
    release();
    return reply(400, { ok: false, error: readableError(err) });
  }
}

async function handle(req, res) {
  res.headOnly = req.method === 'HEAD';
  let url;
  try {
    url = new URL(req.url || '/', 'http://' + HOST + ':' + PORT);
  } catch {
    return sendText(res, 400, '400 请求地址不合法');
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return sendText(res, 400, '400 请求地址编码不合法'); }

  const method = req.method || 'GET';
  if (method === 'GET' || method === 'HEAD') {
    if (pathname === '/api/health') return apiHealth(res);
    if (pathname === '/api/prefs') return apiPrefsGet(res);
    if (pathname === '/api/search') return apiSearch(url, res);
    if (pathname === '/api/preview') return apiPreview(url, res);
    if (pathname === '/api/job') return apiJob(url, res);
    if (pathname === '/api/update') return apiUpdateGet(res);
    if (pathname === '/api/build') {
      return sendJson(res, { ok: false, error: '请使用 POST 调用 /api/build' });
    }
    if (pathname.startsWith('/api/')) {
      return sendJson(res, { ok: false, error: '未知接口：' + pathname + '（可用：/api/health、/api/prefs、/api/search、/api/preview、/api/build、/api/job、/api/pick-path、/api/update）' });
    }
    return serveStatic(req, res, pathname);
  }
  if (method === 'POST') {
    if (pathname === '/api/prefs') return apiPrefsPost(req, res);
    if (pathname === '/api/pick-path') return apiPickPath(req, res);
    if (pathname === '/api/build') return apiBuild(req, res);
    if (pathname === '/api/update/check') return apiUpdateCheck(req, res);
    if (pathname === '/api/update/dismiss') return apiUpdateDismiss(req, res);
    if (pathname.startsWith('/api/')) {
      return sendJson(res, { ok: false, error: '不支持的方法：POST ' + pathname });
    }
    return sendText(res, 405, '405 Method Not Allowed');
  }
  return sendJson(res, { ok: false, error: '不支持的方法：' + method + ' ' + pathname });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[error] 未捕获异常：', err);
    if (res.headersSent) { res.destroy(); return; }
    sendJson(res, { ok: false, error: '服务器内部错误：' + readableError(err) }, 500);
  });
});

// ───────────────────────────── 启动 ─────────────────────────────
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('');
    console.error('[启动失败] 端口 ' + PORT + ' 已被占用，服务没有启动。');
    console.error('  处理办法：换一个端口启动，例如');
    console.error('    CMD       :  set PORT=43181 && node app/server.mjs');
    console.error('    PowerShell:  $env:PORT=43181; node app/server.mjs');
    console.error('  排查占用端口的进程：netstat -ano | findstr :' + PORT);
    console.error('');
    process.exit(1);
  }
  if (err && err.code === 'EACCES') {
    console.error('[启动失败] 端口 ' + PORT + ' 无权限监听（可能被系统保留或权限不足），请用 PORT 换一个端口。');
    process.exit(1);
  }
  console.error('[启动失败] ' + (err && err.message ? err.message : String(err)));
  console.error(err && err.stack ? err.stack : '');
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  const base = 'http://' + HOST + ':' + PORT + '/';
  console.log('');
  console.log('  立创元件 → Altium  本地服务已启动');
  console.log('  地址：' + base);
  console.log('  工作目录：' + ROOT_DIR);
  console.log('  执行管线：node altium/run-stages.mjs <C编号>（数据 API → 本地文档 + Altium 脚本，无浏览器/无点击）');
  console.log('  默认输出：' + DEFAULTS.outDir + '（页面里可改，经 OUT_DIR/LIB_SCH/LIB_PCB 传给管线）');
  console.log('  默认目标库：' + DEFAULTS.schLib + ' / ' + DEFAULTS.pcbLib);
  const altium = await altiumInfo();
  console.log('  Altium 程序：' + altium.path + '（' + (altium.exists ? '已找到' : '未找到') +
    '，来源：' + altium.sourceLabel + '；页面可改，保存在 ' + PREFS_FILE + '）');
  for (const key of Object.keys(LAYERS)) {
    const spec = LAYERS[key];
    let ready = false;
    try {
      const st = await fsp.stat(path.join(LIB_DIR, spec.file));
      ready = st.isFile();
    } catch { ready = false; }
    console.log('  模块状态：' + spec.label + '（app/lib/' + spec.file + '）' +
      (ready ? ' 已就绪' : ' 缺失，按名称解析会提示"模块缺失"'));
  }
  let pipelineReady = false;
  try { pipelineReady = (await fsp.stat(PIPELINE_SCRIPT)).isFile(); } catch { pipelineReady = false; }
  console.log('  管线状态：altium/run-stages.mjs ' + (pipelineReady ? '已就绪' : '缺失（生成会失败）'));
  // 启动后台检查远端 tag（不阻塞启动）；结果由页面弹窗展示，绝不自动更新代码。
  void UPDATER.refresh().then((r) => {
    if (!r) return;
    if (r.supported === false) {
      console.log('  更新检查：' + (r.reason || '不可用'));
    } else if (r.ok === false) {
      console.log('  更新检查失败：' + r.error + '（页面右上角可手动重试）');
    } else if (r.hasUpdate && r.latest) {
      console.log('  发现新版本：' + r.latest.tag + '（当前 ' +
        ((r.current && r.current.tag) || '未知') + '）—— 页面会弹窗提示，可选择暂不更新');
    } else {
      console.log('  更新检查：已是最新' +
        (r.current && r.current.tag ? '（' + r.current.tag + '）' : ''));
    }
  }).catch(() => { /* 检查失败不影响服务 */ });
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
  if (OPEN_BROWSER) setTimeout(() => openBrowser(base), 300);
});

function openBrowser(target) {
  const cmd = process.platform === 'win32'
    ? { file: 'cmd', args: ['/c', 'start', '', target] }
    : process.platform === 'darwin'
      ? { file: 'open', args: [target] }
      : { file: 'xdg-open', args: [target] };
  try {
    const child = spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => console.warn('[提示] 自动打开浏览器失败，请手动访问 ' + target));
    child.unref();
  } catch {
    console.warn('[提示] 自动打开浏览器失败，请手动访问 ' + target);
  }
}

function cliFlagValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(flag + '='));
  return inline ? inline.slice(flag.length + 1) : null;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n[退出] 正在关闭服务…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
