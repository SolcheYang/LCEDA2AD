'use strict';

const FALLBACK_DEFAULTS = {
  outDir: 'E:\\EDA2Altium\\out',
  schLib: 'E:\\EDA2Altium\\library\\MyLib.SchLib',
  pcbLib: 'E:\\EDA2Altium\\library\\MyLib.PcbLib',
  altiumExe: 'E:\\AD\\AD\\X2.EXE',
};
// Replaced at startup with the running instance's own defaults (/api/health),
// so a portable copy never writes into the original folder's libraries.
let DEFAULTS = { ...FALLBACK_DEFAULTS };

const POLL_MS = 1200;
const STEP_ICON = { pending: '○', running: '◐', ok: '✓', warn: '!', error: '✗' };
const STEP_TEXT = { pending: '等待', running: '进行中', ok: '完成', warn: '警告', error: '失败' };

const $ = (id) => document.getElementById(id);
const el = {
  q: $('q'), searchBtn: $('search-btn'), searchStatus: $('search-status'), candidates: $('candidates'),
  outDir: $('outDir'), outDirSaved: $('outDirSaved'),
  schLib: $('schLib'), schLibSaved: $('schLibSaved'),
  pcbLib: $('pcbLib'), pcbLibSaved: $('pcbLibSaved'),
  altiumExe: $('altiumExe'), altiumExeSaved: $('altiumExeSaved'), altiumStatus: $('altium-status'),
  browseAltiumExe: $('browse-altiumExe'), saveAltiumExe: $('save-altiumExe'), delAltiumExe: $('del-altiumExe'),
  browseOutDir: $('browse-outDir'), saveOutDir: $('save-outDir'), delOutDir: $('del-outDir'),
  browseSchLib: $('browse-schLib'), saveSchLib: $('save-schLib'), delSchLib: $('del-schLib'),
  browsePcbLib: $('browse-pcbLib'), savePcbLib: $('save-pcbLib'), delPcbLib: $('del-pcbLib'),
  pathStatus: $('path-status'),
  keepDocs: $('keepDocs'), makePartLibs: $('makePartLibs'),
  buildBtn: $('build-btn'), jobState: $('job-state'), jobId: $('job-id'), buildError: $('build-error'),
  resetPaths: $('reset-paths'), jobCounts: $('job-counts'),
  steps: $('steps'), log: $('log'), logCopy: $('log-copy'), logFollow: $('log-follow'),
  logCard: $('log-card'), logToggle: $('log-toggle'), progressEmpty: $('progress-empty'),
  previewMeta: $('preview-meta'), previewEmpty: $('preview-empty'),
  previewPanes: $('preview-panes'), previewSymbol: $('preview-symbol'), previewPcb: $('preview-pcb'),
  artifacts: $('artifacts'),
  verChip: $('ver-chip'), updateModal: $('update-modal'), updateClose: $('update-close'),
  updateSub: $('update-sub'), updateNotes: $('update-notes'),
  verCurrent: $('ver-current'), verCurrentMeta: $('ver-current-meta'),
  verLatest: $('ver-latest'), verLatestMeta: $('ver-latest-meta'),
  updateLater: $('update-later'), updateView: $('update-view'), updateCopy: $('update-copy'),
  updateIgnore: $('update-ignore'), updateRestore: $('update-restore'), updateHint: $('update-hint'),
};

let selected = null;
let pollTimer = null;
let currentJobId = null;
let lastLogText = '';
let lastLogLineCount = 0;

function setPaths(paths) {
  el.outDir.value = paths.outDir || DEFAULTS.outDir;
  el.schLib.value = paths.schLib || DEFAULTS.schLib;
  el.pcbLib.value = paths.pcbLib || DEFAULTS.pcbLib;
}
// Do not overwrite a path the user already typed while /api/health was loading.
function setPathsIfUntouched(paths) {
  for (const key of ['outDir', 'schLib', 'pcbLib', 'altiumExe']) {
    const input = el[key];
    if (!input.value || input.value === FALLBACK_DEFAULTS[key]) {
      input.value = paths[key] || FALLBACK_DEFAULTS[key];
    }
  }
}

/* ─────────── 常用路径（localStorage）+ 原生选择框 ─────────── */
const PATH_FIELDS = [
  { key: 'outDir', mode: 'folder', storageKey: 'lceda2altium.outDirs.v1', placeholder: '常用目录…',
    input: el.outDir, select: el.outDirSaved, browseBtn: el.browseOutDir,
    saveBtn: el.saveOutDir, delBtn: el.delOutDir },
  { key: 'schLib', mode: 'schlib', storageKey: 'lceda2altium.schLibs.v1', placeholder: '常用 SchLib…',
    input: el.schLib, select: el.schLibSaved, browseBtn: el.browseSchLib,
    saveBtn: el.saveSchLib, delBtn: el.delSchLib },
  { key: 'pcbLib', mode: 'pcblib', storageKey: 'lceda2altium.pcbLibs.v1', placeholder: '常用 PcbLib…',
    input: el.pcbLib, select: el.pcbLibSaved, browseBtn: el.browsePcbLib,
    saveBtn: el.savePcbLib, delBtn: el.delPcbLib },
  // Altium 主程序路径：改动会写进 state 目录的 ui-prefs.json，重启程序后仍然生效。
  { key: 'altiumExe', mode: 'exe', storageKey: 'lceda2altium.altiumExes.v1', placeholder: '常用 Altium 路径…',
    input: el.altiumExe, select: el.altiumExeSaved, browseBtn: el.browseAltiumExe,
    saveBtn: el.saveAltiumExe, delBtn: el.delAltiumExe },
];

