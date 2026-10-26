// run-altium.mjs - launch the Altium job emitted by emit-altium.mjs, wait for
// job.log to finish, kill only the Altium processes this job started, and parse
// the STEP / OK / ERR / DONE protocol (CONTRACT.md §3 / §3b).
//
// runAltiumJob(job, { timeoutMs }) -> { ok, log, steps, error?, artifacts, ... }
//
// Notes from the real machine (Altium 26.7.1, single-instance):
//  * X2.EXE hands the -RScriptingSystem command line to an already running
//    instance and exits immediately, so process exit is NOT a completion
//    signal; the DONE line in job.log is.
//  * The PID set before/after the launch is the only safe kill list: a
//    pre-existing Altium instance is never touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

export const DEFAULT_ALTIUM_EXE = 'E:\\AD\\AD\\X2.EXE';

const POLL_MS = 400;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** PIDs of running images named like the given executable. */
export function listAltiumPids(exePath) {
  const image = path.basename(String(exePath || 'X2.EXE'));
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + image, '/FO', 'CSV', '/NH'],
      { encoding: 'latin1', windowsHide: true, timeout: 20000 });
    const pids = [];
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(/^"[^"]+","(\d+)"/);
      if (m) pids.push(Number(m[1]));
    }
    return pids;
  } catch {
    return [];
  }
}

function killTree(pids) {
  const killed = [];
  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, timeout: 20000 });
      killed.push(pid);
    } catch {
      // already gone
    }
  }
  return killed;
}

/**
 * Altium reports an uncaught script error as a modal TMessageForm titled "Error".
 * Measured on Altium 26.7.1: that form has only an OK button and an EMPTY body, so
 * there is no text to read back. PrintWindow still captures the form itself, which is
 * enough to prove "a dialog blocked the job" instead of leaving a silent hang.
 * Returns the captured PNG paths (empty when no dialog was on screen).
 */
const DIALOG_PS = [
  'param([string]$OutDir)',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public class ADlg {',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);',
  '  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);',
  '  public struct RECT { public int Left, Top, Right, Bottom; }',
  '  public static System.Collections.Generic.List<IntPtr> Find(uint want, string cls) {',
  '    var res = new System.Collections.Generic.List<IntPtr>();',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      uint pid; GetWindowThreadProcessId(h, out pid);',
  '      if (pid != want) return true;',
  '      StringBuilder c = new StringBuilder(256); GetClassName(h, c, 256);',
  '      if (c.ToString() == cls) res.Add(h);',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return res;',
  '  }',
  '  public static string Size(IntPtr h) {',
  '    RECT r; GetWindowRect(h, out r);',
  '    return (r.Right - r.Left) + "x" + (r.Bottom - r.Top);',
  '  }',
  '}',
  '"@',
  'Add-Type -AssemblyName System.Drawing',
  '$procs = @(Get-Process X2 -ErrorAction SilentlyContinue)',
  'if ($procs.Count -eq 0) { Write-Output "NOPROC"; exit }',
  '$i = 0',
  // A second Altium instance from an earlier probe must not break diagnostics:
  // Get-Process then returns an array and $p.Id is Object[], not UInt32.
  'foreach ($proc in $procs) {',
  'foreach ($d in [ADlg]::Find([uint32]$proc.Id, "TMessageForm")) {',
  '  $parts = [ADlg]::Size($d).Split("x")',
  '  $w = [int]$parts[0]; $h = [int]$parts[1]',
  '  if ($w -le 0 -or $h -le 0) { continue }',
  '  $bmp = New-Object System.Drawing.Bitmap $w, $h',
  '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
  '  $hdc = $g.GetHdc()',
  '  [void][ADlg]::PrintWindow($d, $hdc, 2)',
  '  $g.ReleaseHdc($hdc)',
  '  $g.Dispose()',
  '  $file = Join-Path $OutDir ("altium-dialog-" + $i + ".png")',
  '  $bmp.Save($file)',
  '  $bmp.Dispose()',
  '  Write-Output ("DIALOG " + $file)',
  '  $i++',
  '}',
  '}',
  'if ($i -eq 0) { Write-Output "NODIALOG" }',
].join('\r\n');

export function captureAltiumDialogs(outDir) {
  const files = [];
  const dir = outDir || os.tmpdir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(os.tmpdir(), 'dsh-altium-dialog-' + process.pid + '.ps1');
    fs.writeFileSync(script, DIALOG_PS, 'latin1');
    const out = execFileSync('powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutDir', dir],
      { encoding: 'latin1', windowsHide: true, timeout: 60000 });
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(/^DIALOG\s+(.+)$/);
      if (m) files.push(m[1].trim());
    }
  } catch {
    // best effort only: never let diagnostics mask the real failure
  }
  return files;
}

