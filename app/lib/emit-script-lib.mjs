// emit-script-lib.mjs - turn the parsed Altium ASCII documents into a self-contained
// Altium DelphiScript job. No UI automation: the script creates the SchLib/PcbLib
// components through the Altium scripting API, exactly the object model that
// Design >> Make Schematic Library / Make PCB Library would create.
//
// Geometry source: parseSchDoc()/parsePcbDoc() from doc-parse.mjs. Symbol units are
// mil; footprint units are mil and are converted to mm for MMsToCoord (the API used
// by the already-verified PCB template).
//
// emitScriptJob(model, opts) -> same shape as the legacy emitAltiumJob().

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';
import { validatePas, toAscii } from './emit-altium.mjs';

const DEFAULT_ALTIUM_EXE = 'E:\\AD\\AD\\X2.EXE';
const KNOWN_STEPS = ['schlib_part', 'schlib', 'pcblib_part', 'pcblib'];
// Bump this whenever the generated SchLib geometry changes. It is written into
// the component description so the pipeline can tell an old library component
// (no marker) from a current one and replace it instead of idempotent-skipping.
export const LIB_MARKER = 'LCEDA2AD-v9-p' + (process.env.PIN_LENGTH_MIL || 150);
// Visible Value is placed just beyond the lower-right corner of the whole symbol
// (body + pin tips) and uses TopLeft justification, so the text extends away from
// the component instead of overlapping it.
const VALUE_MARGIN_MIL = 20;
const TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'altium', 'template-script.pas');

const MIL_PER_MM = 39.37007874015748;
const mm = (mil) => (Number(mil) || 0) / MIL_PER_MM;