let pathStatusTimer = null;
function setPathStatus(message, isError) {
  if (pathStatusTimer) { clearTimeout(pathStatusTimer); pathStatusTimer = null; }
  if (!message) {
    el.pathStatus.hidden = true;
    el.pathStatus.textContent = '';
    return;
  }
  el.pathStatus.hidden = false;
  el.pathStatus.className = isError ? 'error' : 'hint';
  el.pathStatus.textContent = message;
  if (!isError) pathStatusTimer = setTimeout(() => setPathStatus(''), 4500);
}

/* Altium 主程序路径：显示来源（页面配置 / 环境变量 / 默认值）和文件是否存在。 */
function renderAltiumStatus(info) {
  const node = el.altiumStatus;
  if (!node) return;
  if (!info) { node.hidden = true; node.textContent = ''; return; }
  node.hidden = false;
  node.className = info.exists ? 'hint' : 'error';
  const src = info.source === 'env'
    ? '环境变量 ALTIUM_EXE（优先级最高，界面里的设置不生效）'
    : (info.source === 'prefs' ? '页面保存的配置' : '默认值');
  node.textContent = (info.exists ? '✓ 已找到：' : '✗ 未找到：') + info.path + '　·　来源：' + src;
}
async function refreshAltiumStatus() {
  try {
    const res = await fetch(PREFS_API, { cache: 'no-store' });
    const data = await res.json();
    if (data && data.ok && data.altium) renderAltiumStatus(data.altium);
  } catch { /* 服务未就绪时忽略 */ }
}

const samePath = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/* 常用路径持久化：服务端 state 目录优先（关闭程序后仍然保留），
   localStorage 仅作为兜底与旧版本数据迁移来源。 */
const PREFS_API = '/api/prefs';
let prefs = { paths: {}, lists: { outDir: [], schLib: [], pcbLib: [] }, options: {} };
let prefsLoaded = false;
let prefsTimer = null;

