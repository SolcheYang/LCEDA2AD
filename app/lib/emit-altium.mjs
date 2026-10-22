// emit-altium.mjs - ComponentModel -> self-contained Altium DelphiScript job.
// Zero dependencies, pure ESM. Contract: CONTRACT.md 3.
//
// emitAltiumJob(model, opts) -> { pasPath, prjScrPath, cmdPath, logPath,
//                                 schDocPath, pcbDocPath, altiumExe, flags }
//
// The Pascal text lives in altium/template.pas; this module substitutes the
// %%PLACEHOLDERS%% with path literals and generated geometry, so the written
// .pas is self-contained. RunJob runs four steps in a fixed order:
//   schlib -> pcblib -> schdoc -> pcbdoc
//
// Altium APIs used (verified on Altium 26.7.1 on this machine):
//   Client.StartServer / CreateNewDocumentFromDocumentKind / OpenDocument(Kind,File)
//   Client.ShowDocument / GetDocumentByPath / CurrentView.OwnerDocument
//   IServerDocument.DoSafeChangeFileNameAndSave(File,Kind)  <- non-interactive save-as
//   IServerDocument.DoSafeFileSave(Kind)                    <- save in place
//   SchServer.GetCurrentSchDocument / SchObjectFactory / RobotManager.SendMessage
//   PCBServer.GetCurrentPCBLibrary / GetCurrentPCBBoard / CreatePCBLibComp
//   PCBServer.PCBObjectFactory / SendMessageToRobots / Lib.RegisterComponent
// NOT usable: RunProcess('WorkspaceManager:SaveObject') with SaveMode=SaveAs -
// it opens the interactive Save-As dialog and ignores the 'File' parameter.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ALTIUM_EXE = 'E:\\AD\\AD\\X2.EXE';
const KNOWN_STEPS = ['docsch', 'docpcb', 'schlib_part', 'schlib', 'pcblib_part', 'pcblib'];
// Both documents must be seeded: Altium cannot write a document that has no storage on
// disk (verified - see altium/notes.md), so a real Altium document is copied to the
// target path first and then opened, edited and written back.
export const DEFAULT_SCHDOT_SEED = 'E:\\AD\\ADDOC\\Templates\\ISO A3 Landscape.SchDot';
export const DEFAULT_PCBDOC_SEED = 'E:\\GroundRes\\Hardware\\ADpro\\Component\\Altium_BQ7693003DBTR_2026-10-21\\BQ7693003DBTR\\BQ7693003DBTR.pcbdoc';
const TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'altium', 'template.pas');

const ASCII_MAP = new Map([
  ['\u03a9', 'Ohm'], ['\u03bc', 'u'], ['\u00b5', 'u'], ['\u00b0', 'deg'], ['\u00b1', '+/-'],
  ['\u00d7', 'x'], ['\u2013', '-'], ['\u2014', '-'], ['\u2018', "'"], ['\u2019', "'"],
  ['\u201c', '"'], ['\u201d', '"'], ['\u2026', '...'], ['\u00a0', ' '], ['\u2192', '->'],
  ['\u00b2', '2'], ['\u00b3', '3'], ['\u2264', '<='], ['\u2265', '>='], ['\u00f7', '/'],
]);

/** Altium's script editor is unreliable with UTF-8, so force plain ASCII. */
export function toAscii(value) {
  let out = '';
  for (const ch of String(value == null ? '' : value)) {
    const code = ch.codePointAt(0);
    if (code < 0x80) {
      out += ch;
    } else {
      const mapped = ASCII_MAP.get(ch);
      out += mapped === undefined ? '?' : mapped;
    }
  }
  return out;
}

