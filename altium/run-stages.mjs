#!/usr/bin/env node
// run-stages.mjs - no-UI-click pipeline for one LCSC part.
//
//   node altium/run-stages.mjs C92116
//   OUT_DIR=<folder> LIB_SCH=<a.SchLib> LIB_PCB=<a.PcbLib> node altium/run-stages.mjs C92116
//
// Flow:
//   1. EasyEDA public data API -> model; write Altium ASCII SchDoc/PcbDoc locally
//      (no browser, no web editor; the pristine copy goes to _source)
//   2. parse those documents back in Node (doc-parse.mjs) and use that geometry
//   3. four Altium script stages, one process each, NO UIA / NO mouse clicks:
//        schlib_part -> <OUT_DIR>\<LCSC>_SCH.SchLib
//        schlib      -> merge into LIB_SCH
//        pcblib_part -> <OUT_DIR>\<LCSC>_PCB.PcbLib
//        pcblib      -> merge into LIB_PCB
//   4. assert counts and files, print RESULT_JSON
//
// Env: OUT_DIR, LIB_SCH, LIB_PCB, ALLOW_FIXTURE=1, ALLOW_KILL_EXISTING=1, ALTIUM_EXE,
//      ALTIUM_STARTUP_MS, PIPELINE_TIMEOUT_MS (the server sets the first three).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAltiumJob } from '../app/lib/run-altium.mjs';
import { emitScriptJob, LIB_MARKER_SCH, LIB_MARKER_PCB } from '../app/lib/emit-script-lib.mjs';
import { countDocumentRecords, toAscii } from '../app/lib/emit-altium.mjs';
import { parseSchDoc, parsePcbDoc } from '../app/lib/doc-parse.mjs';
import { buildSchDoc, buildPcbDoc } from '../app/lib/altium-doc-writer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.ALTIUM_EXE || 'E:\\AD\\AD\\X2.EXE';
const LCSC = process.argv[2] || 'C92116';
const KEEP_DOCS = process.env.KEEP_DOCS === '1';
const MAKE_PART_LIBS = process.env.MAKE_PART_LIBS === '1';
const TARGET_STAGES = ['pcblib', 'schlib'];
const PART_STAGES = MAKE_PART_LIBS ? ['pcblib_part', 'schlib_part'] : [];
const STAGES = [...TARGET_STAGES, ...PART_STAGES];
const OUT_DIR = path.resolve(process.env.OUT_DIR || path.join(ROOT, 'out'));
const LIB_SCH = path.resolve(process.env.LIB_SCH || path.join(ROOT, 'library', 'MyLib.SchLib'));
const LIB_PCB = path.resolve(process.env.LIB_PCB || path.join(ROOT, 'library', 'MyLib.PcbLib'));
const ALLOW_KILL_EXISTING = process.env.ALLOW_KILL_EXISTING === '1';
const PIN_LENGTH_MIL = Number(process.env.PIN_LENGTH_MIL || 150);
const startedAt = Date.now();
const artifacts = [];
const problems = [];
const pipelineLines = [];
const ourPids = new Set();
const log = (line) => console.log(line);

function fail(reason, code) {
  log('RESULT_JSON ' + JSON.stringify({ ok: false, lcsc: LCSC, outDir: OUT_DIR, schLib: LIB_SCH, pcbLib: LIB_PCB, reason }));
  process.exit(code || 1);
}
function altiumPids() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + path.basename(EXE), '/FO', 'CSV', '/NH'],
      { encoding: 'latin1', windowsHide: true, timeout: 20000 });
    return String(out).split(/\r?\n/).map((l) => (l.match(/^"[^"]+","(\d+)"/) || [])[1]).filter(Boolean);
  } catch { return []; }
}
const foreignPids = () => altiumPids().filter((p) => !ourPids.has(String(p)));
function killPid(pid) {
  if (!pid) return;
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, timeout: 20000, stdio: 'ignore' }); } catch { /* gone */ }
}
function killAllAltium() {
  // Safe only after the startup guard proved this job is the sole Altium owner.
  try { execFileSync('taskkill', ['/F', '/IM', path.basename(EXE)], { windowsHide: true, timeout: 20000, stdio: 'ignore' }); } catch { /* none */ }
}
/** Main-window titles of running Altium instances (a trailing * means unsaved). */
function altiumWindowTitles() {
  const image = path.basename(EXE, path.extname(EXE));
  try {
    const out = execFileSync('powershell',
      ['-NoProfile', '-Command', "Get-Process '" + image + "' -ErrorAction SilentlyContinue | ForEach-Object { $_.MainWindowTitle }"],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

/**
 * Reuse the running Altium instance; only start one when none is running.
 * The user asked not to close/restart Altium between stages (or between jobs).
 * Returns the PID we started, or null when an existing instance is reused.
 */
function ensureAltium() {
  const running = altiumPids();
  if (running.length) {
    log('Altium: reusing the running instance PID ' + running.join(','));
    return null;
  }
  log('Altium: no instance running, starting one');
  const child = spawn(EXE, [], { detached: true, stdio: 'ignore' });
  const pid = child.pid;
  if (pid) ourPids.add(String(pid));
  child.unref();
  try {
    execFileSync('powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'altium', 'probe', 'waitready.ps1')],
      { encoding: 'latin1', timeout: 220000 });
  } catch { /* the job itself reports the failure */ }
  return pid;
}

const REGISTRY = path.join(ROOT, 'jobs', '_lib-registry.json');
function readRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch { return {}; }
}
function writeRegistry(reg) {
  try { fs.mkdirSync(path.dirname(REGISTRY), { recursive: true }); fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2)); } catch { /* best effort */ }
}
function namesPresent(file, candidates) {
  if (!fs.existsSync(file)) return [];
  const buf = fs.readFileSync(file);
  return candidates.filter((n) => n && (buf.includes(Buffer.from(n, 'latin1')) || buf.includes(Buffer.from(n, 'utf16le'))));
}