function readLocalSavedPaths(field) {
  try {
    const list = JSON.parse(localStorage.getItem(field.storageKey) || '[]');
    return Array.isArray(list)
      ? list.filter((x) => typeof x === 'string' && x.trim())
        .map((x) => x.trim()).slice(0, 20)
      : [];
  } catch { return []; }
}
function readSavedPaths(field) {
  if (prefsLoaded && prefs.lists && Array.isArray(prefs.lists[field.key])) {
    return prefs.lists[field.key].slice(0, 20);
  }
  return readLocalSavedPaths(field);
}
function mirrorSavedPaths(field, list) {
  try { localStorage.setItem(field.storageKey, JSON.stringify(list.slice(0, 20))); }
  catch { /* localStorage 不可用时静默忽略 */ }
}
function capturePrefsFromUi() {
  prefs.paths = {
    outDir: el.outDir.value.trim(),
    schLib: el.schLib.value.trim(),
    pcbLib: el.pcbLib.value.trim(),
    altiumExe: el.altiumExe ? el.altiumExe.value.trim() : '',
  };
  prefs.options = {
    keepDocs: !!(el.keepDocs && el.keepDocs.checked),
    makePartLibs: !!(el.makePartLibs && el.makePartLibs.checked),
  };
}
function sendPrefs(keepalive) {
  capturePrefsFromUi();
  for (const field of PATH_FIELDS) mirrorSavedPaths(field, prefs.lists[field.key] || []);
  return fetch(PREFS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ prefs }),
    keepalive: keepalive === true,
  }).catch(() => { /* 服务未就绪时忽略，localStorage 仍留有副本 */ });
}
function flushPrefs() {
  if (prefsTimer) { clearTimeout(prefsTimer); prefsTimer = null; }
  return sendPrefs(false);
}
function persistPrefs() {
  if (prefsTimer) clearTimeout(prefsTimer);
  prefsTimer = setTimeout(flushPrefs, 150);
}
function writeSavedPaths(field, list) {
  prefs.lists[field.key] = list.slice(0, 20);
  mirrorSavedPaths(field, prefs.lists[field.key]);
  persistPrefs();
}
/** 载入服务端保存的常用路径、上次使用路径与勾选状态。 */
function applyPrefs(loaded) {
  const lists = { outDir: [], schLib: [], pcbLib: [], altiumExe: [] };
  let migrated = false;
  for (const field of PATH_FIELDS) {
    const serverList = (loaded.lists && Array.isArray(loaded.lists[field.key]))
      ? loaded.lists[field.key] : [];
    const localList = readLocalSavedPaths(field);
    const seen = new Set();
    const merged = [];
    for (const p of [...serverList, ...localList]) {
      const v = String(p || '').trim();
      if (!v || seen.has(v.toLowerCase())) continue;
      seen.add(v.toLowerCase());
      merged.push(v);
      if (merged.length >= 20) break;
    }
    // 服务端没有、本地还留着的条目：说明是旧版本 localStorage 数据，保存回去。
    if (localList.some((p) => !serverList.some((s) => samePath(s, p)))) migrated = true;
    lists[field.key] = merged;
  }
  prefs.lists = lists;
  prefs.paths = (loaded.paths && typeof loaded.paths === 'object') ? { ...loaded.paths } : {};
  prefs.options = (loaded.options && typeof loaded.options === 'object') ? { ...loaded.options } : {};
  prefsLoaded = true;
  for (const key of ['outDir', 'schLib', 'pcbLib', 'altiumExe']) {
    const v = prefs.paths[key];
    if (typeof v !== 'string' || !v.trim()) continue;
    // 不覆盖用户在 /api/prefs 返回前已经手动输入的路径。
    const current = el[key].value.trim();
    const untouched = !current || samePath(current, FALLBACK_DEFAULTS[key]) || samePath(current, DEFAULTS[key]);
    if (untouched) el[key].value = v.trim();
  }
  if (el.keepDocs && typeof prefs.options.keepDocs === 'boolean') el.keepDocs.checked = prefs.options.keepDocs;
  if (el.makePartLibs && typeof prefs.options.makePartLibs === 'boolean') el.makePartLibs.checked = prefs.options.makePartLibs;
  for (const field of PATH_FIELDS) {
    mirrorSavedPaths(field, lists[field.key]);
    renderSavedPaths(field);
  }
  if (migrated) persistPrefs();
}
function renderSavedPaths(field, selectedValue) {
  const list = readSavedPaths(field);
  const current = selectedValue === undefined ? field.select.value : selectedValue;
  field.select.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = field.placeholder;
  field.select.appendChild(ph);
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    field.select.appendChild(opt);
  }
  const restored = list.find((p) => samePath(p, current));
  if (restored) field.select.value = restored;
}
function saveCurrentPath(field) {
  // 资源管理器“复制文件地址”会带引号，保存前去掉。
  const value = field.input.value.trim().replace(/^["']|["']$/g, '').trim();
  if (!value) { setPathStatus('路径为空，无法保存。', true); return; }
  field.input.value = value;
  writeSavedPaths(field, [value, ...readSavedPaths(field).filter((p) => !samePath(p, value))]);
  renderSavedPaths(field, value);
  setPathStatus('已加入常用列表：' + value, false);
}
function deleteSavedPath(field) {
  const value = field.select.value;
  if (!value) { setPathStatus('请先在下拉框中选择要删除的常用路径。', true); return; }
  writeSavedPaths(field, readSavedPaths(field).filter((p) => !samePath(p, value)));
  renderSavedPaths(field, '');
  setPathStatus('已删除：' + value, false);
}

let browseBusy = false;
async function browsePath(field) {
  if (browseBusy) return;
  browseBusy = true;
  for (const f of PATH_FIELDS) f.browseBtn.disabled = true;
  const oldText = field.browseBtn.textContent;
  field.browseBtn.textContent = '选择中…';
  setPathStatus('');
  try {
    const res = await fetch('/api/pick-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ mode: field.mode, current: field.input.value.trim() }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '打开选择框失败');
    if (data.path) {
      field.input.value = data.path;
      setPathStatus('已选择：' + data.path, false);
      capturePrefsFromUi();
      persistPrefs();
      if (field.key === 'altiumExe') setTimeout(refreshAltiumStatus, 400);
    } else {
      setPathStatus('已取消选择。', false);
    }
  } catch (err) {
    setPathStatus('打开文件选择框失败：' + (err && err.message ? err.message : err), true);
  } finally {
    field.browseBtn.textContent = oldText;
    browseBusy = false;
    for (const f of PATH_FIELDS) f.browseBtn.disabled = false;
  }
}

function showError(node, message) {
  if (!message) { node.hidden = true; node.textContent = ''; return; }
  node.hidden = false;
  node.textContent = message;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 退回下面的兼容写法 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

function flash(button) {
  const old = button.textContent;
  button.textContent = '已复制';
  setTimeout(() => { button.textContent = old; }, 1200);
}

/* ─────────────── 搜索 ─────────────── */
async function doSearch() {
  const q = el.q.value.trim();
  selected = null;
  if (!q) {
    el.searchStatus.className = 'hint';
    el.searchStatus.textContent = '请先输入元件名称或立创编号。';
    return;
  }
  el.searchBtn.disabled = true;
  el.searchStatus.className = 'hint';
  el.searchStatus.textContent = '正在搜索「' + q + '」…';
  el.candidates.hidden = true;
  el.candidates.innerHTML = '';
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    const data = await res.json();
    if (!data.ok) {
      el.searchStatus.textContent = '';
      showError(el.searchStatus, data.error || '搜索失败');
      el.searchStatus.className = 'error';
      return;
    }
    renderCandidates(data.candidates || []);
  } catch (err) {
    el.searchStatus.className = 'error';
    el.searchStatus.textContent = '请求后端失败：' + (err && err.message ? err.message : err) + '（服务是否还在运行？）';
  } finally {
    el.searchBtn.disabled = false;
  }
}

function renderCandidates(list) {
  el.candidates.innerHTML = '';
  if (!list.length) {
    el.searchStatus.className = 'hint';
    el.searchStatus.textContent = '没有找到候选元件，换个关键词试试。';
    el.candidates.hidden = true;
    return;
  }
  el.searchStatus.className = 'hint';
  el.searchStatus.textContent = '找到 ' + list.length + ' 个候选，点击一行选中。';
  list.forEach((cand) => {
    const row = document.createElement('div');
    row.className = 'row-item';
    row.innerHTML =
      '<span class="lcsc"></span>' +
      '<span class="mpn"></span>' +
      '<span class="pkg"></span>' +
      '<span class="stock"></span>' +
      '<span class="desc"></span>';
    row.querySelector('.lcsc').textContent = cand.lcsc || '';
    row.querySelector('.mpn').textContent = cand.mpn || '(无型号)';
    row.querySelector('.pkg').textContent = cand.package || '';
    row.querySelector('.stock').textContent =
      (cand.stock === undefined || cand.stock === null || cand.stock === '' ? '' : '库存 ' + cand.stock);
    row.querySelector('.desc').textContent = cand.description || '';
    row.title = '点击选中 ' + (cand.lcsc || '');
    row.addEventListener('click', () => selectCandidate(cand, row));
    el.candidates.appendChild(row);
  });
  el.candidates.hidden = false;
}

function selectCandidate(cand, row) {
  selected = cand;
  for (const node of el.candidates.querySelectorAll('.row-item')) node.classList.remove('sel');
  row.classList.add('sel');
  el.q.value = cand.lcsc || el.q.value;
  el.searchStatus.className = 'hint';
  el.searchStatus.textContent = '已选中 ' + cand.lcsc + '　' + (cand.mpn || '') + '　' + (cand.package || '');
  void loadPreview(cand.lcsc);
}

/* ─────────────── 预览：选中候选后显示符号（SchLib）与封装（PcbLib） ─────────────── */
const PREVIEW_API = '/api/preview';
let previewSeq = 0;

function previewNote(node, text) {
  node.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'pv-note';
  note.textContent = text;
  node.appendChild(note);
}

function setPreviewMessage(text, isError) {
  el.previewPanes.hidden = true;
  el.previewEmpty.hidden = false;
  el.previewEmpty.className = 'preview-empty' + (isError ? ' error-state' : '');
  el.previewEmpty.textContent = text;
}

function renderPreview(data) {
  el.previewEmpty.hidden = true;
  el.previewPanes.hidden = false;
  const meta = [data.lcsc, data.mpn, data.package].filter(Boolean).join(' · ');
  el.previewMeta.textContent = meta;
  el.previewMeta.title = meta;
  // SVG 由本地服务端根据解析出的几何数据生成（文本已转义），直接内嵌。
  if (data.symbolSvg) el.previewSymbol.innerHTML = data.symbolSvg;
  else previewNote(el.previewSymbol, '该元件没有符号数据');
  if (data.footprintSvg) el.previewPcb.innerHTML = data.footprintSvg;
  else previewNote(el.previewPcb, '该元件没有封装数据');
}

async function loadPreview(lcsc) {
  const id = String(lcsc || '').trim();
  if (!id) return;
  const seq = ++previewSeq; // 连续点选不同候选时，只有最后一次的响应生效
  el.previewMeta.textContent = id;
  el.previewMeta.title = '';
  setPreviewMessage('正在加载 ' + id + ' 的符号与封装…', false);
  try {
    const res = await fetch(PREVIEW_API + '?lcsc=' + encodeURIComponent(id), { cache: 'no-store' });
    const data = await res.json();
    if (seq !== previewSeq) return;
    if (!data.ok) throw new Error(data.error || '预览加载失败');
    renderPreview(data);
  } catch (err) {
    if (seq !== previewSeq) return;
    el.previewMeta.textContent = id;
    setPreviewMessage('预览加载失败：' + (err && err.message ? err.message : err), true);
  }
}

/* ─────────────── 生成 / 轮询 ─────────────── */
async function doBuild() {
  const query = (selected && selected.lcsc) ? selected.lcsc : el.q.value.trim();
  if (!query) {
    showError(el.buildError, '请先输入元件名称或立创编号。');
    return;
  }
  showError(el.buildError, '');
  el.buildBtn.disabled = true;
  el.buildBtn.textContent = '派发中…';
  el.jobId.textContent = '';
  el.jobState.hidden = true;
  el.steps.hidden = true;
  if (el.progressEmpty) el.progressEmpty.hidden = false;
  el.jobCounts.hidden = true;
  el.artifacts.innerHTML = '<li class="hint">尚无产物</li>';
  setLogText('（等待后端启动作业…）');
  try {
    const res = await fetch('/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        query,
        outDir: el.outDir.value.trim(),
        schLib: el.schLib.value.trim(),
        pcbLib: el.pcbLib.value.trim(),
        keepDocs: !!(el.keepDocs && el.keepDocs.checked),
        makePartLibs: !!(el.makePartLibs && el.makePartLibs.checked),
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      showError(el.buildError, data.error || '派发失败');
      el.buildBtn.disabled = false;
      el.buildBtn.textContent = '生成（无浏览器 + Altium 脚本）';
      return;
    }
    currentJobId = data.jobId;
    el.jobId.textContent = 'jobId: ' + data.jobId;
    if (data.paths) setPaths(data.paths);
    capturePrefsFromUi();
    persistPrefs();
    el.buildBtn.textContent = '生成中…';
    poll();
  } catch (err) {
    showError(el.buildError, '请求后端失败：' + (err && err.message ? err.message : err) + '（服务是否还在运行？）');
    el.buildBtn.disabled = false;
    el.buildBtn.textContent = '生成（无浏览器 + Altium 脚本）';
  }
}

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

async function poll() {
  if (!currentJobId) return;
  stopPolling();
  try {
    const res = await fetch('/api/job?id=' + encodeURIComponent(currentJobId));
    const data = await res.json();
    if (!data.ok) {
      showError(el.buildError, data.error || '查询作业状态失败');
      finishBuild();
      return;
    }
    renderJob(data);
    if (data.state === 'running') {
      pollTimer = setTimeout(poll, POLL_MS);
    } else {
      if (data.state === 'error') showError(el.buildError, data.error || '作业失败，详见日志。');
      finishBuild();
    }
  } catch (err) {
    showError(el.buildError, '轮询失败：' + (err && err.message ? err.message : err));
    pollTimer = setTimeout(poll, POLL_MS * 2);
  }
}

function finishBuild() {
  stopPolling();
  el.buildBtn.disabled = false;
  el.buildBtn.textContent = '生成（无浏览器 + Altium 脚本）';
  // 生成期间如果有更新提示被推迟，作业结束后再弹（不遮挡正在看的日志）。
  maybeShowUpdateModal();
}

function renderJob(job) {
  el.jobState.hidden = false;
  el.jobState.className = 'badge ' + job.state;
  const secs = Math.round((job.elapsedMs || 0) / 1000);
  el.jobState.textContent =
    (job.state === 'running' ? '运行中' : (job.state === 'done' ? '已完成' : '失败')) +
    ' · ' + (secs >= 60 ? Math.floor(secs / 60) + ' 分 ' + (secs % 60) + ' 秒' : secs + ' 秒');
  if (job.paths) setPaths(job.paths);
  if (job.lcsc) el.jobId.textContent = 'jobId: ' + job.jobId + '　元件: ' + job.lcsc;
  if (job.counts) {
    el.jobCounts.hidden = false;
    el.jobCounts.textContent = '管线自检计数：引脚 ' + (job.counts.schPins ?? '?')
      + '　焊盘 ' + (job.counts.pcbPads ?? '?');
  } else {
    el.jobCounts.hidden = true;
  }

  el.steps.hidden = false;
  if (el.progressEmpty) el.progressEmpty.hidden = true;
  el.steps.innerHTML = '';
  for (const step of job.steps || []) {
    const status = STEP_ICON[step.status] ? step.status : 'pending';
    const div = document.createElement('div');
    div.className = 'step ' + status;
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = STEP_ICON[status];
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = step.name;
    const dt = document.createElement('span');
    dt.className = 'dt';
    dt.textContent = step.detail || STEP_TEXT[status];
    div.append(ico, nm, dt);
    el.steps.appendChild(div);
  }

  const text = job.log || '';
  if (text !== lastLogText) setLogText(text);
  renderArtifacts(job.artifacts || []);
}

function classifyLogLine(line) {
  if (/\]\s*(ERR|PROBLEM|error:|\[stderr\])/i.test(line)) return 'err';
  if (/RESULT: FAILED|Traceback|Error:|错误：/.test(line)) return 'err';
  if (/RESULT: PASS|\]\s*OK [a-z]/i.test(line)) return 'ok';
  if (/^\[[^\]]+\]\s*(STAGE|model:|P1 source=|==== |RESULT)/.test(line)) return 'stage';
  return '';
}

