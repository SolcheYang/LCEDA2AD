'use strict';

const FALLBACK_DEFAULTS = {
  outDir: 'E:\\EDA2Altium\\out',
  schLib: 'E:\\EDA2Altium\\library\\MyLib.SchLib',
  pcbLib: 'E:\\EDA2Altium\\library\\MyLib.PcbLib',
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
  browseOutDir: $('browse-outDir'), saveOutDir: $('save-outDir'), delOutDir: $('del-outDir'),
  browseSchLib: $('browse-schLib'), saveSchLib: $('save-schLib'), delSchLib: $('del-schLib'),
  browsePcbLib: $('browse-pcbLib'), savePcbLib: $('save-pcbLib'), delPcbLib: $('del-pcbLib'),
  pathStatus: $('path-status'),
  keepDocs: $('keepDocs'), makePartLibs: $('makePartLibs'),
  buildBtn: $('build-btn'), jobState: $('job-state'), jobId: $('job-id'), buildError: $('build-error'),
  resetPaths: $('reset-paths'), jobCounts: $('job-counts'),
  steps: $('steps'), log: $('log'), logCopy: $('log-copy'), logFollow: $('log-follow'),
  artifacts: $('artifacts'),
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
  for (const key of ['outDir', 'schLib', 'pcbLib']) {
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

const samePath = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

function readSavedPaths(field) {
  try {
    const list = JSON.parse(localStorage.getItem(field.storageKey) || '[]');
    return Array.isArray(list)
      ? list.filter((x) => typeof x === 'string' && x.trim())
        .map((x) => x.trim()).slice(0, 20)
      : [];
  } catch { return []; }
}
function writeSavedPaths(field, list) {
  try { localStorage.setItem(field.storageKey, JSON.stringify(list.slice(0, 20))); }
  catch { /* localStorage 不可用时静默忽略 */ }
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

/* ─────────────── 绑定 ─────────────── */
el.searchBtn.addEventListener('click', doSearch);
el.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
el.buildBtn.addEventListener('click', doBuild);
el.resetPaths.addEventListener('click', () => {
  setPaths(DEFAULTS);
  for (const field of PATH_FIELDS) renderSavedPaths(field, '');
  setPathStatus('');
});
for (const field of PATH_FIELDS) {
  field.browseBtn.addEventListener('click', () => browsePath(field));
  field.saveBtn.addEventListener('click', () => saveCurrentPath(field));
  field.delBtn.addEventListener('click', () => deleteSavedPath(field));
  field.select.addEventListener('change', () => {
    if (field.select.value) {
      field.input.value = field.select.value;
      setPathStatus('已填入：' + field.select.value, false);
    }
  });
}
el.logCopy.addEventListener('click', async () => {
  if (await copyText(lastLogText || '')) flash(el.logCopy);
});
window.addEventListener('beforeunload', stopPolling);

setPaths(DEFAULTS);
for (const field of PATH_FIELDS) renderSavedPaths(field);

// The portable build runs from a different folder; take the three defaults
// from its /api/health instead of the hard-coded original paths.
(async function loadServerDefaults() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const data = await res.json();
    if (data && data.ok && data.defaults) {
      DEFAULTS = { ...DEFAULTS, ...data.defaults };
      setPathsIfUntouched(DEFAULTS);
    }
  } catch { /* file:// static preview or server not ready */ }
  el.q.focus();
})();