/** Parse the job.log line protocol into ordered steps. */
export function parseLog(text) {
  const steps = [];
  const byName = new Map();
  const ensure = (name) => {
    if (!byName.has(name)) {
      const step = { name, status: 'running', detail: '' };
      steps.push(step);
      byName.set(name, step);
    }
    return byName.get(name);
  };
  let done = false;
  let artifactCount = null;
  const errors = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m = line.match(/^STEP\s+(\S+)\s*(.*)$/);
    if (m) { ensure(m[1]).detail = m[2] || ''; continue; }
    m = line.match(/^OK\s+(\S+)\s*(.*)$/);
    if (m) { const s = ensure(m[1]); s.status = 'ok'; s.detail = m[2] || ''; continue; }
    m = line.match(/^ERR\s+(\S+)\s*(.*)$/);
    if (m) {
      const s = ensure(m[1]);
      s.status = 'error';
      s.detail = m[2] || '';
      errors.push(m[1] + ': ' + (m[2] || ''));
      continue;
    }
    m = line.match(/^DONE\s+artifacts=(\d+)\s*$/);
    if (m) { done = true; artifactCount = Number(m[1]); }
  }
  return { steps, done, artifactCount, errors };
}

function tailOf(text, count) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.length > 0);
  return lines.slice(-count).join('\n');
}

/**
 * runAltiumJob(job, { timeoutMs = 180000, stallMs })
 * job: return value of emitAltiumJob().
 * -> { ok, log, steps, artifacts, error? }
 */
