// 自动更新检查（远端 tag 推送 → 页面弹窗提示）。
//
// 判断依据是远端仓库（origin）上的版本 tag，而不是本地工作区：
//   git ls-remote --tags origin   → 远端此刻有哪些 tag（不修改本地仓库，不写 refs）
//   git describe --tags           → 当前安装的版本
//   git ls-remote 拿到的 tag 比当前版本新  ⇒  有更新
//
// 只用 ls-remote，不做 fetch，所以检查本身不会动本地 .git（不会覆盖、不会拉取代码）。
// 远端 tag 的提交说明/发布说明优先读本地已有的 tag 对象；本地没有时再尝试
// GitHub REST API（8 秒超时，失败就静默降级为「只有 tag 名」）。
//
// 用户点「忽略此版本」时把 tag 写进 state 目录的 update-state.json，
// 这样换浏览器/重启服务都不会再提示同一个 tag；远端推了更新的 tag 才重新提示。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_GIT_TIMEOUT_MS = 20000;
const API_TIMEOUT_MS = 8000;

// ─────────────────────────── 小工具 ───────────────────────────
const shortSha = (sha) => (typeof sha === 'string' && sha.length >= 7 ? sha.slice(0, 7) : (sha || null));
const trimOut = (v) => String(v || '').replace(/\r/g, '').trim();

/** 版本 tag 解析：V1.0.4 / v1.0 / 1.2.3-beta → 数字段 + 预发布后缀；非版本 tag 返回 null。 */
function versionParts(tag) {
  const m = String(tag || '').trim().match(/^[vV]?(\d+(?:\.\d+)*)((?:[-+._].*)?)$/);
  if (!m) return null;
  return { nums: m[1].split('.').map((n) => Number(n)), pre: m[2] || '' };
}

/** 数字段逐位比较；预发布（如 -beta）小于正式版。 */
function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  if (!pa || !pb) return String(a).localeCompare(String(b), 'en');
  const n = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa.nums[i] || 0;
    const y = pb.nums[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre, 'en');
}