function setLogText(text) {
  lastLogText = text;
  const lines = text ? text.split('\n') : [];
  const atBottom = el.logFollow.checked;
  const frag = document.createDocumentFragment();
  if (!lines.length) {
    const span = document.createElement('span');
    span.className = 'log-line dim';
    span.textContent = '（暂无日志）';
    frag.appendChild(span);
  } else {
    for (const line of lines) {
      const span = document.createElement('span');
      const cls = classifyLogLine(line);
      span.className = 'log-line' + (cls ? ' ' + cls : '');
      span.textContent = line;
      frag.appendChild(span);
    }
  }
  el.log.innerHTML = '';
  el.log.appendChild(frag);
  lastLogLineCount = lines.length;
  if (atBottom) el.log.scrollTop = el.log.scrollHeight;
}

function renderArtifacts(list) {
  el.artifacts.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = '尚无产物';
    el.artifacts.appendChild(li);
    return;
  }
  for (const art of list) {
    const li = document.createElement('li');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = art.name || '';
    const p = document.createElement('span');
    p.className = 'p' + (art.exists ? '' : ' miss');
    p.textContent = art.path || '';
    p.title = art.path || '';
    const sz = document.createElement('span');
    sz.className = 'sz';
    sz.textContent = art.exists ? formatSize(art.size) : '未生成';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '复制路径';
    btn.addEventListener('click', async () => {
      if (await copyText(art.path || '')) flash(btn);
      else { btn.textContent = '复制失败'; setTimeout(() => { btn.textContent = '复制路径'; }, 1200); }
    });
    li.append(nm, p, sz, btn);
    el.artifacts.appendChild(li);
  }
}

