// altium-doc-writer.mjs - generate Altium ASCII documents from the EasyEDA model,
// with no browser and no Altium UI. The output is the same ASCII 5.0 format that
// EasyEDA's own Altium export produces, so Altium opens it and the library stages
// can parse/converted it exactly like the web export.
//
// Units:
//   * model.symbol.*        mil (the EasyEDA normaliser already emits mil)
//   * model.footprint.*     mil (the caller converts the API model's mm -> mil first)
//   * SchDoc ASCII          stores 10-mil units, so buildSchDoc divides by 10
//   * PcbDoc ASCII          stores explicit "1234.5600mil" values
//
// buildSchDoc(model) -> { text, skippedShapes }
// buildPcbDoc(model) -> { text, skippedPrimitives }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCH_SHEET_TEMPLATE = path.join(ROOT, 'altium', 'blank-sch-sheet.txt');
const PCB_SKELETON = path.join(ROOT, 'altium', 'blank-pcb-skeleton.txt');

const SCH_ORIGIN = { x: 250, y: 200 };       // 10-mil units on the sheet (center of 500x400)
const PCB_ORIGIN = { x: 3167.035, y: 3147.64 }; // mil, inside the blank board skeleton

const SCH_ELECTRICAL = { input: 0, output: 1, bidirectional: 2, passive: 3, unspecified: 4, power: 4 };
const PAD_SHAPE = { round: 'ROUND', rect: 'RECT', octagonal: 'OCTAGONAL' };
const PCB_LAYER = {
  top: 'TOP', bottom: 'BOTTOM', multi: 'MULTILAYER',
  top_overlay: 'TOPOVERLAY', bottom_overlay: 'BOTTOMOVERLAY',
  top_paste: 'TOPPASTE', bottom_paste: 'BOTTOMPASTE',
  top_solder: 'TOPSOLDER', bottom_solder: 'BOTTOMSOLDER',
  // EasyEDA documentation layers (same Altium slots as the LCSC official library).
  board_outline: 'KEEPOUT',
  document: 'MECHANICAL2',
  top_assembly: 'MECHANICAL4',
  bottom_assembly: 'MECHANICAL5',
  mechanical: 'MECHANICAL6',
  component_shape: 'MECHANICAL8',
  lead_shape: 'MECHANICAL9',
  component_marking: 'TOPOVERLAY',
};

function ascii(value) {
  return String(value == null ? '' : value)
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/[|\r\n]/g, ' ')
    .trim();
}