/** https://github.com/o/r(.git) / git@github.com:o/r.git / ssh://git@github.com/o/r → { owner, repo } */
function parseGithubRepo(url) {
  const m = String(url || '').trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function parseLog(out) {
  const lines = trimOut(out).split('\n');
  const sha = (lines[0] || '').trim();
  const ct = Number((lines[1] || '').trim());
  return {
    commit: /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null,
    date: Number.isFinite(ct) && ct > 0 ? new Date(ct * 1000).toISOString() : null,
    author: (lines[2] || '').trim() || null,
    subject: (lines[3] || '').trim() || null,
  };
}

function firstLine(text) {
  return String(text || '').replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
}

// ─────────────────────────── 检查器 ───────────────────────────
/**
 * @param {object} opts
 * @param {string} opts.rootDir   工程根目录（git 工作区）
 * @param {string} opts.stateDir  启动器 state 目录（保存忽略的 tag）
 * @param {string} [opts.appVersion]           非 git 环境下的版本号
 * @param {string} [opts.remote]              远端名，默认 origin
 * @param {number} [opts.ttlMs]               结果缓存时长，默认 10 分钟
 * @param {number} [opts.gitTimeoutMs]        单条 git 命令超时，默认 20 秒
 */
export function createUpdateChecker({
  rootDir,
  stateDir,
  appVersion = '',
  remote = 'origin',
  ttlMs = DEFAULT_TTL_MS,
  gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS,
} = {}) {
  const stateFile = path.join(stateDir || rootDir, 'update-state.json');

  let cache = null;        // { at, raw, dismissedTag }
  let inFlight = null;
  let memoryDismissedTag = null;

  // ── git 命令 ──
  function runGit(args) {
    return execFileAsync('git', args, {
      cwd: rootDir,
      timeout: gitTimeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        // 不能因为远端要凭据就卡在认证框上（检查更新只读，不需要用户交互）。
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        GIT_ASKPASS: '',
        // 中文 Windows 下 git 的输出统一成 UTF-8，避免 tag 说明乱码。
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
      },
    }).then(
      (r) => ({ code: 0, out: r.stdout || '', err: r.stderr || '', timedOut: false, spawnError: null }),
      (err) => ({
        code: typeof err.code === 'number' ? err.code : (err.code || 1),
        out: err.stdout || '',
        err: err.stderr || err.message || String(err),
        timedOut: err.killed === true || err.signal === 'SIGTERM',
        spawnError: err.code === 'ENOENT' ? 'ENOENT' : null,
      }),
    );
  }

  // ── 忽略状态 ──
  async function readDismissedTag() {
    try {
      const raw = await fsp.readFile(stateFile, 'utf8');
      const obj = JSON.parse(raw);
      return typeof obj.dismissedTag === 'string' && obj.dismissedTag.trim() ? obj.dismissedTag.trim() : null;
    } catch {
      return memoryDismissedTag;
    }
  }

  async function writeDismissedTag(tag) {
    memoryDismissedTag = tag || null;
    try {
      await fsp.mkdir(path.dirname(stateFile), { recursive: true });
      const tmp = stateFile + '.tmp';
      const payload = {
        dismissedTag: memoryDismissedTag,
        dismissedAt: memoryDismissedTag ? new Date().toISOString() : null,
      };
      await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await fsp.rename(tmp, stateFile);
    } catch { /* state 目录不可写时只保留内存中的忽略状态 */ }
  }

  // ── GitHub API（可选，失败静默） ──
  async function getJson(url) {
    if (typeof fetch !== 'function') return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
    try {
      const headers = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'LCEDA2Altium-update-check',
      };
      if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + String(process.env.GITHUB_TOKEN).trim();
      const res = await fetch(url, { headers, signal: ctl.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null; // 离线 / 被墙 / 限流：只显示 tag 名与提交 SHA
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 本地 tag 详情（远端 tag 已被 fetch 到本地时可用，不联网） ──
  async function localTagInfo(tag) {
    const ref = 'refs/tags/' + tag;
    const meta = await runGit(['for-each-ref', '--format=%(objecttype)%09%(taggerdate:iso-strict)%09%(contents:subject)', ref]);
    let tagDate = null;
    let message = null;
    if (meta.code === 0) {
      const [type, date, subject] = trimOut(meta.out).split('\t');
      tagDate = date || null;
      if ((type || '').trim() === 'tag') message = subject || null;
    }
    const log = await runGit(['log', '-1', '--format=%H%n%ct%n%an%n%s', ref]);
    const info = log.code === 0 ? parseLog(log.out) : { commit: null, date: null, author: null, subject: null };
    return { ...info, tagDate, message };
  }

  // ── 主检查 ──
  async function rawCheck() {
    const checkedAt = new Date().toISOString();
    const base = {
      ok: true,
      supported: true,
      checking: false,
      hasUpdateRaw: false,
      retagged: false,
      checkedAt,
      error: null,
      reason: null,
      current: null,
      latest: null,
      remote: null,
      links: {},
    };

    const inside = await runGit(['rev-parse', '--is-inside-work-tree']);
    if (inside.spawnError === 'ENOENT') {
      return { ...base, ok: false, supported: false,
        reason: '未找到 git 命令：便携副本或未安装 Git 时无法检查更新',
        error: 'git: command not found' };
    }
    if (inside.code !== 0 || trimOut(inside.out) !== 'true') {
      return { ...base, supported: false,
        reason: '当前目录不是 git 工作区（便携/解压副本），不检查更新',
        current: appVersion ? { tag: appVersion, version: appVersion, exact: false, commit: null, commitShort: null, date: null, subject: null, author: null } : null };
    }

    // 当前版本
    const head = await runGit(['log', '-1', '--format=%H%n%ct%n%an%n%s', 'HEAD']);
    const headInfo = head.code === 0 ? parseLog(head.out) : { commit: null, date: null, author: null, subject: null };
    // 只认版本号形式的 tag（仓库里还可能有 Application 之类与版本无关的 tag）。
    const exact = await runGit(['describe', '--tags', '--exact-match', 'HEAD']);
    let currentTag = exact.code === 0 && versionParts(trimOut(exact.out)) ? trimOut(exact.out) : '';
    const exactMatch = Boolean(currentTag);
    if (!currentTag) {
      const near = await runGit(['describe', '--tags', '--abbrev=0',
        '--match', 'v[0-9]*', '--match', 'V[0-9]*', '--match', '[0-9]*', 'HEAD']);
      if (near.code === 0 && versionParts(trimOut(near.out))) currentTag = trimOut(near.out);
    }
    const currentVersion = currentTag || appVersion || '';
    const current = {
      tag: currentTag || null,
      version: currentVersion || null,
      exact: exactMatch,
      commit: headInfo.commit,
      commitShort: shortSha(headInfo.commit),
      date: headInfo.date,
      subject: headInfo.subject,
      author: headInfo.author,
    };

    // 远端
    const remoteUrl = trimOut((await runGit(['remote', 'get-url', remote])).out);
    base.remote = remoteUrl || null;
    if (!remoteUrl) {
      return { ...base, supported: true, current,
        reason: '未配置远端 ' + remote + '，不检查更新' };
    }
    const gh = parseGithubRepo(remoteUrl);
    const repoUrl = gh ? 'https://github.com/' + gh.owner + '/' + gh.repo : null;
    base.links = { repo: repoUrl };

    const ls = await runGit(['ls-remote', '--tags', remote]);
    if (ls.code !== 0) {
      const why = ls.timedOut ? '超时（' + Math.round(gitTimeoutMs / 1000) + ' 秒）'
        : (firstLine(ls.err) || '无法访问远端');
      return { ...base, current, ok: false,
        error: '检查远端 tag 失败：' + why,
        reason: '检查远端 tag 失败' };
    }

    // 解析 tag 列表：refs/tags/X 与 refs/tags/X^{}（annotated tag 的提交）
    const tags = new Map();
    for (const line of trimOut(ls.out).split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const sha = line.slice(0, tab).trim();
      let ref = line.slice(tab + 1).trim();
      if (!ref.startsWith('refs/tags/')) continue;
      let name = ref.slice('refs/tags/'.length);
      const peeled = name.endsWith('^{}');
      if (peeled) name = name.slice(0, -3);
      if (!versionParts(name)) continue; // 只认版本号形式的 tag（忽略 Application 之类的分支名）
      const item = tags.get(name) || { name, commit: null };
      if (peeled) item.commit = sha;
      else item.commit = item.commit || sha;
      tags.set(name, item);
    }
    if (!tags.size) {
      return { ...base, current, latest: null, hasUpdateRaw: false };
    }
    const sorted = [...tags.values()].sort((a, b) => compareVersions(b.name, a.name));
    const top = sorted[0];

    // 版本比较
    let hasUpdateRaw = false;
    if (!currentVersion) {
      hasUpdateRaw = true;
    } else {
      const cmp = compareVersions(top.name, currentVersion);
      if (cmp > 0) hasUpdateRaw = true;
      else if (cmp === 0 && exactMatch && top.commit && headInfo.commit && top.commit !== headInfo.commit) {
        // 同一个 tag 在远端被重新推送（指向了新提交）
        hasUpdateRaw = true;
        base.retagged = true;
      }
    }

    const latestBase = {
      tag: top.name,
      commit: top.commit,
      commitShort: shortSha(top.commit),
      url: gh ? repoUrl + '/releases/tag/' + encodeURIComponent(top.name) : null,
      compareUrl: gh && currentTag ? repoUrl + '/compare/' + encodeURIComponent(currentTag) + '...' + encodeURIComponent(top.name) : null,
    };
    if (!hasUpdateRaw) {
      return { ...base, current, latest: latestBase, hasUpdateRaw: false };
    }

    // 有更新：补充 tag 推送/提交详情（本地优先，GitHub API 兜底）
    const localRef = (await runGit(['rev-parse', '--verify', '--quiet', 'refs/tags/' + top.name])).code === 0;
    const local = localRef ? await localTagInfo(top.name) : null;

    let release = null;
    let apiCommit = null;
    if (gh) {
      const relUrl = 'https://api.github.com/repos/' + gh.owner + '/' + gh.repo +
        '/releases/tags/' + encodeURIComponent(top.name);
      const requests = [getJson(relUrl)];
      if (!local && top.commit) {
        requests.push(getJson('https://api.github.com/repos/' + gh.owner + '/' + gh.repo +
          '/commits/' + encodeURIComponent(top.commit)));
      }
      const [rel, commit] = await Promise.all(requests);
      release = rel && typeof rel === 'object' ? rel : null;
      apiCommit = commit && typeof commit === 'object' ? commit : null;
    }

    const commitInfo = local || (apiCommit && apiCommit.commit ? {
      commit: apiCommit.sha || top.commit,
      date: apiCommit.commit.author && apiCommit.commit.author.date ? apiCommit.commit.author.date : null,
      author: apiCommit.commit.author && apiCommit.commit.author.name ? apiCommit.commit.author.name : null,
      subject: typeof apiCommit.commit.message === 'string' ? apiCommit.commit.message.split('\n')[0] : null,
      tagDate: null,
      message: null,
    } : null);

    const latest = {
      ...latestBase,
      commit: top.commit || (commitInfo && commitInfo.commit) || null,
      commitShort: shortSha(top.commit || (commitInfo && commitInfo.commit)),
      pushedAt: release && release.published_at ? release.published_at : null,
      date: (release && release.published_at) || (commitInfo && (commitInfo.tagDate || commitInfo.date)) || null,
      commitDate: commitInfo && commitInfo.date ? commitInfo.date : null,
      author: commitInfo && commitInfo.author ? commitInfo.author : null,
      subject: commitInfo && commitInfo.subject ? commitInfo.subject : null,
      message: commitInfo && commitInfo.message ? commitInfo.message : null,
      releaseName: release && release.name ? release.name : null,
      releaseNotes: release && typeof release.body === 'string' && release.body.trim() ? release.body.trim() : null,
      commitUrl: gh && (top.commit || (commitInfo && commitInfo.commit))
        ? repoUrl + '/commit/' + encodeURIComponent(top.commit || commitInfo.commit)
        : null,
    };

    return { ...base, current, latest, hasUpdateRaw: true };
  }

  function applyDismissal(raw, dismissedTag) {
    const dismissed = Boolean(dismissedTag && raw.latest && raw.latest.tag === dismissedTag);
    return {
      ...raw,
      dismissed,
      dismissedTag: dismissedTag || null,
      hasUpdate: Boolean(raw.hasUpdateRaw && !dismissed),
    };
  }

  function snapshot() {
    if (!cache) return null;
    return applyDismissal(cache.raw, cache.dismissedTag);
  }

  /** 不触发检查的状态快照：result（可能为 null）、checking、stale。 */
  function peek() {
    return {
      result: snapshot(),
      checking: Boolean(inFlight),
      stale: !cache || Date.now() - cache.at > ttlMs,
    };
  }

  /** 执行（或复用进行中的）检查；force=true 时忽略缓存。 */
  function refresh({ force = false } = {}) {
    if (inFlight) return inFlight;
    if (!force && cache && Date.now() - cache.at < ttlMs) {
      return Promise.resolve({ ...snapshot(), cached: true });
    }
    inFlight = (async () => {
      try {
        const raw = await rawCheck();
        const dismissedTag = await readDismissedTag();
        cache = { at: Date.now(), raw, dismissedTag };
        return { ...snapshot(), cached: false };
      } catch (err) {
        return {
          ok: false,
          supported: true,
          checking: false,
          hasUpdate: false,
          checkedAt: new Date().toISOString(),
          error: '检查更新时出错：' + (err && err.message ? err.message : String(err)),
          current: cache ? cache.raw.current : null,
          latest: null,
        };
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /** 记录/清除「忽略此版本」。clear=true 时恢复提醒。 */
  async function setDismissed(tag, { clear = false } = {}) {
    const value = clear ? null : (typeof tag === 'string' && tag.trim() ? tag.trim().slice(0, 128) : null);
    await writeDismissedTag(value);
    if (cache) cache.dismissedTag = value;
    return snapshot();
  }

  return { peek, refresh, setDismissed, stateFile };
}

export { compareVersions, versionParts };