/** Folder name from the component name; strips Windows-invalid characters. */
function safeFolderName(value) {
  const name = String(value == null ? '' : value)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return name || 'component';
}

/**
 * Normalise every pin to the requested length while keeping the body edge fixed.
 * The parsed docs and the EasyEDA model both store a tip + an inward orientation;
 * the library emitter uses the body edge + outward orientation. Recomputing all
 * four keeps the generated SchDoc and the SchLib geometrically consistent.
 */
function applyPinLength(pins, length) {
  for (const pin of pins) {
    const apiOrient = ((Math.round((Number(pin.orient) || 0) / 90) * 90) % 360 + 360) % 360;
    const outward = ((apiOrient / 90) + 2) % 4;
    const dx = [1, 0, -1, 0][outward];
    const dy = [0, 1, 0, -1][outward];
    const oldLen = Number(pin.length) || 0;
    const bodyX = pin.bodyX != null ? Number(pin.bodyX) : (Number(pin.x) || 0) - dx * oldLen;
    const bodyY = pin.bodyY != null ? Number(pin.bodyY) : (Number(pin.y) || 0) - dy * oldLen;
    pin.bodyX = bodyX;
    pin.bodyY = bodyY;
    pin.outwardOrient = outward * 90;
    pin.length = length;
    pin.x = bodyX + dx * length;
    pin.y = bodyY + dy * length;
    pin.orient = ((outward + 2) & 3) * 90;
  }
  return pins;
}

/** The API model stores the footprint in mm; the document emitter works in mil. */
function apiFootprintToMil(fp) {
  const K = 39.37007874015748;
  // EasyEDA layer 101 (component marking, normally a pin-1 dot) is dropped:
  // LCEDA's own Altium export omits it, and the same mark already arrives as the
  // layer-3 silk arc. Filtering here keeps it out of the generated PcbDoc too,
  // so the document round-trip cannot reintroduce it.
  const keep = (item) => String(item && item.layer || '').toLowerCase() !== 'component_marking';
  const arcs = [
    // Real arcs (silk outlines parsed from ARC records). start/end are angles.
    ...(fp.arcs || []).filter(keep).map((a) => ({
      ...a, x: a.x * K, y: a.y * K, r: a.r * K, width: (a.width || 0.15) * K,
    })),
    // EasyEDA stores plain circles separately; a circle is a full 360-degree arc.
    ...(fp.circles || []).filter(keep).map((c) => ({
      layer: c.layer, x: c.x * K, y: c.y * K, r: c.r * K, start: 0, end: 360, width: (c.width || 0.15) * K,
    })),
  ];
  return {
    pads: (fp.pads || []).map((p) => ({
      ...p, x: p.x * K, y: p.y * K, w: p.w * K, h: p.h * K, hole: (p.hole || 0) * K,
      // Mask expansions are millimetres in the EasyEDA model too; the emitter
      // works in mil like every other footprint coordinate.
      pasteExpansion: (p.pasteExpansion || 0) * K,
      solderExpansion: (p.solderExpansion == null ? 0.0508 : p.solderExpansion) * K,
    })),
    tracks: (fp.tracks || []).filter(keep).map((t) => ({
      ...t, x1: t.x1 * K, y1: t.y1 * K, x2: t.x2 * K, y2: t.y2 * K, width: (t.width || 0.15) * K,
    })),
    arcs,
    // Filled SOLIDREGION polygons. The generated PcbDoc ASCII has no region-record
    // support yet, so the library stage receives these directly from the model.
    regions: (fp.regions || []).filter(keep).map((r) => ({
      ...r,
      points: (r.points || []).map(([x, y]) => [x * K, y * K]),
      holes: (r.holes || []).map((contour) => contour.map(([x, y]) => [x * K, y * K])),
    })),
  };
}