function formatSize(size) {
  const n = Number(size) || 0;
  if (n <= 0) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/* ─────────────── 更新提示（远端 tag 推送） ─────────────── */
// 服务端用 git ls-remote 对比远端 tag 与当前版本（只读，不 fetch）。
// 发现新 tag 时弹窗；「暂不更新」只在本标签页隐藏，「忽略此版本」写入服务端 state。
const UPDATE_POLL_MS = 10 * 60 * 1000;
const UPDATE_SESSION_KEY = 'lceda2altium.updateIgnored.v1';
let updateState = null;
let updatePollTimer = null;
let updateLoadAttempts = 0;
let updateModalTag = null;
let updateLastFocus = null;

function readSessionIgnored() {
  try {
    const list = JSON.parse(sessionStorage.getItem(UPDATE_SESSION_KEY) || '[]');
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}
function addSessionIgnored(tag) {
  if (!tag) return;
  const list = readSessionIgnored();
  if (!list.includes(tag)) list.push(tag);
  try { sessionStorage.setItem(UPDATE_SESSION_KEY, JSON.stringify(list)); } catch { /* 隐私模式忽略 */ }
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { hour12: false });
}
const metaLine = (parts) => parts.filter(Boolean).join(' · ');

function currentVersionLabel() {
  if (!updateState || !updateState.current) return '';
  return updateState.current.tag || updateState.current.version || '';
}

function renderVersionChip() {
  const chip = el.verChip;
  if (!chip) return;
  chip.classList.remove('update', 'muted');
  chip.disabled = false;
  const cur = currentVersionLabel();
  const st = updateState;
  if (!st) { chip.textContent = '版本 …'; chip.title = '正在检查更新'; return; }

  if (st.supported === false) {
    chip.classList.add('muted');
    chip.textContent = cur ? '版本 ' + cur : '本地副本';
    chip.title = st.reason || '当前目录不是 git 工作区，不检查更新';
    return;
  }
  if (st.ok === false) {
    chip.textContent = cur ? '版本 ' + cur : '版本';
    chip.title = (st.error || '检查更新失败') + '（点击重试）';
    return;
  }
  if (st.hasUpdate && st.latest) {
    chip.classList.add('update');
    chip.textContent = '↑ 新版本 ' + st.latest.tag;
    chip.title = '当前 ' + (cur || '未知') + '；点击查看更新说明，可选择不更新';
    return;
  }
  chip.textContent = cur ? '版本 ' + cur : '版本';
  chip.title = st.dismissed && st.latest
    ? '已忽略 ' + st.latest.tag + '；点击可恢复提醒'
    : (st.checkedAt ? '已是最新（检查于 ' + fmtTime(st.checkedAt) + '）· 点击重新检查' : '点击检查更新');
}

function updateNotesText(st) {
  const l = st.latest || {};
  const lines = [];
  lines.push('tag：' + (l.tag || '—') + (l.pushedAt ? '（推送于 ' + fmtTime(l.pushedAt) + '）' : ''));
  if (l.commit || l.commitShort) lines.push('提交：' + (l.commitShort || String(l.commit).slice(0, 7)) + (l.author ? ' · ' + l.author : ''));
  if (l.date) lines.push('时间：' + fmtTime(l.date));
  if (l.subject) lines.push('说明：' + l.subject);
  if (l.message && l.message !== l.subject) lines.push('tag 消息：' + l.message);
  if (l.releaseNotes) lines.push('', '发布说明：', l.releaseNotes.slice(0, 4000));
  return lines.join('\n');
}

function showUpdateModal() {
  const st = updateState;
  if (!st || !st.latest || !el.updateModal) return;
  updateModalTag = st.latest.tag;
  updateLastFocus = document.activeElement;
  const cur = st.current || {};
  const latest = st.latest || {};

  el.verCurrent.textContent = cur.tag || cur.version || '—';
  el.verCurrentMeta.textContent = metaLine([cur.commitShort, fmtTime(cur.date)]);
  el.verLatest.textContent = latest.tag || '—';
  el.verLatestMeta.textContent = metaLine([latest.commitShort, fmtTime(latest.date)]);

  const notes = updateNotesText(st);
  el.updateNotes.textContent = notes;
  el.updateNotes.hidden = !notes;

  el.updateSub.textContent = st.dismissed
    ? '该版本已被你忽略；远端仍停在这个 tag。可以恢复提醒，或继续沿用当前版本。'
    : '远端仓库推送了新 tag。是否更新由你决定，程序不会自动改动代码。';
  el.updateIgnore.hidden = Boolean(st.dismissed);
  el.updateRestore.hidden = !st.dismissed;

  const url = latest.compareUrl || latest.url || (st.links && st.links.repo) || '';
  el.updateView.dataset.url = url;
  el.updateView.disabled = !url;

  el.updateHint.className = 'hint';
  el.updateHint.textContent = '「暂不更新」只在本次运行隐藏提示，下次启动仍会提醒；更新后需停止并重新启动本服务（常用路径与作业记录保存在 state 目录，不受影响）。';

  el.updateModal.hidden = false;
  document.body.classList.add('modal-open');
  el.updateLater.focus();
}

function closeUpdateModal({ remember = true } = {}) {
  if (!el.updateModal || el.updateModal.hidden) return;
  if (remember && updateModalTag) addSessionIgnored(updateModalTag);
  el.updateModal.hidden = true;
  document.body.classList.remove('modal-open');
  updateModalTag = null;
  updateLoadAttempts = 0;
  if (updateLastFocus && typeof updateLastFocus.focus === 'function') {
    try { updateLastFocus.focus(); } catch { /* 元素已移除 */ }
  }
  updateLastFocus = null;
}

function maybeShowUpdateModal() {
  const st = updateState;
  if (!st || !st.hasUpdate || !st.latest) return;
  if (!el.updateModal || !el.updateModal.hidden) return;
  if (readSessionIgnored().includes(st.latest.tag)) return;
  // 生成作业进行中不遮挡界面：finishBuild() 会补一次调用。
  if (currentJobId && el.buildBtn.disabled) return;
  showUpdateModal();
}

/** 拉取服务端缓存的状态；后台还在检查时自动重试几次。 */
async function loadUpdateStatus() {
  if (updatePollTimer) { clearTimeout(updatePollTimer); updatePollTimer = null; }
  try {
    const res = await fetch('/api/update', { cache: 'no-store' });
    const data = await res.json();
    if (data && typeof data === 'object') updateState = data;
    renderVersionChip();
    if (data && data.checking && (data.supported === null || updateLoadAttempts < 6)) {
      updateLoadAttempts += 1;
      if (updateLoadAttempts <= 10) {
        updatePollTimer = setTimeout(loadUpdateStatus, 2500);
        return;
      }
    }
    updateLoadAttempts = 0;
    maybeShowUpdateModal();
  } catch {
    renderVersionChip();
    if (el.verChip) el.verChip.title = '检查更新失败（服务是否还在运行？）';
  }
  updatePollTimer = setTimeout(loadUpdateStatus, UPDATE_POLL_MS);
}

/** 手动「检查更新」：强制刷新，等待服务端返回。 */
async function checkUpdateNow() {
  if (!el.verChip) return;
  el.verChip.disabled = true;
  el.verChip.textContent = '检查中…';
  try {
    const res = await fetch('/api/update/check', { method: 'POST' });
    const data = await res.json();
    if (data && typeof data === 'object') updateState = data;
    renderVersionChip();
    if (data && data.ok === false) {
      el.verChip.textContent = '检查失败';
      el.verChip.title = data.error || '检查更新失败';
      setTimeout(renderVersionChip, 3000);
      return;
    }
    if (data && data.hasUpdate) {
      // 用户主动点「检查更新」时，即使本次已选过「暂不更新」也要打开弹窗。
      showUpdateModal();
    } else if (data && data.dismissed && data.latest) {
      // 已忽略的版本：打开弹窗，里面可以「恢复提醒」。
      showUpdateModal();
    } else {
      el.verChip.textContent = '已是最新';
      setTimeout(renderVersionChip, 2200);
    }
  } catch (err) {
    el.verChip.title = '检查更新失败：' + (err && err.message ? err.message : err);
    renderVersionChip();
  } finally {
    el.verChip.disabled = false;
  }
}

async function postUpdateDismiss(payload) {
  const res = await fetch('/api/update/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '保存失败');
  return data.status || null;
}

async function ignoreThisVersion() {
  const tag = updateModalTag || (updateState && updateState.latest && updateState.latest.tag);
  if (!tag) return;
  try {
    const status = await postUpdateDismiss({ tag });
    updateState = status ? { ...updateState, ...status } : { ...updateState, hasUpdate: false, dismissed: true, dismissedTag: tag };
    addSessionIgnored(tag);
    closeUpdateModal({ remember: false });
    renderVersionChip();
    el.verChip.textContent = '已忽略 ' + tag;
    el.verChip.title = '远端有新 tag 时会再次提示';
    setTimeout(renderVersionChip, 2800);
  } catch (err) {
    el.updateHint.className = 'error';
    el.updateHint.textContent = '保存忽略状态失败：' + (err && err.message ? err.message : err);
  }
}

async function restoreUpdateReminder() {
  const tag = (updateState && updateState.latest && updateState.latest.tag) || updateModalTag;
  if (!tag) return;
  try {
    const status = await postUpdateDismiss({ tag, clear: true });
    updateState = status ? { ...updateState, ...status } : { ...updateState, dismissed: false, hasUpdate: true };
    renderVersionChip();
    showUpdateModal();
  } catch (err) {
    el.updateHint.className = 'error';
    el.updateHint.textContent = '恢复提醒失败：' + (err && err.message ? err.message : err);
  }
}

async function copyUpdateCommand() {
  const tag = (updateState && updateState.latest && updateState.latest.tag) || updateModalTag || '<tag>';
  const cmd = 'git fetch --tags && git checkout ' + tag;
  if (await copyText(cmd)) {
    flash(el.updateCopy);
  } else {
    const old = el.updateCopy.textContent;
    el.updateCopy.textContent = '复制失败';
    setTimeout(() => { el.updateCopy.textContent = old; }, 1500);
  }
}

if (el.verChip) el.verChip.addEventListener('click', checkUpdateNow);
if (el.updateLater) el.updateLater.addEventListener('click', () => closeUpdateModal({ remember: true }));
if (el.updateClose) el.updateClose.addEventListener('click', () => closeUpdateModal({ remember: true }));
if (el.updateIgnore) el.updateIgnore.addEventListener('click', ignoreThisVersion);
if (el.updateRestore) el.updateRestore.addEventListener('click', restoreUpdateReminder);
if (el.updateCopy) el.updateCopy.addEventListener('click', copyUpdateCommand);
if (el.updateView) {
  el.updateView.addEventListener('click', () => {
    const url = el.updateView.dataset.url;
    if (url) window.open(url, '_blank', 'noopener');
  });
}
if (el.updateModal) {
  el.updateModal.addEventListener('click', (e) => {
    if (e.target === el.updateModal) closeUpdateModal({ remember: true });
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el.updateModal && !el.updateModal.hidden) {
    e.preventDefault();
    closeUpdateModal({ remember: true });
  }
});

/* ─────────────── 绑定 ─────────────── */
el.searchBtn.addEventListener('click', doSearch);
el.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
el.buildBtn.addEventListener('click', doBuild);
el.resetPaths.addEventListener('click', () => {
  setPaths(DEFAULTS);
  if (el.altiumExe) el.altiumExe.value = DEFAULTS.altiumExe;
  for (const field of PATH_FIELDS) renderSavedPaths(field, '');
  setPathStatus('');
  capturePrefsFromUi();
  persistPrefs();
});
for (const field of PATH_FIELDS) {
  field.browseBtn.addEventListener('click', () => browsePath(field));
  field.saveBtn.addEventListener('click', () => saveCurrentPath(field));
  field.delBtn.addEventListener('click', () => deleteSavedPath(field));
  field.select.addEventListener('change', () => {
    if (field.select.value) {
      field.input.value = field.select.value;
      setPathStatus('已填入：' + field.select.value, false);
      capturePrefsFromUi();
      persistPrefs();
    }
  });
  // 直接输入/粘贴路径后，离开输入框就记住它，重启程序后仍是这个路径。
  field.input.addEventListener('change', () => {
    capturePrefsFromUi();
    persistPrefs();
  });
}
// 手改/粘贴 Altium 路径后，稍等自动保存完成再向服务端确认“文件是否存在”。
if (el.altiumExe) {
  el.altiumExe.addEventListener('change', () => setTimeout(refreshAltiumStatus, 400));
}
for (const box of [el.keepDocs, el.makePartLibs]) {
  if (!box) continue;
  box.addEventListener('change', () => { capturePrefsFromUi(); persistPrefs(); });
}
el.logCopy.addEventListener('click', async () => {
  if (await copyText(lastLogText || '')) flash(el.logCopy);
});

/* 日志面板可收起：状态存 localStorage，下次打开沿用；收起后右侧只留标题栏。 */
const LOG_COLLAPSED_KEY = 'lceda2altium.logCollapsed.v1';
function applyLogCollapsed(collapsed) {
  if (el.logCard) el.logCard.classList.toggle('collapsed', collapsed);
  if (el.logToggle) {
    el.logToggle.textContent = collapsed ? '显示日志' : '隐藏日志';
    el.logToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }
}
function setLogCollapsed(collapsed) {
  applyLogCollapsed(collapsed);
  try { localStorage.setItem(LOG_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* 隐私模式忽略 */ }
}
try { applyLogCollapsed(localStorage.getItem(LOG_COLLAPSED_KEY) === '1'); }
catch { applyLogCollapsed(false); }
if (el.logToggle) {
  el.logToggle.addEventListener('click', () => {
    setLogCollapsed(!(el.logCard && el.logCard.classList.contains('collapsed')));
  });
}
// pagehide 在应用窗口关闭时也可能触发（beforeunload 不保证）；两处都发一次。
function savePrefsOnExit() {
  stopPolling();
  if (prefsTimer) { clearTimeout(prefsTimer); prefsTimer = null; }
  try {
    capturePrefsFromUi();
    const blob = new Blob([JSON.stringify({ prefs })], { type: 'application/json' });
    if (!navigator.sendBeacon || !navigator.sendBeacon(PREFS_API, blob)) sendPrefs(true);
  } catch { /* ignore */ }
}
window.addEventListener('pagehide', savePrefsOnExit);
window.addEventListener('beforeunload', savePrefsOnExit);

setPaths(DEFAULTS);
if (el.altiumExe) el.altiumExe.value = DEFAULTS.altiumExe;
for (const field of PATH_FIELDS) renderSavedPaths(field);

// The portable build runs from a different folder; take the three defaults
// from its /api/health instead of the hard-coded original paths. Then restore
// the paths/lists the server saved in its state directory, so closing the app
// (or a different browser/port) does not lose them.
(async function loadServerState() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const data = await res.json();
    if (data && data.ok && data.defaults) {
      DEFAULTS = { ...DEFAULTS, ...data.defaults };
      setPathsIfUntouched(DEFAULTS);
    }
  } catch { /* file:// static preview or server not ready */ }
  try {
    const res = await fetch(PREFS_API, { cache: 'no-store' });
    const data = await res.json();
    if (data && data.ok && data.prefs) applyPrefs(data.prefs);
    if (data && data.ok && data.altium) renderAltiumStatus(data.altium);
  } catch { /* keep the localStorage fallback */ }
  el.q.focus();
  // 检查远端 tag：服务端启动时已在后台检查，这里取缓存结果，不阻塞页面。
  void loadUpdateStatus();
})();