const pasEsc = (value) => toAscii(value).replace(/'/g, "''");
const count = (text, re) => (text.match(re) || []).length;
function quote(value) {
  return "'" + pasEsc(value) + "'";
}

/** Strip {comments}, (comments) and 'strings' before structural counting. */
export function stripNonCode(text) {
  return String(text)
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\(\*[\s\S]*?\*\)/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * Static guard for generated DelphiScript: a ';' before Else and an empty
 * Try..Except do not compile, and finding that out costs a full Altium launch.
 * Returns the list of problems (empty means valid).
 */
export function validatePas(text, options = {}) {
  const problems = [];
  const source = String(text);
  const body = stripNonCode(source);

  // The current emitter writes the .pas as GBK and intentionally carries Chinese /
  // Ω / ± descriptions, so Unicode is allowed there. The legacy ASCII-only job
  // emitter keeps the check.
  if (!options.allowUnicode) {
    const nonAscii = [...new Set([...source].filter((ch) => ch.codePointAt(0) > 127))];
    if (nonAscii.length) problems.push('non-ASCII characters present: ' + nonAscii.join(''));
  }

  if (/;\s*Else\b/i.test(body)) problems.push('a semicolon precedes Else (DelphiScript: Unknown identifier: Else)');
  // NOTE: ';' before Except is legal Delphi (it just ends the last statement of
  // the Try body), only Else is sensitive to a preceding semicolon.
  if (/\bTry\b\s*\bExcept\b/i.test(body)) problems.push('empty Try..Except block');

  const begins = count(body, /\bBegin\b/gi);
  const ends = count(body, /\bEnd\b/gi);
  const trys = count(body, /\bTry\b/gi);
  const excepts = count(body, /\bExcept\b/gi);
  const ifs = count(body, /\bIf\b/gi);
  const thens = count(body, /\bThen\b/gi);

  if (ends !== begins + trys) problems.push('Begin/End/Try imbalance: Begin=' + begins + ' Try=' + trys + ' End=' + ends);
  if (trys !== excepts) problems.push('Try/Except imbalance: Try=' + trys + ' Except=' + excepts);
  if (ifs !== thens) problems.push('If/Then imbalance: If=' + ifs + ' Then=' + thens);
  // A leading BOM makes Altium's script compiler fail without a usable message.
  if (source.charCodeAt(0) === 0xfeff) problems.push('the script starts with a UTF-8 BOM');
  // Every raised script error pops a modal Altium "Error" box and wedges the job, and
  // Try/Except does NOT prevent it, so calls that raise on ordinary conditions are banned.
  if (/\bLoadFromFile\b/i.test(body)) {
    problems.push('TStringList.LoadFromFile raises when the file is absent; a raised script error pops a modal dialog and blocks the whole job');
  }
  if (/\bE\.Message\b/.test(body) && !/\bOn\s+E\s*:/i.test(body)) {
    problems.push('E.Message is used without an On E: ... Do handler');
  }
  if (!/\bProcedure\s+RunJob\b/i.test(body)) problems.push('entry point RunJob is missing');
  if (!/\bProcedure\s+BuildSymbol\b/i.test(body)) problems.push('helper BuildSymbol is missing');
  return problems;
}

// Verified against the Altium binary symbols (grep Advpcb.dll for eRound/eRect/eOct):
// the pad-shape enum is eRounded / eRectangular / eOctagonal. "eRound" does not exist
// and only shows up in the compiler as "Undeclared identifier: eRound" after a launch.
const PAD_SHAPE = { round: 'eRounded', rect: 'eRectangular', octagonal: 'eOctagonal' };
const PCB_LAYER = {
  top: 'eTopLayer', bottom: 'eBottomLayer', multi: 'eMultiLayer',
  top_overlay: 'eTopOverlay', bottom_overlay: 'eBottomOverlay',
  top_paste: 'eTopPaste', bottom_paste: 'eBottomPaste',
  top_solder: 'eTopSolder', bottom_solder: 'eBottomSolder',
  mechanical1: 'eMechanical1', keepout: 'eKeepOutLayer',
};
const padShape = (s) => PAD_SHAPE[String(s || '').toLowerCase()] || 'eRectangular';
const pcbLayer = (l) => PCB_LAYER[String(l || '').toLowerCase()] || 'eTopLayer';

function num(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '0.0';
  const s = String(Math.round(v * 1e6) / 1e6);
  return s.indexOf('.') >= 0 ? s : s + '.0';
}
const mil = (value) => String(Math.round(Number(value) || 0));

/** BuildSymbol body: shape primitives first, then pins. */
export function buildSymbolBody(model) {
  const out = [];
  const sym = model.symbol || {};
  out.push('    Target.LibReference         := ' + quote(model.lcsc) + ';');
  out.push('    Target.ComponentDescription := ' + quote(model.description) + ';');
  out.push("    Target.Designator.Text      := 'U?';");
  for (const sh of sym.shapes || []) {
    const kind = String(sh.kind || '').toLowerCase();
    if (kind === 'rect') {
      out.push('    AddRect(Target, ' + [sh.x1, sh.y1, sh.x2, sh.y2].map(mil).join(', ') + ');');
    } else if (kind === 'ellipse') {
      out.push('    AddEllipse(Target, ' + [sh.x, sh.y, sh.rx, sh.ry].map(mil).join(', ') + ');');
    } else if (kind === 'polyline' || kind === 'polygon') {
      const pts = Array.isArray(sh.points) ? sh.points : [];
      for (let i = 0; i + 1 < pts.length; i++) {
        out.push('    AddLine(Target, ' + [pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]].map(mil).join(', ') + ');');
      }
      if (kind === 'polygon' && pts.length > 2) {
        const a = pts[0];
        const b = pts[pts.length - 1];
        if (Number(a[0]) !== Number(b[0]) || Number(a[1]) !== Number(b[1])) {
          out.push('    AddLine(Target, ' + [b[0], b[1], a[0], a[1]].map(mil).join(', ') + ');');
        }
      }
    }
  }
  for (const pin of sym.pins || []) {
    out.push('    AddPin(Target, ' + quote(pin.number) + ', ' + quote(pin.name || '~') + ', '
      + [pin.x, pin.y, pin.length == null ? 100 : pin.length, pin.orient].map(mil).join(', ') + ', '
      + quote(String(pin.electrical || 'passive').toLowerCase()) + ');');
  }
  return out.join('\n');
}

/** Footprint primitives inlined against a concrete owner expression. */
export function footprintBody(model, owner) {
  const fp = model.footprint || {};
  const out = [];
  for (const pad of fp.pads || []) {
    const hole = Number(pad.hole) || 0;
    const layer = hole > 0 ? 'multi' : (pad.layer || 'top');
    out.push(
      '        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);',
      '        Pad.Mode     := ePadMode_Simple;',
      '        Pad.Layer    := ' + pcbLayer(layer) + ';',
      '        Pad.TopShape := ' + padShape(pad.shape) + ';',
      '        Pad.TopXSize := MMsToCoord(' + num(pad.w) + ');',
      '        Pad.TopYSize := MMsToCoord(' + num(pad.h) + ');',
      '        Pad.X        := MMsToCoord(' + num(pad.x) + ');',
      '        Pad.Y        := MMsToCoord(' + num(pad.y) + ');',
      '        Pad.Name     := ' + quote(pad.number) + ';',
      '        Pad.HoleSize := MMsToCoord(' + num(hole) + ');',
      '        ' + owner + '.AddPCBObject(Pad);',
    );
  }
  for (const trk of fp.tracks || []) {
    out.push(
      '        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);',
      '        Trk.Layer := ' + pcbLayer(trk.layer) + ';',
      '        Trk.Width := MMsToCoord(' + num(trk.width == null ? 0.15 : trk.width) + ');',
      '        Trk.X1    := MMsToCoord(' + num(trk.x1) + ');',
      '        Trk.Y1    := MMsToCoord(' + num(trk.y1) + ');',
      '        Trk.X2    := MMsToCoord(' + num(trk.x2) + ');',
      '        Trk.Y2    := MMsToCoord(' + num(trk.y2) + ');',
      '        ' + owner + '.AddPCBObject(Trk);',
    );
  }
  for (const cir of fp.circles || []) {
    out.push(
      '        Arc := PCBServer.PCBObjectFactory(eArcObject, eNoDimension, eCreate_Default);',
      '        Arc.Layer      := ' + pcbLayer(cir.layer) + ';',
      '        Arc.LineWidth  := MMsToCoord(' + num(cir.width == null ? 0.15 : cir.width) + ');',
      '        Arc.XCenter    := MMsToCoord(' + num(cir.x) + ');',
      '        Arc.YCenter    := MMsToCoord(' + num(cir.y) + ');',
      '        Arc.Radius     := MMsToCoord(' + num(cir.r) + ');',
      '        Arc.StartAngle := 0;',
      '        Arc.EndAngle   := 360;',
      '        ' + owner + '.AddPCBObject(Arc);',
    );
  }
  return out.join('\n');
}

/**
 * Remove the seeded footprint from an Altium ASCII PcbDoc, keeping the board itself.
 * Measured on the BQ7693003DBTR seed: every record that belongs to the component
 * (Pad/Track/Arc/Region/Text) carries "|COMPONENT=", while the board-level records
 * (|RECORD=Board x20, |RECORD=DXPRule x3) carry none. So: drop |RECORD=Component and
 * every record containing |COMPONENT=, keep the rest byte for byte.
 * The caller must work on a copy - never on the user's original project.
 */
export function stripPcbDocSeed(input) {
  const text = Buffer.isBuffer(input) ? input.toString('latin1') : String(input == null ? '' : input);
  const parts = text.split(/(?=\|RECORD=)/);
  const kept = [];
  for (const part of parts) {
    const m = part.match(/^\|RECORD=([A-Za-z0-9_]+)/);
    if (m) {
      if (m[1] === 'Component') continue;
      if (/\|COMPONENT=/i.test(part)) continue;
    }
    kept.push(part);
  }
  return kept.join('');
}

/**
 * Count components / pins / pads straight out of an Altium document.
 * Verified against a real Altium export (BQ7693003DBTR, TSSOP-30): the ASCII
 * SchDoc has |RECORD=1 (=component) x1 and |RECORD=2 (=pin) x30, and the ASCII
 * PcbDoc has |RECORD=Component x1 and |RECORD=Pad x30 - i.e. 1 / 30 / 30.
 * Returns null when the buffer is neither of those shapes (e.g. an OLE SchLib).
 */
export function countDocumentRecords(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf == null ? '' : buf);
  if (!/\|RECORD=/.test(text)) return null;
  const tally = (re) => (text.match(re) || []).length;
  const isPcb = /\|RECORD=Board\b/.test(text);
  if (isPcb) {
    return { kind: 'pcbdoc', comps: tally(/\|RECORD=Component\b/g), pads: tally(/\|RECORD=Pad\b/g) };
  }
  // In the schematic ASCII format RECORD=1 is a component and RECORD=2 is a pin.
  return { kind: 'schdoc', comps: tally(/\|RECORD=1(?!\d)/g), pins: tally(/\|RECORD=2(?!\d)/g) };
}