async function loadModel() {
  const fixture = path.join(ROOT, 'test', 'tmp-out', LCSC + '.json');
  if (process.env.ALLOW_FIXTURE === '1' && fs.existsSync(fixture)) {
    log('model: fixture ' + fixture);
    return JSON.parse(fs.readFileSync(fixture, 'utf8'));
  }
  const { fetchComponentModel } = await import('../app/lib/fetch-component.mjs');
  const model = await fetchComponentModel(LCSC);
  fs.mkdirSync(path.join(ROOT, 'jobs', LCSC), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'jobs', LCSC, 'component.json'), JSON.stringify(model, null, 2));
  return model;
}

/** Byte scan, not OLE-stream parsing: every pin name must appear in the file. */
function validateSingleLib(kind, file, model) {
  if (!fs.existsSync(file)) return { ok: false, why: 'missing ' + file };
  const buf = fs.readFileSync(file);
  if (kind === 'sch') {
    const names = model.symbol.pins.map((p) => String(p.name || '~'));
    const hits = names.filter((n) => n && buf.includes(Buffer.from(n, 'latin1'))).length;
    if (hits !== names.length) return { ok: false, why: 'pin names found ' + hits + '/' + names.length };
    return { ok: true, why: 'pins ' + hits + '/' + names.length };
  }
  const pkg = String(model.package || '');
  if (!pkg || !buf.includes(Buffer.from(pkg, 'latin1'))) return { ok: false, why: 'package "' + pkg + '" not in file' };
  return { ok: true, why: 'package found' };
}

async function runAltiumStage(stage, model, outDirOverride, options = {}) {
  const workDir = path.join(ROOT, 'jobs', LCSC + '-' + stage);
  const job = await emitScriptJob(model, {
    outDir: outDirOverride || OUT_DIR, schLibPath: LIB_SCH, pcbLibPath: LIB_PCB, workDir, steps: [stage],
    forcePcbLib: options.forcePcbLib === true,
    schLibCurrent: options.schLibCurrent === true,
    pcbLibCurrent: options.pcbLibCurrent === true,
  });
  const startupMs = Number(process.env.ALTIUM_STARTUP_MS || 180000);
  const res = await runAltiumJob(job, { timeoutMs: startupMs + 60000, startupMs, stallMs: 60000 });
  const lastOk = String(res.log).split(/\r?\n/).filter((l) => l.startsWith('OK')).pop() || '(none)';
  log('STAGE ' + stage + ' ok=' + res.ok + ' elapsed=' + res.elapsedMs + 'ms');
  log('  last OK: ' + lastOk);
  if (!res.ok) log('  error: ' + String(res.error || '').split('\n').slice(0, 3).join(' | '));
  return { stage, ok: res.ok, log: res.log };
}

/**
 * File-level proof that the PcbLib component has persisted primitives.
 * olefile reads the component Data stream; the blank built-in placeholder is
 * ~38 bytes, a real footprint is hundreds of bytes. Python/olefile is optional:
 * when unavailable the check is skipped (with a log line), never a false PASS
 * from the model count alone.
 */
function checkPcbLib(file, component, label) {
  const checker = path.join(ROOT, 'tools', 'pcblib-check.py');
  if (!fs.existsSync(checker)) { log('PADCHECK ' + label + ': skipped (checker missing)'); return null; }
  try {
    const out = execFileSync('python', [checker, file, component], { encoding: 'utf8', timeout: 30000 });
    log('PADCHECK ' + label + ' ' + out.trim());
    return true;
  } catch (err) {
    const out = String((err && err.stdout) || '').trim() + String((err && err.stderr) || '').trim();
    if (err && err.code === 'ENOENT' || /No module named olefile/.test(out)) {
      log('PADCHECK ' + label + ': skipped (python/olefile unavailable)');
      return null;
    }
    log('PADCHECK ' + label + ' FAILED ' + out);
    return false;
  }
}