/** LCEDA reference prefix (head.c_para.pre, e.g. "R?", "U?"); U when absent. */
function designatorPrefix(model) {
  const letters = String((model && model.designatorPrefix) || '')
    .toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  return letters || 'U';
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** mil -> SchDoc 10-mil unit string. */
function du(value) {
  const n = Math.round((num(value) / 10) * 1e4) / 1e4;
  return String(n);
}
/**
 * mil -> { whole, frac } in SchDoc 10-mil units. EasyEDA's own export writes
 * coordinates as an integer field plus a _FRAC field in 1/100000 of a unit
 * (e.g. LOCATION.X=261|LOCATION.X_FRAC=70000 == 261.7 units).
 */
function unitParts(milValue) {
  const units = num(milValue) / 10;
  let whole = Math.trunc(units);
  let frac = Math.round((units - whole) * 100000);
  if (frac >= 100000) { whole += 1; frac = 0; }
  else if (frac <= -100000) { whole -= 1; frac = 0; }
  return { whole, frac };
}
/** "|PREFIX=whole|PREFIX_FRAC=frac" (the FRAC field is omitted when zero). */
function unitField(prefix, milValue) {
  const { whole, frac } = unitParts(milValue);
  return '|' + prefix + '=' + whole + (frac === 0 ? '' : '|' + prefix + '_FRAC=' + frac);
}
/** mil -> "1234.5600mil" */
function mil(value) {
  return (Math.round(num(value) * 1e4) / 1e4).toFixed(4) + 'mil';
}
/** Altium angles are written as plain degrees (135.5, 360, …). */
function angleText(value) {
  return String(Math.round(num(value) * 1000) / 1000);
}
function readTemplate(file, fallback) {
  try { return fs.readFileSync(file, 'latin1').trim(); } catch { return fallback; }
}

/**
 * Build a valid Altium Schematic ASCII document (Version 5.0).
 * Record ids follow the EasyEDA Altium export (verified against exported files):
 *   6 = polyline (also used for closed polygons), 8 = ellipse,
 *   10 = rectangle, 12 = arc, 2 = pin.
 * Coordinates use the exporter's integer + _FRAC (1/100000 unit) form so curves
 * keep sub-unit precision.
 */
export function buildSchDoc(model) {
  const ox = SCH_ORIGIN.x;
  const oy = SCH_ORIGIN.y;
  const pins = (model.symbol && model.symbol.pins) || [];
  const shapes = (model.symbol && model.symbol.shapes) || [];
  const recs = [];
  let skippedShapes = 0;
  let indexInSheet = 1;

  const sheet = readTemplate(SCH_SHEET_TEMPLATE,
    '|RECORD=31|FONTIDCOUNT=4|SIZE1=10|FONTNAME1=Times New Roman|ITALIC1=F|UNDERLINE1=F|BOLD1=F|SIZE2=10|FONTNAME2=default|ITALIC2=F|UNDERLINE2=F|BOLD2=F|SIZE3=8|FONTNAME3=Times New Roman|ITALIC3=F|UNDERLINE3=F|BOLD3=F|SIZE4=8|FONTNAME4=Times New Roman|ITALIC4=F|UNDERLINE4=F|BOLD4=F|SHEETSTYLE=17|CUSTOMX=500|CUSTOMY=400|USECUSTOMSHEET=T|DISPLAY_UNIT=4');
  recs.push(sheet);

  recs.push('|RECORD=1|LIBREFERENCE=' + ascii(model.mpn || model.lcsc)
    + '|PARTCOUNT=1|COMPONENTDESCRIPTION=' + ascii(model.description || '')
    + '|LOCATION.X=' + ox + '|LOCATION.Y=' + oy
    + '|CURRENTPARTID=1|ORIENTATION=0|SHOWHIDDENPINS=F|ISCROSSSHEETCONNECTOR=T|STYLE=0|ISMIRRORED=F');

  recs.push('|RECORD=34|COLOR=8388608|LOCATION.X=' + ox + '|LOCATION.Y=' + oy
    + '|OWNERINDEX=1|OWNERPARTID=-1|INDEXINSHEET=' + (indexInSheet++)
    + '|FONTID=3|NAME=Designator|TEXT=' + designatorPrefix(model) + '??|SHOWNAME=F|ISHIDDEN=T|ORIENTATION=0|JUSTIFICATION=0');

  recs.push('|RECORD=41|COLOR=65280|LOCATION.X=' + ox + '|LOCATION.Y=' + oy
    + '|OWNERINDEX=1|OWNERPARTID=-1|INDEXINSHEET=' + (indexInSheet++)
    + '|FONTID=2|NAME=Comment|TEXT=' + ascii(model.mpn || model.lcsc)
    + '|SHOWNAME=F|ISHIDDEN=T|ORIENTATION=0|JUSTIFICATION=6');

  for (const sh of shapes) {
    const kind = String(sh.kind || '').toLowerCase();
    if (kind === 'rect') {
      const x1 = Math.min(num(sh.x1), num(sh.x2));
      const x2 = Math.max(num(sh.x1), num(sh.x2));
      const y1 = Math.min(num(sh.y1), num(sh.y2));
      const y2 = Math.max(num(sh.y1), num(sh.y2));
      recs.push('|RECORD=10|OWNERINDEX=1|OWNERPARTID=1|ISNOTACCESIBLE=T|INDEXINSHEET=' + (indexInSheet++)
        + '|LOCATION.X=' + du(ox * 10 + x1) + '|LOCATION.Y=' + du(oy * 10 + y1)
        + '|CORNER.X=' + du(ox * 10 + x2) + '|CORNER.Y=' + du(oy * 10 + y2)
        + '|CORNERXRADIUS=0|CORNERYRADIUS=0|TRANSPARENT=F|LINEWIDTH=1|COLOR=128|LINESTYLE=0');
    } else if (kind === 'ellipse') {
      // Record 8 is the ellipse; record 12 is an arc (the old writer used 12 for
      // ellipses, which only looked right for full 0–360 circles).
      recs.push('|RECORD=8|OWNERINDEX=1|OWNERPARTID=1|ISNOTACCESIBLE=T|INDEXINSHEET=' + (indexInSheet++)
        + unitField('LOCATION.X', ox * 10 + num(sh.x)) + unitField('LOCATION.Y', oy * 10 + num(sh.y))
        + unitField('RADIUS', num(sh.rx)) + unitField('SECONDARYRADIUS', num(sh.ry))
        + '|LINEWIDTH=1|COLOR=128|LINESTYLE=0|TRANSPARENT=F');
    } else if (kind === 'arc') {
      const r = num(sh.r) || Math.max(num(sh.rx), num(sh.ry));
      recs.push('|RECORD=12|OWNERINDEX=1|OWNERPARTID=1|ISNOTACCESIBLE=T|INDEXINSHEET=' + (indexInSheet++)
        + unitField('LOCATION.X', ox * 10 + num(sh.x)) + unitField('LOCATION.Y', oy * 10 + num(sh.y))
        + unitField('RADIUS', r) + unitField('SECONDARYRADIUS', r)
        + '|STARTANGLE=' + angleText(sh.start) + '|ENDANGLE=' + angleText(sh.end == null ? 360 : sh.end)
        + '|LINEWIDTH=1|COLOR=128|LINESTYLE=0');
    } else if (kind === 'polyline' || kind === 'polygon') {
      const pts = (Array.isArray(sh.points) ? sh.points : []).map((p) => [num(p[0]), num(p[1])]);
      if (pts.length < 2) { skippedShapes++; continue; }
      // EasyEDA closes a polygon by repeating the first vertex in the record.
      if (kind === 'polygon' && pts.length >= 3) pts.push(pts[0]);
      let line = '|RECORD=6|OWNERINDEX=1|OWNERPARTID=1|ISNOTACCESIBLE=T|INDEXINSHEET=' + (indexInSheet++)
        + '|LINEWIDTH=1|COLOR=128|LINESTYLE=0|LOCATIONCOUNT=' + pts.length;
      pts.forEach(([x, y], i) => {
        line += unitField('X' + (i + 1), ox * 10 + x) + unitField('Y' + (i + 1), oy * 10 + y);
      });
      recs.push(line + '|STARTLINESHAPE=0|ENDLINESHAPE=0');
    } else {
      skippedShapes++;
    }
  }

  for (const pin of pins) {
    const orient = ((Math.round(num(pin.orient) / 90) * 90) % 360 + 360) % 360;
    const outward = ((orient / 90) + 2) % 4; // document direction is away from the body
    const dx = [1, 0, -1, 0][outward];
    const dy = [0, 1, 0, -1][outward];
    const length = num(pin.length);
    // SchLib Pin.Location is the connection tip; the document stores the body edge.
    const bodyX = num(pin.x) - dx * length;
    const bodyY = num(pin.y) - dy * length;
    const conglomerate = 56 | outward; // 0x38 = show name + show designator + ...
    const electrical = SCH_ELECTRICAL[String(pin.electrical || '').toLowerCase()];
    recs.push('|RECORD=2|OWNERINDEX=1|OWNERPARTID=1|ISNOTACCESIBLE=T|ELECTRICAL=' + (electrical == null ? 4 : electrical)
      + '|COLOR=0|PINNAME_POSITIONCONGLOMERATE=16|NAME_CUSTOMFONTID=4'
      + '|PINDESIGNATOR_POSITIONCONGLOMERATE=16|DESIGNATOR_CUSTOMFONTID=4'
      + '|DESIGNATOR=' + ascii(pin.number) + '|NAME=' + ascii(pin.name || '~')
      + '|PINCONGLOMERATE=' + conglomerate
      + '|LOCATION.X=' + du(ox * 10 + bodyX) + '|LOCATION.Y=' + du(oy * 10 + bodyY)
      + '|PINLENGTH=' + du(length)
      + '|NAME_CUSTOMCOLOR=0|DESIGNATOR_CUSTOMCOLOR=0');
  }

  const header = '|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0'
    + '|UNIQUEID=' + randomUUID() + '|WEIGHT=' + recs.length;
  return { text: [header, ...recs].join('\r\n') + '\r\n', skippedShapes };
}

/**
 * Build a valid Altium PCB ASCII document: blank board skeleton (no components)
 * plus the component, its pads, TopOverlay tracks and arcs. Regions/3D bodies are
 * intentionally not reconstructed (the model has no such data).
 */
export function buildPcbDoc(model) {
  const skeleton = readTemplate(PCB_SKELETON, '');
  if (!skeleton || !/\|RECORD=Board\b/.test(skeleton)) {
    throw new Error('blank PcbDoc skeleton is missing or invalid: ' + PCB_SKELETON);
  }
  const board = skeleton.replace(/UNIQUEID=[0-9A-Fa-f-]+/, 'UNIQUEID=' + randomUUID());
  const splitAt = board.indexOf('|RECORD=DXPRule');
  const prefix = (splitAt >= 0 ? board.slice(0, splitAt) : board).replace(/\s*$/, '') + '\r\n';
  const suffix = splitAt >= 0 ? board.slice(splitAt) : '';

  const fp = model.footprint || {};
  const pads = fp.pads || [];
  const tracks = fp.tracks || [];
  // Circles are full 360-degree arcs; combine both sources. The dedupe key keeps a
  // caller that already folded circles into arcs from drawing them twice.
  const arcs = [];
  const arcKeys = new Set();
  const addArc = (a) => {
    const key = [a.layer, a.x, a.y, a.r, a.start == null ? 0 : a.start, a.end == null ? 360 : a.end]
      .map((v) => (typeof v === 'number' ? v.toFixed(4) : String(v))).join('|');
    if (arcKeys.has(key)) return;
    arcKeys.add(key);
    arcs.push(a);
  };
  for (const a of fp.arcs || []) addArc(a);
  for (const c of fp.circles || []) {
    addArc({ layer: c.layer, x: c.x, y: c.y, r: c.r, start: 0, end: 360, width: c.width });
  }
  const ox = PCB_ORIGIN.x;
  const oy = PCB_ORIGIN.y;
  const recs = [];
  let skipped = 0;
  let arcIndex = 0;

  recs.push('|RECORD=Component|ID=0|LAYER=TOP|X=' + mil(ox) + '|Y=' + mil(oy)
    + '|ROTATION=0|LOCKED=FALSE|PATTERN=' + ascii(model.package || model.lcsc)
    + '|SOURCEDESIGNATOR=' + designatorPrefix(model) + '?|NAMEON=FALSE|COMMENTON=FALSE|SOURCEUNIQUEID=' + randomUUID());

  for (const pad of pads) {
    const hole = num(pad.hole);
    const layer = PCB_LAYER[String(pad.layer || 'top').toLowerCase()] || 'TOP';
    recs.push('|RECORD=Pad|COMPONENT=0|LAYER=' + layer
      + '|NAME=' + ascii(pad.number)
      + '|HOLESIZE=' + mil(hole) + '|PLATED=' + (pad.plated === false ? 'FALSE' : 'TRUE')
      + '|PINLENGTH=0mil|LOCKED=FALSE'
      + '|ROTATION=' + num(pad.rotation) + '|HOLETYPE=' + (hole > 0 ? 1 : 0)
      + '|HOLEWIDTH=0mil|HOLEROTATION=0|PADXOFFSET0=0mil|PADYOFFSET0=0mil'
      + '|X=' + mil(ox + num(pad.x)) + '|Y=' + mil(oy + num(pad.y))
      + '|XSIZE=' + mil(pad.w) + '|YSIZE=' + mil(pad.h)
      + '|SHAPE=' + (PAD_SHAPE[String(pad.shape || '').toLowerCase()] || 'RECT')
      + '|PADMODE=0|PASTEMASKEXPANSIONMODE=Rule|CPE=0mil|SOLDERMASKEXPANSIONMODE=Rule'
      + '|TENTINGTOP=FALSE|CSE=2mil|CUSE=TRUE|TENTINGBOTTOM=FALSE|CSB=2mil'
      + '|CCSV=0|CPLV=0|CPEV=1|CCWV=1|CENV=1|CAGV=1|CSEV=1|CPCV=1|CPRV=1');
  }

  for (const trk of tracks) {
    const layer = PCB_LAYER[String(trk.layer || 'top_overlay').toLowerCase()];
    if (!layer) { skipped++; continue; }
    recs.push('|RECORD=Track|COMPONENT=0|LAYER=' + layer + '|POLYGONOUTLINE=FALSE'
      + '|X1=' + mil(ox + num(trk.x1)) + '|Y1=' + mil(oy + num(trk.y1))
      + '|X2=' + mil(ox + num(trk.x2)) + '|Y2=' + mil(oy + num(trk.y2))
      + '|WIDTH=' + mil(trk.width) + '|SOLDERMASKEXPANSIONMODE=Rule|PASTEMASKEXPANSIONMODE=Rule|LOCKED=FALSE');
  }

  for (const arc of arcs) {
    const layer = PCB_LAYER[String(arc.layer || 'top_overlay').toLowerCase()];
    if (!layer) { skipped++; continue; }
    const start = arc.start == null ? 0 : num(arc.start);
    const end = arc.end == null ? 360 : num(arc.end);
    recs.push('|RECORD=Arc|INDEXFORSAVE=' + (arcIndex++) + '|COMPONENT=0|LAYER=' + layer
      + '|WIDTH=' + mil(arc.width)
      + '|LOCATION.X=' + mil(ox + num(arc.x)) + '|LOCATION.Y=' + mil(oy + num(arc.y))
      + '|STARTANGLE=' + start.toFixed(6) + '|ENDANGLE=' + end.toFixed(6)
      + '|RADIUS=' + mil(arc.r) + '|SECONDARYRADIUS=' + mil(arc.r)
      + '|SOLDERMASKEXPANSIONMODE=Rule|PASTEMASKEXPANSIONMODE=Rule|KEEPOUT=FALSE|LOCKED=FALSE');
  }

  const body = recs.join('\r\n') + '\r\n';
  const text = prefix + body + (suffix ? suffix.replace(/\s*$/, '') + '\r\n' : '');
  return { text, skippedPrimitives: skipped };
}

export default { buildSchDoc, buildPcbDoc };