const pasEsc = (value) => toAscii(value == null ? '' : String(value)).replace(/'/g, "''");
const quote = (value) => "'" + pasEsc(value) + "'";

// The generated .pas is written as GBK (the system code page on Chinese Windows),
// so raw Chinese / Ω / ± in a Pascal string literal are decoded correctly by
// Altium's script compiler. Keep the quotes escaped; do not ASCII-fold this text.
const quoteWide = (value) => "'" + String(value == null ? '' : value).replace(/'/g, "''") + "'";
const int = (value) => String(Math.round(Number(value) || 0));
function num(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '0.0';
  const s = String(Math.round(v * 1e6) / 1e6);
  return s.indexOf('.') >= 0 ? s : s + '.0';
}

const PAD_SHAPE = { round: 'eRounded', rect: 'eRectangular', octagonal: 'eOctagonal' };
const PCB_LAYER = {
  top: 'eTopLayer', bottom: 'eBottomLayer', multi: 'eMultiLayer',
  top_overlay: 'eTopOverlay', bottom_overlay: 'eBottomOverlay',
  top_paste: 'eTopPaste', bottom_paste: 'eBottomPaste',
  top_solder: 'eTopSolder', bottom_solder: 'eBottomSolder',
};
const padShape = (s) => PAD_SHAPE[String(s || '').toLowerCase()] || 'eRectangular';
const pcbLayer = (l) => PCB_LAYER[String(l || '').toLowerCase()] || 'eTopLayer';

/**
 * SchLib Pin.Location is the point where the pin meets the body, and
 * Pin.Orientation points outward. The parsed documents store exactly that in
 * bodyX/bodyY/outwardOrient. For the API fallback model we derive it from the
 * tip + inward orientation.
 */
function libPinPlacement(pin) {
  const length = Number(pin.length) || 0;
  if (pin.bodyX != null && pin.bodyY != null && pin.outwardOrient != null) {
    return { x: Number(pin.bodyX), y: Number(pin.bodyY), orient: Number(pin.outwardOrient) };
  }
  const apiOrient = ((Math.round((Number(pin.orient) || 0) / 90) * 90) % 360 + 360) % 360;
  const outward = ((apiOrient / 90) + 2) % 4;
  const dx = [1, 0, -1, 0][outward];
  const dy = [0, 1, 0, -1][outward];
  return { x: (Number(pin.x) || 0) - dx * length, y: (Number(pin.y) || 0) - dy * length, orient: outward * 90 };
}

/** Bounding box of the drawn symbol body + pin tips (rect/ellipse/polyline/polygon), mil. */
function symbolBBox(shapes, pins) {
  let minX = 0, minY = 0, maxX = 0, maxY = 0, has = false;
  const add = (x, y) => {
    const px = Number(x) || 0;
    const py = Number(y) || 0;
    if (!has) { minX = maxX = px; minY = maxY = py; has = true; return; }
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  };
  for (const sh of shapes || []) {
    const kind = String(sh.kind || '').toLowerCase();
    if (kind === 'rect') {
      add(sh.x1, sh.y1); add(sh.x2, sh.y2);
    } else if (kind === 'ellipse') {
      const rx = Number(sh.rx) || 0;
      const ry = Number(sh.ry) || 0;
      add((Number(sh.x) || 0) - rx, (Number(sh.y) || 0) - ry);
      add((Number(sh.x) || 0) + rx, (Number(sh.y) || 0) + ry);
    } else if (kind === 'polyline' || kind === 'polygon') {
      for (const p of sh.points || []) add(p[0], p[1]);
    }
  }
  // Pin tips stick out beyond the body; include them so the Value never lands on
  // a pin. libPinPlacement() gives the body attachment point + outward direction.
  for (const pin of pins || []) {
    const p = libPinPlacement(pin);
    const length = Number(pin.length) || 0;
    const dir = ((Math.round((Number(p.orient) || 0) / 90) % 4) + 4) % 4;
    add(p.x, p.y);
    add(p.x + [1, 0, -1, 0][dir] * length, p.y + [0, 1, 0, -1][dir] * length);
  }
  return { minX, minY, maxX, maxY };
}

/** BuildSymbol body: shapes first, then pins (units: mil). */
export function buildSymbolBody(model, lcsc) {
  const out = [];
  const sym = model.symbol || {};
  const libName = toAscii(model.mpn || lcsc).trim() || lcsc;
  out.push("    W('BS libref');");
  out.push('    Target.LibReference         := ' + quote(libName) + ';');
  out.push("    W('BS designitemid');");
  out.push('    Target.DesignItemID         := ' + quote(libName) + ';');
  out.push("    W('BS description');");
  out.push('    Target.ComponentDescription := ' + quoteWide(model.description || '') + ';');
  out.push("    W('BS designator');");
  out.push("    Target.Designator.Text      := 'U??';");
  out.push("    W('BS commenttext');");
  out.push('    Target.Comment.Text         := ' + quote(libName) + ';');
  out.push("    W('BS commenthidden');");
  out.push('    Target.Comment.IsHidden     := True;');
  const value = String(model.value || '').trim();
  if (value) {
    const bbox = symbolBBox(sym.shapes, sym.pins);
    const valueX = Math.round(bbox.maxX + VALUE_MARGIN_MIL);
    const valueY = Math.round(bbox.minY - VALUE_MARGIN_MIL);
    out.push("    W('BS valueparam " + valueX + "," + valueY + "');");
    out.push("    AddParameter(Target, 'Value', " + quoteWide(value) + ', False, ' + valueX + ', ' + valueY + ');');
  }
  for (const sh of sym.shapes || []) {
    const kind = String(sh.kind || '').toLowerCase();
    if (kind === 'rect') {
      out.push('    AddRect(Target, ' + [sh.x1, sh.y1, sh.x2, sh.y2].map(int).join(', ') + ');');
    } else if (kind === 'ellipse') {
      out.push('    AddEllipse(Target, ' + [sh.x, sh.y, sh.rx, sh.ry].map(int).join(', ') + ');');
    } else if (kind === 'polyline' || kind === 'polygon') {
      const pts = Array.isArray(sh.points) ? sh.points : [];
      for (let i = 0; i + 1 < pts.length; i++) {
        out.push('    AddLine(Target, ' + [pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]].map(int).join(', ') + ');');
      }
    }
  }
  for (const pin of sym.pins || []) {
    const p = libPinPlacement(pin);
    out.push('    AddPin(Target, ' + quote(pin.number) + ', ' + quote(pin.name || '~') + ', '
      + [p.x, p.y, pin.length, p.orient].map(int).join(', ') + ', '
      + quote(String(pin.electrical || 'passive').toLowerCase()) + ');');
  }
  return out.join('\n');
}

/** Footprint primitives inlined against a concrete owner expression. Units: mil -> mm. */
export function buildFootprintBody(model, owner) {
  const fp = model.footprint || {};
  const out = [];
  for (const pad of fp.pads || []) {
    out.push(
      '        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);',
      '        Pad.Mode     := ePadMode_Simple;',
      '        Pad.Layer    := ' + pcbLayer(pad.layer) + ';',
      '        Pad.TopShape := ' + padShape(pad.shape) + ';',
      '        Pad.TopXSize := MMsToCoord(' + num(mm(pad.w)) + ');',
      '        Pad.TopYSize := MMsToCoord(' + num(mm(pad.h)) + ');',
      '        Pad.X        := MMsToCoord(' + num(mm(pad.x)) + ');',
      '        Pad.Y        := MMsToCoord(' + num(mm(pad.y)) + ');',
      '        Pad.Name     := ' + quote(pad.number) + ';',
      '        Pad.HoleSize := MMsToCoord(' + num(mm(pad.hole)) + ');',
      '        ' + owner + '.AddPCBObject(Pad);',
    );
  }
  for (const trk of fp.tracks || []) {
    out.push(
      '        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);',
      '        Trk.Layer := ' + pcbLayer(trk.layer) + ';',
      '        Trk.Width := MMsToCoord(' + num(mm(trk.width == null ? 0.15 : trk.width)) + ');',
      '        Trk.X1    := MMsToCoord(' + num(mm(trk.x1)) + ');',
      '        Trk.Y1    := MMsToCoord(' + num(mm(trk.y1)) + ');',
      '        Trk.X2    := MMsToCoord(' + num(mm(trk.x2)) + ');',
      '        Trk.Y2    := MMsToCoord(' + num(mm(trk.y2)) + ');',
      '        ' + owner + '.AddPCBObject(Trk);',
    );
  }
  for (const arc of fp.arcs || []) {
    out.push(
      '        Arc := PCBServer.PCBObjectFactory(eArcObject, eNoDimension, eCreate_Default);',
      '        Arc.Layer      := ' + pcbLayer(arc.layer) + ';',
      '        Arc.LineWidth  := MMsToCoord(' + num(mm(arc.width == null ? 0.15 : arc.width)) + ');',
      '        Arc.XCenter    := MMsToCoord(' + num(mm(arc.x)) + ');',
      '        Arc.YCenter    := MMsToCoord(' + num(mm(arc.y)) + ');',
      '        Arc.Radius     := MMsToCoord(' + num(mm(arc.r)) + ');',
      '        Arc.StartAngle := ' + num(arc.start == null ? 0 : arc.start) + ';',
      '        Arc.EndAngle   := ' + num(arc.end == null ? 360 : arc.end) + ';',
      '        ' + owner + '.AddPCBObject(Arc);',
    );
  }
  return out.join('\n');
}

function fileHasName(filePath, name) {
  try {
    const buf = fs.readFileSync(filePath);
    return buf.includes(Buffer.from(String(name), 'utf16le')) || buf.includes(Buffer.from(String(name), 'latin1'));
  } catch {
    return false;
  }
}

/**
 * emitScriptJob(model, { outDir, schLibPath, pcbLibPath, workDir, steps })
 * model.symbol   = { pins:[{number,name,x,y,length,orient,electrical}], shapes:[...] }
 * model.footprint= { pads:[...], tracks:[...], arcs:[...] }
 */
export async function emitScriptJob(model, opts = {}) {
  if (!model || typeof model !== 'object') throw new Error('emitScriptJob: model is required');
  const lcsc = toAscii(model.lcsc || '').trim();
  if (!lcsc) throw new Error('emitScriptJob: model.lcsc is required');
  const pins = (model.symbol && model.symbol.pins) || [];
  const pads = (model.footprint && model.footprint.pads) || [];
  if (!Array.isArray(pins) || pins.length === 0) throw new Error('emitScriptJob: model.symbol.pins is empty');
  if (!Array.isArray(pads) || pads.length === 0) throw new Error('emitScriptJob: model.footprint.pads is empty');

  const requested = Array.isArray(opts.steps) ? opts.steps.filter((s) => KNOWN_STEPS.indexOf(s) >= 0) : [];
  const steps = requested.length ? requested : KNOWN_STEPS;

  const outDir = path.resolve(opts.outDir || path.join(process.cwd(), 'out'));
  const workDir = path.resolve(opts.workDir || path.join(process.cwd(), 'jobs', lcsc));
  const schLibPath = path.resolve(opts.schLibPath || path.join(process.cwd(), 'library', 'MyLib.SchLib'));
  const pcbLibPath = path.resolve(opts.pcbLibPath || path.join(process.cwd(), 'library', 'MyLib.PcbLib'));
  for (const dir of [outDir, workDir, path.dirname(schLibPath), path.dirname(pcbLibPath)]) fs.mkdirSync(dir, { recursive: true });

  const paths = {
    workDir,
    logPath: path.join(workDir, 'job.log'),
    pasPath: path.join(workDir, 'job.pas'),
    prjScrPath: path.join(workDir, 'job.PrjScr'),
    cmdPath: path.join(workDir, 'run-job.cmd'),
    partSchLibPath: path.join(outDir, lcsc + '_SCH.SchLib'),
    partPcbLibPath: path.join(outDir, lcsc + '_PCB.PcbLib'),
  };

  const pkg = String(model.package || lcsc);
  const libName = toAscii(model.mpn || lcsc).trim() || lcsc;
  const flags = {
    schLibExists: fs.existsSync(schLibPath),
    pcbLibExists: fs.existsSync(pcbLibPath),
    schLibHasComp: fileHasName(schLibPath, libName),
    pcbLibHasComp: fileHasName(pcbLibPath, pkg),
  };

  const runJobLines = [];
  if (steps.indexOf('schlib_part') >= 0) runJobLines.push('    StepSchLibPart;');
  if (steps.indexOf('schlib') >= 0) runJobLines.push('    StepSchLib;');
  if (steps.indexOf('pcblib_part') >= 0) runJobLines.push('    StepPcbLibPart;');
  if (steps.indexOf('pcblib') >= 0) runJobLines.push('    StepPcbLib;');

  const template = fs.readFileSync(TEMPLATE_PATH, 'latin1');
  const values = {
    LCSC: pasEsc(lcsc),
    MPN: pasEsc(model.mpn || ''),
    LIBNAME: pasEsc(libName),
    LIB_MARKER: pasEsc(LIB_MARKER),
    PACKAGE: pasEsc(pkg),
    DESCRIPTION: quoteWide(model.description || ''),
    SCHLIB: pasEsc(schLibPath),
    PCBLIB: pasEsc(pcbLibPath),
    LOG: pasEsc(paths.logPath),
    BUILD_SYMBOL: buildSymbolBody(model, lcsc),
    FOOTPRINT_LIB: buildFootprintBody(model, 'PComp'),
    RUNJOB: runJobLines.join('\r\n'),
    PARTSCHLIB: pasEsc(paths.partSchLibPath),
    PARTPCBLIB: pasEsc(paths.partPcbLibPath),
    COUNTSINGLE: [
      steps.indexOf('schlib_part') >= 0
        ? "    W('COUNT single schlib comps=' + IntToStr(PartSchComps) + ' pins=" + (Array.isArray(pins) ? pins.length : 0) + " libref=" + pasEsc(libName) + " src=script-api');"
        : '',
      steps.indexOf('pcblib_part') >= 0
        ? "    W('COUNT single pcblib comps=' + IntToStr(PartPcbComps) + ' pads=" + (Array.isArray(pads) ? pads.length : 0) + " name=" + pasEsc(pkg) + " src=model+file-check');"
        : '',
    ].filter(Boolean).join('\r\n'),
    PINS: String(pins.length),
    PADS: String(pads.length),
    SCHLIB_EXISTS: flags.schLibExists ? 'True' : 'False',
    SCHLIB_HAS: (opts.schLibCurrent === true ? true : flags.schLibHasComp) ? 'True' : 'False',
    PCBLIB_EXISTS: flags.pcbLibExists ? 'True' : 'False',
    PCBLIB_HAS: (opts.forcePcbLib === true ? false : (opts.pcbLibCurrent === true || flags.pcbLibHasComp)) ? 'True' : 'False',
    PCBLIB_FORCE: opts.forcePcbLib === true ? 'True' : 'False',
  };

  let pasText = template;
  for (const key of Object.keys(values)) pasText = pasText.split('%%' + key + '%%').join(values[key]);
  const leftover = pasText.match(/%%[A-Z_]+%%/g);
  if (leftover) throw new Error('emitScriptJob: unresolved template placeholders: ' + leftover.join(', '));

  pasText = pasText.replace(/\r?\n/g, '\r\n');
  const problems = validatePas(pasText, { allowUnicode: true });
  if (problems.length) throw new Error('emitScriptJob: generated script failed validation:\n - ' + problems.join('\n - '));
  fs.writeFileSync(paths.pasPath, iconv.encode(pasText, 'gbk'));

  const prjScr = [
    '[Design]', 'Version=1.0', 'HierarchyMode=0', '',
    '[Document1]', 'DocumentPath=' + path.basename(paths.pasPath),
    'AnnotationEnabled=1', 'AnnotateStartValue=1', 'AnnotationIndexControlEnabled=0',
    'AnnotateSuffix=', 'AnnotateScope=All', 'AnnotateOrder=-1',
    'DoLibraryUpdate=1', 'DoDatabaseUpdate=1', 'ClassGen_NamespaceIsActive=0', ''
  ].join('\r\n');
  fs.writeFileSync(paths.prjScrPath, prjScr, 'latin1');

  const altiumExe = process.env.ALTIUM_EXE || opts.altiumExe || DEFAULT_ALTIUM_EXE;
  const cmd = [
    '@echo off',
    'setlocal',
    'if "%ALTIUM_EXE%"=="" set "ALTIUM_EXE=' + altiumExe + '"',
    'start "" "%ALTIUM_EXE%" -RScriptingSystem:RunScript(ProjectName="' + paths.prjScrPath + '"^|ProcName="RunJob")',
    'endlocal',
    ''
  ].join('\r\n');
  fs.writeFileSync(paths.cmdPath, cmd, 'latin1');

  return {
    pasPath: paths.pasPath,
    prjScrPath: paths.prjScrPath,
    cmdPath: paths.cmdPath,
    logPath: paths.logPath,
    workDir,
    outDir,
    schLibPath,
    pcbLibPath,
    partLibs: { sch: paths.partSchLibPath, pcb: paths.partPcbLibPath },
    altiumExe,
    flags,
    counts: { pins: pins.length, pads: pads.length },
    steps,
  };
}

export default { emitScriptJob, buildSymbolBody, buildFootprintBody };