export async function runAltiumJob(job, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 180000;
  // Altium needs a long time to come up from cold (30-70 s on this machine) and
  // it hands the command to an already running instance, so the launcher exits
  // long before the first log line. startupMs covers "nothing written yet",
  // stallMs covers "log stopped growing after it started".
  const startupMs = Number(options.startupMs) > 0 ? Number(options.startupMs) : 120000;
  const stallMs = Number(options.stallMs) > 0 ? Number(options.stallMs) : 60000;

  if (!job || !job.cmdPath || !job.logPath) {
    return { ok: false, log: '', steps: [], error: 'runAltiumJob: job.cmdPath / job.logPath are required' };
  }

  const altiumExe = process.env.ALTIUM_EXE || job.altiumExe || DEFAULT_ALTIUM_EXE;

  try {
    if (fs.existsSync(job.logPath)) fs.unlinkSync(job.logPath); // always start from an empty log
  } catch (err) {
    return { ok: false, log: '', steps: [], error: 'cannot clear previous job.log: ' + err.message, altiumExe };
  }

  if (!fs.existsSync(altiumExe)) {
    return {
      ok: false, log: '', steps: [], altiumExe,
      error: 'Altium executable not found: ' + altiumExe + ' (override with the ALTIUM_EXE environment variable)',
    };
  }
  for (const file of [job.cmdPath, job.prjScrPath, job.pasPath]) {
    if (file && !fs.existsSync(file)) {
      return { ok: false, log: '', steps: [], altiumExe, error: 'job file is missing: ' + file };
    }
  }

  const before = new Set(listAltiumPids(altiumExe));

  let child = null;
  let childExit = null;
  try {
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/c', job.cmdPath], {
      windowsHide: true,
      env: { ...process.env, ALTIUM_EXE: altiumExe },
      stdio: 'ignore',
    });
    child.on('exit', (code) => { childExit = { code }; });
    child.on('error', (err) => { childExit = { code: -1, error: err.message }; });
  } catch (err) {
    return { ok: false, log: '', steps: [], altiumExe, error: 'failed to launch the job: ' + err.message };
  }

  const started = Date.now();
  let log = '';
  let lastLog = null;
  let lastChange = started;
  let timedOut = false;
  let done = false;

  for (;;) {
    await sleep(POLL_MS);
    try { log = fs.readFileSync(job.logPath, 'latin1'); } catch { log = ''; }
    if (log !== lastLog) { lastLog = log; lastChange = Date.now(); }
    if (parseLog(log).done) { done = true; break; }
    const now = Date.now();
    if (now - started > timeoutMs) { timedOut = true; break; }
    if (lastLog === '') {
      // Nothing written yet: this is the cold-start window, not a stall.
      if (now - started > startupMs) break;
    } else if (childExit && now - lastChange > stallMs) {
      // The launcher is gone (normal: the command was handed to the running
      // instance) and the log has stopped growing, so nothing is running.
      break;
    }
  }

  try { log = fs.readFileSync(job.logPath, 'latin1'); } catch { log = ''; }
  const parsed = parseLog(log);

  // Kill only Altium PIDs that appeared because of this job.
  const mine = listAltiumPids(altiumExe).filter((pid) => !before.has(pid));
  const killed = (!done && mine.length) ? killTree(mine) : [];
  if (!done && child && child.pid && !childExit) {
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, timeout: 20000 }); } catch { /* ignore */ }
  }

  const result = {
    ok: false,
    log,
    steps: parsed.steps,
    artifacts: parsed.artifactCount,
    altiumExe,
    killedPids: killed,
    startedPids: mine,
    elapsedMs: Date.now() - started,
    tail: tailOf(log, 20),
  };

  // A wedged run is almost always Altium showing a modal "Error" box for a script
  // exception. Capture it so the failure is evidence, not a silent hang.
  let dialogNote = '';
  if (timedOut || !parsed.done) {
    const dialogs = captureAltiumDialogs(job.workDir || path.dirname(job.logPath));
    if (dialogs.length) {
      result.dialogs = dialogs;
      dialogNote = '\nAltium is showing a modal dialog (its body is empty, so only a screenshot exists): '
        + dialogs.join(', ');
      const line = '\r\nERR dialog Altium modal dialog captured: ' + dialogs.join(', ') + '\r\n';
      try {
        fs.appendFileSync(job.logPath, line, 'latin1');
        result.log = result.log + line;
      } catch {
        // log may be locked; the path in result.dialogs still points at the evidence
      }
    }
  }

  if (timedOut) {
    result.error = 'Altium job timed out after ' + timeoutMs + ' ms'
      + (killed.length ? ' (killed started PIDs: ' + killed.join(',') + ')' : ' (no Altium process was started by this job)')
      + '. job.log tail:\n' + (result.tail || '<empty log>') + dialogNote;
    return result;
  }
  if (!parsed.done) {
    const why = log === ''
      ? 'no job.log was written within ' + startupMs + ' ms (Altium never ran the script: cold start too slow, a modal dialog, or a compile error)'
      : 'the log stopped growing after ' + (result.elapsedMs - 0) + ' ms without a DONE line (the script crashed or Altium is waiting on a dialog)';
    result.error = 'Altium job produced no DONE line: ' + why
      + (childExit ? ' (launcher exit code ' + childExit.code + (childExit.error ? ', ' + childExit.error : '') + ')' : '')
      + '. job.log tail:\n'
      + (result.tail || '<empty log>') + dialogNote;
    return result;
  }
  if (parsed.errors.length) {
    result.error = 'Altium job reported errors:\n' + parsed.errors.join('\n')
      + '\njob.log tail:\n' + (result.tail || '<empty log>');
    return result;
  }
  if (!(parsed.artifactCount > 0)) {
    result.error = 'Altium job finished with DONE artifacts=0';
    return result;
  }

  result.ok = true;
  return result;
}

export default { runAltiumJob, parseLog, listAltiumPids, captureAltiumDialogs, DEFAULT_ALTIUM_EXE };