function fileHasName(filePath, name) {
  try {
    const buf = fs.readFileSync(filePath);
    return buf.includes(Buffer.from(String(name), 'utf16le')) || buf.includes(Buffer.from(String(name), 'latin1'));
  } catch (err) {
    return false;
  }
}

/**
 * emitAltiumJob(model, opts)
 * opts: { outDir, schLibPath, pcbLibPath, workDir, steps? }
 */
export async function emitAltiumJob(model, opts = {}) {
  if (!model || typeof model !== 'object') throw new Error('emitAltiumJob: model is required');
  const lcsc = toAscii(model.lcsc || '').trim();
  if (!lcsc) throw new Error('emitAltiumJob: model.lcsc is required');
  const pins = (model.symbol && model.symbol.pins) || [];
  const pads = (model.footprint && model.footprint.pads) || [];
  if (!Array.isArray(pins) || pins.length === 0) throw new Error('emitAltiumJob: model.symbol.pins is empty');
  if (!Array.isArray(pads) || pads.length === 0) throw new Error('emitAltiumJob: model.footprint.pads is empty');

  const requested = Array.isArray(opts.steps) ? opts.steps.filter((s) => KNOWN_STEPS.indexOf(s) >= 0) : [];
  const steps = requested.length ? requested : KNOWN_STEPS;

  const outDir = path.resolve(opts.outDir || path.join(process.cwd(), 'out'));
  const workDir = path.resolve(opts.workDir || path.join(process.cwd(), 'jobs', lcsc));
  const schLibPath = path.resolve(opts.schLibPath || path.join(process.cwd(), 'library', 'MyLib.SchLib'));
  const pcbLibPath = path.resolve(opts.pcbLibPath || path.join(process.cwd(), 'library', 'MyLib.PcbLib'));
  for (const dir of [outDir, workDir, path.dirname(schLibPath), path.dirname(pcbLibPath)]) fs.mkdirSync(dir, { recursive: true });

  const paths = {
    outDir: outDir, workDir: workDir, schLibPath: schLibPath, pcbLibPath: pcbLibPath,
    logPath: path.join(workDir, 'job.log'),
    schDocPath: path.join(outDir, lcsc + '_SCH.SchDoc'),
    pcbDocPath: path.join(outDir, lcsc + '_PCB.PcbDoc'),
    pasPath: path.join(workDir, 'job.pas'),
    prjScrPath: path.join(workDir, 'job.PrjScr'),
    cmdPath: path.join(workDir, 'run-job.cmd'),
    partSchLibPath: path.join(outDir, lcsc + '_SCH.SchLib'),
    partPcbLibPath: path.join(outDir, lcsc + '_PCB.PcbLib'),
  };

  const flags = {
    schLibExists: fs.existsSync(schLibPath),
    pcbLibExists: fs.existsSync(pcbLibPath),
    schLibHasComp: fileHasName(schLibPath, lcsc),
    pcbLibHasComp: fileHasName(pcbLibPath, model.package || lcsc),
  };

  const altiumExe = process.env.ALTIUM_EXE || opts.altiumExe || DEFAULT_ALTIUM_EXE;

  const runJobLines = [];
  if (steps.indexOf('docsch') >= 0) runJobLines.push('    StepSchDoc;');
  if (steps.indexOf('docpcb') >= 0) runJobLines.push('    StepPcbDoc;');
  if (steps.indexOf('schlib_part') >= 0) runJobLines.push('    StepSchLibPart;');
  if (steps.indexOf('schlib') >= 0) runJobLines.push('    StepSchLib;');
  if (steps.indexOf('pcblib_part') >= 0) runJobLines.push('    StepPcbLibPart;');
  if (steps.indexOf('pcblib') >= 0) runJobLines.push('    StepPcbLib;');

  const template = fs.readFileSync(TEMPLATE_PATH, 'latin1');
  const values = {
    LCSC: pasEsc(lcsc),
    MPN: pasEsc(model.mpn || ''),
    PACKAGE: pasEsc(model.package || lcsc),
    DESCRIPTION: pasEsc(model.description || ''),
    SCHLIB: pasEsc(schLibPath),
    PCBLIB: pasEsc(pcbLibPath),
    SCHDOC: pasEsc(paths.schDocPath),
    PCBDOC: pasEsc(paths.pcbDocPath),
    LOG: pasEsc(paths.logPath),
    BUILD_SYMBOL: buildSymbolBody(model),
    FOOTPRINT_LIB: footprintBody(model, 'PComp'),
    FOOTPRINT_BOARD: footprintBody(model, 'BC'),
    RUNJOB: runJobLines.join('\r\n'),
    PARTSCHLIB: pasEsc(paths.partSchLibPath),
    PARTPCBLIB: pasEsc(paths.partPcbLibPath),
    COUNTSINGLE: [
      steps.indexOf('schlib_part') >= 0
        ? "    W('COUNT single schlib comps=' + IntToStr(PartSchComps) + ' pins=" + (Array.isArray(pins) ? pins.length : 0) + " libref=" + pasEsc(lcsc) + " src=self-recorded+file-scan');"
        : '',
      steps.indexOf('pcblib_part') >= 0
        ? "    W('COUNT single pcblib comps=' + IntToStr(PartPcbComps) + ' pads=" + (Array.isArray(pads) ? pads.length : 0) + " name=" + pasEsc(model.package || lcsc) + " src=api:ComponentCount');"
        : '',
    ].filter(Boolean).join('\r\n'),

    PINS: String(Array.isArray(pins) ? pins.length : 0),
    PADS: String(Array.isArray(pads) ? pads.length : 0),
    SCHLIB_EXISTS: flags.schLibExists ? 'True' : 'False',
    SCHLIB_HAS: flags.schLibHasComp ? 'True' : 'False',
    PCBLIB_EXISTS: flags.pcbLibExists ? 'True' : 'False',
    PCBLIB_HAS: flags.pcbLibHasComp ? 'True' : 'False',
  };

  let pasText = template;
  for (const key of Object.keys(values)) {
    pasText = pasText.split('%%' + key + '%%').join(values[key]);
  }
  const leftover = pasText.match(/%%[A-Z_]+%%/g);
  if (leftover) throw new Error('emitAltiumJob: unresolved template placeholders: ' + leftover.join(', '));

  pasText = toAscii(pasText).replace(/\r?\n/g, '\r\n');

  const problems = validatePas(pasText);
  if (problems.length) throw new Error('emitAltiumJob: generated script failed validation:\n - ' + problems.join('\n - '));

  fs.writeFileSync(paths.pasPath, pasText, 'latin1');

  // Seed the two documents every run: the strip self-check must prove the seeded
  // footprint is gone before Altium is allowed to touch the copy.
  const schDotSeed = path.resolve(opts.schDotSeed || DEFAULT_SCHDOT_SEED);
  const pcbDocSeed = path.resolve(opts.pcbDocSeed || DEFAULT_PCBDOC_SEED);
  if (!fs.existsSync(schDotSeed)) throw new Error('emitAltiumJob: SchDoc seed template not found: ' + schDotSeed);
  if (!fs.existsSync(pcbDocSeed)) throw new Error('emitAltiumJob: PcbDoc seed not found: ' + pcbDocSeed);
  // Seed only the document(s) this job actually writes: a later stage must not overwrite
  // the document an earlier stage already produced.
  if (steps.indexOf('docsch') >= 0) {
    fs.copyFileSync(schDotSeed, paths.schDocPath);
  }
  if (steps.indexOf('docpcb') >= 0) {
    const strippedSeed = stripPcbDocSeed(fs.readFileSync(pcbDocSeed));
    const seedCheck = countDocumentRecords(strippedSeed);
    if (!seedCheck || seedCheck.comps !== 0 || seedCheck.pads !== 0) {
      throw new Error('emitAltiumJob: PcbDoc seed strip self-check failed, refusing to hand it to Altium: ' + JSON.stringify(seedCheck));
    }
    fs.writeFileSync(paths.pcbDocPath, strippedSeed, 'latin1');
  }

  const prjScr = [
    '[Design]', 'Version=1.0', 'HierarchyMode=0', '',
    '[Document1]', 'DocumentPath=' + path.basename(paths.pasPath),
    'AnnotationEnabled=1', 'AnnotateStartValue=1', 'AnnotationIndexControlEnabled=0',
    'AnnotateSuffix=', 'AnnotateScope=All', 'AnnotateOrder=-1',
    'DoLibraryUpdate=1', 'DoDatabaseUpdate=1', 'ClassGen_NamespaceIsActive=0', ''
  ].join('\r\n');
  fs.writeFileSync(paths.prjScrPath, prjScr, 'latin1');

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
    schDocPath: paths.schDocPath,
    pcbDocPath: paths.pcbDocPath,
    schLibPath: schLibPath,
    pcbLibPath: pcbLibPath,
    outDir: outDir,
    workDir: workDir,
    altiumExe: altiumExe,
    flags: flags,
    seeds: { schDotSeed: schDotSeed, pcbDocSeed: pcbDocSeed },
    counts: { pins: Array.isArray(pins) ? pins.length : 0, pads: Array.isArray(pads) ? pads.length : 0 },
    partLibs: { sch: paths.partSchLibPath, pcb: paths.partPcbLibPath },
  };
}

export default { emitAltiumJob, validatePas, toAscii, countDocumentRecords, stripPcbDocSeed, DEFAULT_ALTIUM_EXE, DEFAULT_SCHDOT_SEED, DEFAULT_PCBDOC_SEED };