async function main() {
  const DOC_ONLY = process.env.DOC_ONLY === '1';
  if (!DOC_ONLY) {
    const unsaved = altiumWindowTitles().filter((t) => t.includes('*'));
    if (unsaved.length && process.env.ALLOW_UNSAVED !== '1') {
      fail('检测到 Altium 有未保存文档：' + unsaved.join(' | ') + '。请先 Ctrl+S 保存（不用关闭 Altium），再重试。', 3);
    }
  }
  const model = await loadModel();
  const wantPins = model.symbol.pins.length;
  const wantPads = model.footprint.pads.length;
  log('model: ' + model.lcsc + ' ' + (model.package || '') + ' pins=' + wantPins + ' pads=' + wantPads
    + ' designator=' + (String(model.designatorPrefix || '').toUpperCase().replace(/[^A-Z]/g, '') || 'U') + '??');
  log('paths: OUT_DIR=' + OUT_DIR);
  log('paths: LIB_SCH=' + LIB_SCH);
  log('paths: LIB_PCB=' + LIB_PCB);
  const componentName = safeFolderName(model.mpn || model.lcsc);
  const componentDir = path.join(OUT_DIR, componentName);
  const keepIntermediateDir = KEEP_DOCS || MAKE_PART_LIBS;
  if (keepIntermediateDir) fs.mkdirSync(componentDir, { recursive: true });
  log('options: KEEP_DOCS=' + KEEP_DOCS + ' MAKE_PART_LIBS=' + MAKE_PART_LIBS
    + ' componentDir=' + (keepIntermediateDir ? componentDir : '(none)'));
  for (const dir of [OUT_DIR, path.dirname(LIB_SCH), path.dirname(LIB_PCB)]) fs.mkdirSync(dir, { recursive: true });

  // ---- P1: generate the Altium ASCII documents from the EasyEDA data API ----
  // No browser and no web editor: the same public API that feeds the search box
  // supplies the symbol/footprint geometry, and the writer emits the Altium
  // ASCII 5.0 records that the web export would have produced.
  const schDocPath = path.join(OUT_DIR, LCSC + '_SCH.SchDoc');
  const pcbDocPath = path.join(OUT_DIR, LCSC + '_PCB.PcbDoc');
  const modelMil = {
    ...model,
    symbol: { ...model.symbol, pins: (model.symbol.pins || []).map((p) => ({ ...p })) },
    footprint: apiFootprintToMil(model.footprint || {}),
  };
  applyPinLength(modelMil.symbol.pins, PIN_LENGTH_MIL);
  const schBuilt = buildSchDoc(modelMil);
  const pcbBuilt = buildPcbDoc(modelMil);
  fs.writeFileSync(schDocPath, schBuilt.text, 'latin1');
  fs.writeFileSync(pcbDocPath, pcbBuilt.text, 'latin1');
  log('P1 source=easyeda-api sch=' + Buffer.byteLength(schBuilt.text, 'latin1') + 'B pcb='
    + Buffer.byteLength(pcbBuilt.text, 'latin1') + 'B skippedShapes=' + schBuilt.skippedShapes
    + ' skippedPrimitives=' + pcbBuilt.skippedPrimitives);

  // ---- P2: parse the generated ASCII documents back ----
  let docModel = model;
  let docSource = 'api-model';
  try {
    const schParsed = parseSchDoc(schBuilt.text);
    const pcbParsed = parsePcbDoc(pcbBuilt.text);
    log('DOCS parsed source=generated sch pins=' + schParsed.stats.pins + ' rects=' + schParsed.stats.rects
      + ' ellipses=' + schParsed.stats.ellipses + ' arcs=' + schParsed.stats.arcs
      + ' polylines=' + schParsed.stats.polylines + ' polygons=' + schParsed.stats.polygons
      + ' | pcb pads=' + pcbParsed.stats.pads
      + ' tracks=' + pcbParsed.stats.tracks + ' arcs=' + pcbParsed.stats.arcs
      + ' regions=' + pcbParsed.stats.regions + ' texts=' + pcbParsed.stats.texts);
    if (schParsed.stats.pins !== wantPins) {
      fail('生成的 SchDoc 引脚数 ' + schParsed.stats.pins + ' 与元件模型 ' + wantPins + ' 不一致');
    }
    if (pcbParsed.stats.pads !== wantPads) {
      fail('生成的 PcbDoc 焊盘数 ' + pcbParsed.stats.pads + ' 与元件模型 ' + wantPads + ' 不一致');
    }
    // The ASCII PcbDoc record has no place for the pad mask expansions, so take
    // them from the source model (keyed by pad number) while keeping every
    // geometry field from the parsed document.
    const apiPads = new Map(
      (modelMil.footprint.pads || []).map((p) => [String(p.number), p]),
    );
    docModel = {
      ...model,
      package: pcbParsed.pattern || model.package,
      symbol: { pins: schParsed.pins, shapes: schParsed.shapes, texts: [] },
      footprint: {
        pads: pcbParsed.pads.map((p) => {
          const api = apiPads.get(String(p.number));
          return {
            ...p,
            pasteExpansion: api ? api.pasteExpansion : 0,
            solderExpansion: api ? api.solderExpansion : 2,
          };
        }),
        tracks: pcbParsed.tracks,
        arcs: pcbParsed.arcs,
        // Region records are not reproducible in the ASCII PcbDoc writer yet;
        // carry the filled shapes over from the source model (already in mil).
        regions: modelMil.footprint.regions || [],
      },
    };
    docSource = 'generated-doc';
    fs.mkdirSync(path.join(ROOT, 'jobs', LCSC), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'jobs', LCSC, 'parsed-docs.json'), JSON.stringify({
      sch: schParsed, pcb: pcbParsed,
    }, null, 2));
  } catch (err) {
    log('DOCS parse failed: ' + String(err && err.message || err).split('\n')[0]);
    log('DOCS falling back to the EasyEDA model (the generated documents are still delivered)');
    const fallbackPins = (model.symbol.pins || []).map((p) => ({ ...p }));
    applyPinLength(fallbackPins, PIN_LENGTH_MIL);
    docModel = {
      ...model,
      symbol: { ...model.symbol, pins: fallbackPins },
      footprint: apiFootprintToMil(model.footprint || {}),
    };
  }
  const pkg = String(docModel.package || '');
  log('DOCS source=' + docSource + ' package=' + pkg + ' pins=' + docModel.symbol.pins.length
    + ' pads=' + docModel.footprint.pads.length
    + ' regions=' + ((docModel.footprint.regions || []).length));

  if (KEEP_DOCS) {
    fs.mkdirSync(componentDir, { recursive: true });
    fs.copyFileSync(schDocPath, path.join(componentDir, LCSC + '_SCH.SchDoc'));
    fs.copyFileSync(pcbDocPath, path.join(componentDir, LCSC + '_PCB.PcbDoc'));
    log('KEEP_DOCS saved to ' + componentDir);
  }

  if (DOC_ONLY) {
    const keptDocs = KEEP_DOCS
      ? [path.join(componentDir, LCSC + '_SCH.SchDoc'), path.join(componentDir, LCSC + '_PCB.PcbDoc')]
      : [schDocPath, pcbDocPath];
    for (const p of keptDocs) {
      const st = fs.statSync(p);
      artifacts.push({ path: p, bytes: st.size });
    }
    log('DOC_ONLY=1: stopped before the Altium stages');
    log('RESULT: PASS (DOC_ONLY)');
    log('RESULT_JSON ' + JSON.stringify({
      ok: true, docOnly: true, lcsc: LCSC, outDir: OUT_DIR, schLib: LIB_SCH, pcbLib: LIB_PCB,
      counts: { schPins: docModel.symbol.pins.length, pcbPads: docModel.footprint.pads.length },
      source: docSource, artifacts,
    }));
    return;
  }

  // ---- before/after names for the target libraries ----
  const registry = readRegistry();
  const versions = (registry.__versions && typeof registry.__versions === 'object') ? registry.__versions : {};
  const libName = toAscii(model.mpn || model.lcsc).trim() || model.lcsc;
  const schCurrent = versions[LIB_SCH] === LIB_MARKER_SCH && fs.existsSync(LIB_SCH)
    && namesPresent(LIB_SCH, [libName]).length > 0;
  const pcbCurrent = versions[LIB_PCB] === LIB_MARKER_PCB && fs.existsSync(LIB_PCB)
    && !!pkg && namesPresent(LIB_PCB, [pkg]).length > 0;
  log('LIB VERSION schlib=' + (versions[LIB_SCH] || '(none)') + ' current=' + schCurrent);
  log('LIB VERSION pcblib=' + (versions[LIB_PCB] || '(none)') + ' current=' + pcbCurrent);
  const schNames = Array.from(new Set([...(registry[LIB_SCH] || []), libName, LCSC]));
  const pcbNames = Array.from(new Set([...(registry[LIB_PCB] || []), pkg]));
  const sizeOf = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
  const before = {
    sch: { bytes: sizeOf(LIB_SCH), names: namesPresent(LIB_SCH, schNames) },
    pcb: { bytes: sizeOf(LIB_PCB), names: namesPresent(LIB_PCB, pcbNames) },
  };
  log('LIB BEFORE schlib target=' + LIB_SCH + ' bytes=' + before.sch.bytes + ' comps=[' + before.sch.names.join(',') + ']');
  log('LIB BEFORE pcblib target=' + LIB_PCB + ' bytes=' + before.pcb.bytes + ' comps=[' + before.pcb.names.join(',') + ']');

  // A footprint written by an older emitter has fewer primitives (no rotated pads,
  // no NPTH holes, no silk arcs). Unlike SchLib, the PcbLib API can remove a single
  // component, so rewrite just that component instead of silently keeping the old
  // drawing. Without this the version marker would report "stale" but never refresh.
  const forceStalePcb = !pcbCurrent && !!pkg && before.pcb.names.includes(pkg);
  if (forceStalePcb) {
    log('PCB STALE: ' + pkg + ' predates ' + LIB_MARKER_PCB + '; it will be removed and redrawn');
  }

  // The SchLib API has no usable RemoveComponent. If the target already contains
  // this part but it predates the current geometry marker, replace the file only
  // when the registry says this is the sole component; otherwise leave the user's
  // library untouched and fail with a clear instruction.
  let skipSchMerge = false;
  {
    const schHasOld = namesPresent(LIB_SCH, [LCSC]).length > 0;
    const schHasNew = namesPresent(LIB_SCH, [libName]).length > 0;
    if ((schHasOld || schHasNew) && !schCurrent) {
      const others = before.sch.names.filter((n) => n && n !== LCSC && n !== libName);
      if (others.length) {
        skipSchMerge = true;
        problems.push('target SchLib contains other components (' + others.join(',') + '); cannot auto-replace '
          + libName + '. Delete it in Altium or use a new target SchLib path.');
      } else {
        const backup = LIB_SCH + '.bak-' + Date.now();
        try {
          fs.renameSync(LIB_SCH, backup);
          log('SCHLIB repair: old target moved to ' + backup);
          log('SCHLIB repair: the target will be recreated with the current pins/border geometry');
        } catch (err) {
          skipSchMerge = true;
          problems.push('target SchLib is locked (' + err.message + '); close that document in Altium '
            + '(Altium itself can stay open) and retry.');
        }
      }
    }
  }

  // ---- P3/P4: reuse one Altium instance; build directly in the target libraries ----
  // PcbLib first so the footprint exists when the SchLib implementation/datafile
  // link is attached. No intermediate single-part libraries.
  ensureAltium();
  const results = [];
  let failedStage = null;
  for (const stage of STAGES) {
    if (failedStage) break;
    if (stage === 'schlib' && skipSchMerge) {
      log('SKIP schlib: target SchLib cannot be replaced safely (see PROBLEM below)');
      continue;
    }
    const isPartStage = stage === 'pcblib_part' || stage === 'schlib_part';
    const stageOut = isPartStage ? componentDir : OUT_DIR;
    fs.mkdirSync(stageOut, { recursive: true });
    const res = await runAltiumStage(stage, docModel, stageOut, {
      schLibCurrent: schCurrent,
      pcbLibCurrent: pcbCurrent,
      forcePcbLib: stage === 'pcblib' && forceStalePcb,
    });
    results.push(res);
    if (!res.ok) failedStage = stage;
    if (stage === 'pcblib' && res.ok) {
      const padOk = checkPcbLib(LIB_PCB, pkg, 'target PcbLib');
      if (padOk === false && /idempotent skip/.test(String(res.log))) {
        // The target already had this name but its saved component was empty.
        log('PADCHECK target PcbLib: existing component is empty; rewriting it once');
        const res2 = await runAltiumStage('pcblib', docModel, OUT_DIR, { forcePcbLib: true });
        results.push(res2);
        if (!res2.ok) failedStage = 'pcblib';
        else {
          const repairOk = checkPcbLib(LIB_PCB, pkg, 'target PcbLib (rewritten)');
          if (repairOk === false) problems.push('target PcbLib: still empty after the rewrite');
        }
      } else if (padOk === false) {
        problems.push('target PcbLib: component has no persisted primitives');
      }
    }
    if (stage === 'pcblib_part' && res.ok) {
      const partPcb = path.join(componentDir, LCSC + '_PCB.PcbLib');
      const pc = checkPcbLib(partPcb, pkg, 'part PcbLib');
      if (pc === false) problems.push('part PcbLib: component has no persisted primitives');
    }
    if (stage === 'schlib_part' && res.ok) {
      const partSch = path.join(componentDir, LCSC + '_SCH.SchLib');
      const chk = validateSingleLib('sch', partSch, docModel);
      if (!chk.ok) problems.push('part SchLib: ' + chk.why);
      if (namesPresent(partSch, [libName]).length === 0) {
        problems.push('part SchLib: libref ' + libName + ' not found');
      }
    }
  }

  const after = {
    sch: { bytes: sizeOf(LIB_SCH), names: namesPresent(LIB_SCH, schNames) },
    pcb: { bytes: sizeOf(LIB_PCB), names: namesPresent(LIB_PCB, pcbNames) },
  };
  registry[LIB_SCH] = after.sch.names;
  registry[LIB_PCB] = after.pcb.names;
  const schStage = results.find((r) => r.stage === 'schlib');
  if (!skipSchMerge && schStage && schStage.ok && namesPresent(LIB_SCH, [libName]).length) {
    versions[LIB_SCH] = LIB_MARKER_SCH;
  }
  const pcbStages = results.filter((r) => r.stage === 'pcblib');
  if (pcbStages.length && pcbStages.some((r) => r.ok) && !!pkg && namesPresent(LIB_PCB, [pkg]).length) {
    versions[LIB_PCB] = LIB_MARKER_PCB;
  }
  registry.__versions = versions;
  writeRegistry(registry);
  log('LIB AFTER  schlib target=' + LIB_SCH + ' bytes=' + after.sch.bytes + ' comps=[' + after.sch.names.join(',') + ']');
  log('LIB AFTER  pcblib target=' + LIB_PCB + ' bytes=' + after.pcb.bytes + ' comps=[' + after.pcb.names.join(',') + ']');
  if ((after.sch.names.length && !after.sch.names.includes(libName)) || (pkg && after.pcb.names.length && !after.pcb.names.includes(pkg))) {
    problems.push('merge self-check failed: the target library lost a component name it had before');
  }

  const skipped = (stage) => results.some((r) => r.stage === stage && /idempotent skip/.test(String(r.log)));
  function checkFile(label, file, floor) {
    if (!fs.existsSync(file)) { problems.push(label + ': missing ' + file); return null; }
    const st = fs.statSync(file);
    if (st.size <= 1024) problems.push(label + ': only ' + st.size + ' bytes');
    if (floor != null && st.mtimeMs < floor) problems.push(label + ': stale, older than this run');
    return st;
  }
  const exportFloor = startedAt - 3600 * 1000;
  const schSt = checkFile('SchDoc', schDocPath, exportFloor);
  const pcbSt = checkFile('PcbDoc', pcbDocPath, exportFloor);
  const schLibSt = skipSchMerge ? null : checkFile('SchLib', LIB_SCH, skipped('schlib') ? null : startedAt);
  const pcbLibSt = checkFile('PcbLib', LIB_PCB, skipped('pcblib') ? null : startedAt);
  const fileHasText = (file, text) => {
    const buf = fs.readFileSync(file);
    return buf.includes(Buffer.from(text, 'latin1')) || buf.includes(Buffer.from(text, 'utf16le'));
  };
  if (schSt) {
    const c = countDocumentRecords(fs.readFileSync(schDocPath));
    if (!c || c.pins !== wantPins) problems.push('SchDoc content: ' + JSON.stringify(c) + ' but model wants pins=' + wantPins);
  }
  if (pcbSt) {
    const buf = fs.readFileSync(pcbDocPath);
    if (buf.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') {
      log('  note: PcbDoc saved as an OLE container; pad count is proven by the pcblib COUNT line');
    } else {
      const c = countDocumentRecords(buf);
      if (c && c.kind === 'pcbdoc' && (c.comps < 1 || c.pads !== wantPads)) problems.push('PcbDoc content: ' + JSON.stringify(c) + ' but model wants pads=' + wantPads);
    }
  }
  if (pcbLibSt && pkg && !fileHasText(LIB_PCB, pkg)) problems.push('PcbLib: component name "' + pkg + '" not found in the saved library');
  if (schLibSt && !fileHasText(LIB_SCH, libName)) problems.push('SchLib: libref ' + libName + ' not found in the saved library');

  for (const stage of ['schlib', 'pcblib']) {
    if (stage === 'schlib' && skipSchMerge) continue;
    const r = results.find((x) => x.stage === stage);
    const line = r ? String(r.log).split(/\r?\n/).find((l) => new RegExp('^COUNT ' + stage).test(l)) : null;
    if (!line) { problems.push(stage + ': no COUNT line'); continue; }
    if (stage === 'schlib') {
      if (!new RegExp('pins=' + wantPins + '\\b').test(line)) problems.push(stage + ': pins mismatch: ' + line);
    } else {
      if (!new RegExp('pads=' + wantPads + '\\b').test(line)) problems.push(stage + ': pads mismatch: ' + line);
      const m = line.match(/comps=(\d+) before=(\d+)/);
      // A fresh PCBLIB also contains the built-in blank component, so the total can
      // grow by more than one. Require at least one new component; the real proof
      // that the footprint exists is PADCHECK on the saved file.
      if (m && !skipped(stage) && Number(m[1]) < Number(m[2]) + 1) {
        problems.push(stage + ': no component was added: ' + line);
      }
    }
  }
  for (const [label, st] of [['SchDoc', schSt], ['PcbDoc', pcbSt], ['SchLib', schLibSt], ['PcbLib', pcbLibSt]]) {
    if (st) log('  ' + label + ': ' + st.size + ' bytes');
  }
  for (const r of results) {
    for (const l of String(r.log).split(/\r?\n/)) if (l.startsWith('COUNT') || l.startsWith('DONE')) log('  ' + r.stage + ' | ' + l);
  }
  if (KEEP_DOCS) {
    for (const [label, name] of [['SchDoc kept', LCSC + '_SCH.SchDoc'], ['PcbDoc kept', LCSC + '_PCB.PcbDoc']]) {
      const f = path.join(componentDir, name);
      const st = checkFile(label, f, null);
      if (st) artifacts.push({ path: f, bytes: st.size });
    }
  }
  if (MAKE_PART_LIBS) {
    for (const [label, name] of [['PartSchLib', LCSC + '_SCH.SchLib'], ['PartPcbLib', LCSC + '_PCB.PcbLib']]) {
      const f = path.join(componentDir, name);
      const st = checkFile(label, f, null);
      if (st) artifacts.push({ path: f, bytes: st.size });
    }
  }
  if (schLibSt) artifacts.push({ path: LIB_SCH, bytes: schLibSt.size });
  if (pcbLibSt) artifacts.push({ path: LIB_PCB, bytes: pcbLibSt.size });

  if (ourPids.size) log('Altium left running (PID ' + [...ourPids].join(',') + '); the next job will reuse it.');
  if (failedStage || problems.length) {
    for (const p of problems) log('  PROBLEM: ' + p);
    fail(failedStage ? 'stage ' + failedStage + ' failed' : problems.join('; '), 1);
  }

  // ---- cleanup: keep only the target libraries (plus the version registry) ----
  function forceRm(p) {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(p); } catch { /* ignore */ }
      for (const n of names) forceRm(path.join(p, n));
      try { fs.rmdirSync(p); } catch { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* locked */ } }
    } else {
      try { fs.chmodSync(p, 0o666); } catch { /* ignore */ }
      try { fs.unlinkSync(p); } catch { try { fs.rmSync(p, { force: true }); } catch { /* locked */ } }
    }
  }
  for (const f of [
    schDocPath, pcbDocPath,
    path.join(OUT_DIR, LCSC + '_SCH.SchLib'),
    path.join(OUT_DIR, LCSC + '_PCB.PcbLib'),
    path.join(OUT_DIR, '_source', LCSC + '_SCH.SchDoc'),
    path.join(OUT_DIR, '_source', LCSC + '_PCB.PcbDoc'),
  ]) forceRm(f);
  for (const d of [
    path.join(OUT_DIR, '_source'), path.join(OUT_DIR, '.tmp'),
    path.join(OUT_DIR, 'History'), path.join(OUT_DIR, '__Previews'),
  ]) forceRm(d);
  try {
    const jobsDir = path.join(ROOT, 'jobs');
    for (const e of fs.readdirSync(jobsDir)) {
      if (e === '_lib-registry.json') continue;
      if (e === LCSC || e.startsWith(LCSC + '-')) forceRm(path.join(jobsDir, e));
    }
  } catch { /* jobs dir absent */ }
  for (const lib of [LIB_SCH, LIB_PCB]) {
    const dir = path.dirname(lib);
    const base = path.basename(lib);
    forceRm(path.join(dir, 'History'));
    forceRm(path.join(dir, '__Previews'));
    try {
      for (const e of fs.readdirSync(dir)) {
        if (e.startsWith(base + '.bak-')) forceRm(path.join(dir, e));
      }
    } catch { /* dir absent */ }
  }
  log('CLEANUP intermediates removed; target libraries kept'
    + (keepIntermediateDir ? '; kept ' + componentDir : ''));

  log('RESULT: PASS');
  log('RESULT_JSON ' + JSON.stringify({
    ok: true, lcsc: LCSC, outDir: OUT_DIR, schLib: LIB_SCH, pcbLib: LIB_PCB,
    componentDir: keepIntermediateDir ? componentDir : null,
    options: { keepDocs: KEEP_DOCS, makePartLibs: MAKE_PART_LIBS },
    counts: { schPins: docModel.symbol.pins.length, pcbPads: docModel.footprint.pads.length },
    source: docSource,
    artifacts,
  }));
}

main().catch((err) => {
  const raw = String((err && err.message) || err);
  const reason = /404|not found|不存在|no such/i.test(raw)
    ? '元件不存在 ' + LCSC + '（上游 code=404）'
    : raw.split('\n')[0];
  log('PROBLEM: ' + reason);
  fail(reason, 1);
});
