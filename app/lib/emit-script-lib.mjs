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
// Bump these whenever the generated library geometry changes. The pipeline records
// them per target library in jobs/_lib-registry.json, so it can tell a component
// written by an older emitter from a current one and redraw instead of skipping.
// They are independent: a PcbLib-only change must not invalidate every SchLib.
// v11 (SCH): polylines, closed polygons, symbol arcs, correct ellipse record (8)
// and fractional SchDoc coordinates. v12 (PCB): every EasyEDA footprint layer is
// drawn - solder mask/paste/graphics plus filled SOLIDREGION shapes (body -> M8,
// lead -> M9, document -> M2, marking -> silk). v13 (PCB): match LCEDA's own
// Altium export exactly - pad paste/solder-mask expansions, the Mechanical 6
// body outline derived from the layer-99 region, and layer 101 (component
// marking) is no longer drawn because the exporter drops it. v10 (PCB): pad
// rotation, NPTH mounting holes, silk arcs/rectangles, bottom silk no longer
// lands on bottom copper. v14 (PCB): Mechanical 8 carries only a small pin-1
// orientation dot - the filled layer-99 body shapes and every other
// component_shape primitive are no longer drawn.
const PIN_SUFFIX = '-p' + (process.env.PIN_LENGTH_MIL || 150);
export const LIB_MARKER_SCH = 'LCEDA2AD-v11' + PIN_SUFFIX;
export const LIB_MARKER_PCB = 'LCEDA2AD-v14' + PIN_SUFFIX;
// Kept for callers that predate the split; it tracks the PCB library.
export const LIB_MARKER = LIB_MARKER_PCB;
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
// EasyEDA footprint layer -> Altium layer. Manufacturing layers keep their real
// Altium meaning (silk/mask/paste/copper). EasyEDA's documentation layers are
// parked on mechanical layers, following the LCSC official Altium library:
//   100 lead shape -> Mechanical 9, 12 document -> Mechanical 2.
// Layer 99 (component shape) is NOT drawn as filled regions: the PcbLib only
// needs a small pin-1 orientation dot on Mechanical 8, emitted below.
// 101 (component marking, usually a tiny pin-1 dot) is also not drawn.
const PCB_LAYER = {
  top: 'eTopLayer', bottom: 'eBottomLayer', multi: 'eMultiLayer',
  top_overlay: 'eTopOverlay', bottom_overlay: 'eBottomOverlay',
  top_paste: 'eTopPaste', bottom_paste: 'eBottomPaste',
  top_solder: 'eTopSolder', bottom_solder: 'eBottomSolder',
  board_outline: 'eKeepOutLayer',
  document: 'eMechanical2',
  top_assembly: 'eMechanical4',
  bottom_assembly: 'eMechanical5',
  mechanical: 'eMechanical6',
  component_shape: 'eMechanical8',
  lead_shape: 'eMechanical9',
};
const SKIP_LAYER = (layer) => String(layer || '').toLowerCase() === 'component_marking';
const isComponentShape = (layer) => String(layer || '').toLowerCase() === 'component_shape';
// Mechanical 8 carries exactly one small pin-1 dot (no filled body shapes).
// Radius 6 mil = 0.152 mm; the dot sits 6 mil clear of pad 1's outer edge, on
// the side facing away from the pad bounding-box centre.
const PIN1_DOT_RADIUS_MIL = 6;
const PIN1_DOT_GAP_MIL = 6;
const PIN1_DOT_SEGMENTS = 16;
// Graphics on EasyEDA's MULTI layer show on every copper layer. Altium has no
// multi-layer track/arc/region, so draw them once on each outer copper layer.
const GRAPHIC_LAYERS = (layer) => (String(layer || '').toLowerCase() === 'multi' ? ['top', 'bottom'] : [layer]);
// LCEDA's export outlines the body (EasyEDA layer 99) with 2 mil tracks on
// Mechanical 6. Mechanical 8 itself only carries the pin-1 dot.
const LCEDA_BODY_OUTLINE_WIDTH_MIL = 2;
// EasyEDA PAD field 18 is 0.2 units (2 mil) on every official LCSC footprint
// inspected; use it when the field is absent.
const LCEDA_SOLDER_MASK_MIL = 2;
const padShape = (s) => PAD_SHAPE[String(s || '').toLowerCase()] || 'eRectangular';
const pcbLayer = (l) => PCB_LAYER[String(l || '').toLowerCase()] || 'eTopLayer';

// LCEDA keeps the reference prefix in head.c_para.pre ("R?", "U?", "SW?").
// The SchLib designator is that uppercase prefix plus "??"; U is only a fallback
// for payloads written before the model carried designatorPrefix.
const DESIGNATOR_FALLBACK = 'U';
export function designatorText(model) {
  const letters = String((model && model.designatorPrefix) || '')
    .toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  return (letters || DESIGNATOR_FALLBACK) + '??';
}

/**
 * Centre of the Mechanical 8 pin-1 dot, in mil.
 * Pad 1 is found by its designator ("1"); a footprint without one falls back to
 * the first pad. The dot is pushed outward from the centre of the pad bounding
 * box, just past the pad edge, so it stays beside the pin instead of under it.
 */
export function pin1Dot(model) {
  const fp = model.footprint || {};
  const pads = (fp.pads || []).filter((p) => Number(p.w) > 0 && Number(p.h) > 0);
  if (!pads.length) return null;
  const pad = pads.find((p) => String(p.number) === '1') || pads[0];
  const xs = pads.map((p) => Number(p.x) || 0);
  const ys = pads.map((p) => Number(p.y) || 0);
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
  let dx = (Number(pad.x) || 0) - centerX;
  let dy = (Number(pad.y) || 0) - centerY;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) { dx = -1; dy = 0; } else { dx /= len; dy /= len; }
  const half = Math.max(Number(pad.w) || 0, Number(pad.h) || 0) / 2;
  const distance = half + PIN1_DOT_GAP_MIL + PIN1_DOT_RADIUS_MIL;
  return {
    x: (Number(pad.x) || 0) + dx * distance,
    y: (Number(pad.y) || 0) + dy * distance,
    r: PIN1_DOT_RADIUS_MIL,
  };
}

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
    } else if (kind === 'arc') {
      // Only the swept part counts, so a large left-side arc does not push the
      // visible Value far past the symbol's right edge.
      const cx = Number(sh.x) || 0;
      const cy = Number(sh.y) || 0;
      const r = Math.max(Number(sh.r) || 0, Number(sh.rx) || 0, Number(sh.ry) || 0);
      if (r > 0) {
        const start = Number(sh.start) || 0;
        const end = sh.end == null ? 360 : Number(sh.end);
        let span = end - start;
        if (span <= 0) span += 360;
        if (span >= 360 - 1e-6) {
          add(cx - r, cy - r); add(cx + r, cy + r);
        } else {
          const at = (deg) => {
            const rad = (deg * Math.PI) / 180;
            add(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
          };
          at(start); at(end);
          for (const cardinal of [0, 90, 180, 270]) {
            const delta = ((cardinal - start) % 360 + 360) % 360;
            if (delta <= span + 1e-9) at(cardinal);
          }
        }
      }
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
  out.push('    Target.Designator.Text      := ' + quote(designatorText(model)) + ';');
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
      const closed = kind === 'polygon' && pts.length >= 3;
      const segments = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < segments; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        out.push('    AddLine(Target, ' + [a[0], a[1], b[0], b[1]].map(int).join(', ') + ');');
      }
    } else if (kind === 'arc') {
      const r = Number(sh.r) || Math.max(Number(sh.rx) || 0, Number(sh.ry) || 0);
      if (r > 0) {
        out.push('    AddArc(Target, ' + [sh.x, sh.y, r].map(int).join(', ') + ', '
          + num(sh.start == null ? 0 : sh.start) + ', ' + num(sh.end == null ? 360 : sh.end) + ');');
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
    const w = Number(pad.w) || 0;
    const h = Number(pad.h) || 0;
    if (!(w > 0) || !(h > 0)) continue; // degenerate pad: nothing to draw
    const rotation = ((Number(pad.rotation) || 0) % 360 + 360) % 360;
    out.push(
      '        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);',
      '        Pad.Mode     := ePadMode_Simple;',
      '        Pad.Layer    := ' + pcbLayer(pad.layer) + ';',
      '        Pad.TopShape := ' + padShape(pad.shape) + ';',
      '        Pad.TopXSize := MMsToCoord(' + num(mm(w)) + ');',
      '        Pad.TopYSize := MMsToCoord(' + num(mm(h)) + ');',
      '        Pad.X        := MMsToCoord(' + num(mm(pad.x)) + ');',
      '        Pad.Y        := MMsToCoord(' + num(mm(pad.y)) + ');',
      '        Pad.Name     := ' + quote(pad.number) + ';',
      '        Pad.HoleSize := MMsToCoord(' + num(mm(pad.hole)) + ');',
    );
    // EasyEDA PAD field 11 carries the pad rotation; without it a 90-degree QFN
    // pad is drawn with its width and height swapped.
    if (rotation !== 0) out.push('        Pad.Rotation := ' + num(rotation) + ';');
    // HOLE records become pads with plated copper removed (NPTH mechanical holes).
    if (pad.plated === false) out.push('        Pad.Plated   := False;');
    // Pad mask expansions, copied from the EasyEDA PAD fields exactly as LCEDA's
    // Altium export does it. A non-zero paste value (normally -393.7 units =
    // -3937 mil) means "no paste from the pad": the paste comes from the
    // layer-5 regions instead. A zero value leaves the normal rule in charge.
    // SetPadMask() is a template-level helper because IPCB_Pad has no writable
    // PasteMaskExpansionMode in DelphiScript; the values go through Pad.Cache.
    const pasteExpansion = Number(pad.pasteExpansion) || 0;
    const solderExpansion = Number.isFinite(Number(pad.solderExpansion))
      ? Number(pad.solderExpansion) : LCEDA_SOLDER_MASK_MIL;
    out.push(
      '        SetPadMask(Pad, ' + num(pasteExpansion / MIL_PER_MM) + ', '
        + num(solderExpansion / MIL_PER_MM) + ');',
      '        ' + owner + '.AddPCBObject(Pad);',
    );
  }
  for (const trk of fp.tracks || []) {
    if (SKIP_LAYER(trk.layer) || isComponentShape(trk.layer)) continue;
    if (Number(trk.x1) === Number(trk.x2) && Number(trk.y1) === Number(trk.y2)) continue;
    for (const layer of GRAPHIC_LAYERS(trk.layer)) {
      out.push(
        '        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);',
        '        Trk.Layer := ' + pcbLayer(layer) + ';',
        '        Trk.Width := MMsToCoord(' + num(mm(trk.width == null ? 0.15 : trk.width)) + ');',
        '        Trk.X1    := MMsToCoord(' + num(mm(trk.x1)) + ');',
        '        Trk.Y1    := MMsToCoord(' + num(mm(trk.y1)) + ');',
        '        Trk.X2    := MMsToCoord(' + num(mm(trk.x2)) + ');',
        '        Trk.Y2    := MMsToCoord(' + num(mm(trk.y2)) + ');',
        '        ' + owner + '.AddPCBObject(Trk);',
      );
    }
  }
  // Circles are full 360-degree arcs. The parsed document model keeps them in
  // fp.arcs already, but a raw EasyEDA model still has fp.circles, so accept both.
  const arcs = [];
  const arcKeys = new Set();
  const addArc = (a) => {
    const key = [a.layer, a.x, a.y, a.r, a.start, a.end].join('|');
    if (arcKeys.has(key)) return;
    arcKeys.add(key);
    arcs.push(a);
  };
  for (const a of fp.arcs || []) addArc(a);
  for (const c of fp.circles || []) {
    addArc({ layer: c.layer, x: c.x, y: c.y, r: c.r, start: 0, end: 360, width: c.width });
  }
  for (const arc of arcs) {
    if (SKIP_LAYER(arc.layer) || isComponentShape(arc.layer)) continue;
    if (!(Number(arc.r) > 0)) continue;
    for (const layer of GRAPHIC_LAYERS(arc.layer)) {
      out.push(
        '        Arc := PCBServer.PCBObjectFactory(eArcObject, eNoDimension, eCreate_Default);',
        '        Arc.Layer      := ' + pcbLayer(layer) + ';',
        '        Arc.LineWidth  := MMsToCoord(' + num(mm(arc.width == null ? 0.15 : arc.width)) + ');',
        '        Arc.XCenter    := MMsToCoord(' + num(mm(arc.x)) + ');',
        '        Arc.YCenter    := MMsToCoord(' + num(mm(arc.y)) + ');',
        '        Arc.Radius     := MMsToCoord(' + num(mm(arc.r)) + ');',
        '        Arc.StartAngle := ' + num(arc.start == null ? 0 : arc.start) + ';',
        '        Arc.EndAngle   := ' + num(arc.end == null ? 360 : arc.end) + ';',
        '        ' + owner + '.AddPCBObject(Arc);',
      );
    }
  }
  // LCEDA's Altium export adds the body contour (the layer-99 region) as a
  // closed 2 mil outline on Mechanical 6. The filled layer-99 shape is not
  // drawn on Mechanical 8 any more - that layer only carries the pin-1 dot.
  // Without this outline the library would be missing the visible component
  // outline that the exported PcbDoc carries.
  const addMechanicalOutline = (points) => {
    if (!Array.isArray(points) || points.length < 3) return;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (Number(a[0]) === Number(b[0]) && Number(a[1]) === Number(b[1])) continue;
      out.push(
        '        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);',
        '        Trk.Layer := eMechanical6;',
        '        Trk.Width := MMsToCoord(' + num(mm(LCEDA_BODY_OUTLINE_WIDTH_MIL)) + ');',
        '        Trk.X1    := MMsToCoord(' + num(mm(a[0])) + ');',
        '        Trk.Y1    := MMsToCoord(' + num(mm(a[1])) + ');',
        '        Trk.X2    := MMsToCoord(' + num(mm(b[0])) + ');',
        '        Trk.Y2    := MMsToCoord(' + num(mm(b[1])) + ');',
        '        ' + owner + '.AddPCBObject(Trk);',
      );
    }
  };
  for (const region of fp.regions || []) {
    if (String(region.layer || '').toLowerCase() !== 'component_shape') continue;
    if (String(region.kind || 'solid').toLowerCase() !== 'solid') continue;
    addMechanicalOutline(region.points);
  }
  // Filled polygons and the Mechanical 8 pin-1 dot live in their own procedure:
  // if this build's scripting engine rejects any region identifier, only that
  // procedure stops (the pads, tracks and arcs above, the save, and DONE still
  // run). See buildRegionBody.
  if ((fp.regions || []).length || pin1Dot(model)) out.push('        AddFootprintRegions(' + owner + ');');
  return out.join('\n');
}

/**
 * Body of AddFootprintRegions: EasyEDA SOLIDREGION -> IPCB_Region.
 * Authoring path: PCBServer.PCBContourFactory gives an empty IPCB_Contour;
 * fill it with AddPoint, hand it to Region.SetOutlineContour. Only `solid`
 * regions are filled; cutout/npth regions are drawn as closed track outlines.
 */
export function buildRegionBody(model) {
  const fp = model.footprint || {};
  const out = [];
  // A closed contour drawn with the already-verified Track API. Used for
  // cutout/npth regions and for region holes: their area must stay unfilled.
  const addOutline = (points, layer) => {
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (Number(a[0]) === Number(b[0]) && Number(a[1]) === Number(b[1])) continue;
      out.push(
        '    Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);',
        '    Trk.Layer := ' + pcbLayer(layer) + ';',
        '    Trk.Width := MMsToCoord(0.15);',
        '    Trk.X1    := MMsToCoord(' + num(mm(a[0])) + ');',
        '    Trk.Y1    := MMsToCoord(' + num(mm(a[1])) + ');',
        '    Trk.X2    := MMsToCoord(' + num(mm(b[0])) + ');',
        '    Trk.Y2    := MMsToCoord(' + num(mm(b[1])) + ');',
        '    Target.AddPCBObject(Trk);',
      );
    }
  };
  for (const region of fp.regions || []) {
    if (SKIP_LAYER(region.layer) || isComponentShape(region.layer)) continue;
    const points = Array.isArray(region.points) ? region.points : [];
    if (points.length < 3) continue;
    const kind = String(region.kind || 'solid').toLowerCase();
    for (const layer of GRAPHIC_LAYERS(region.layer)) {
      if (kind !== 'solid') {
        // cutout / npth: outline only, matching EasyEDA's own rendering.
        addOutline(points, layer);
        continue;
      }
      out.push(
        '    Contour := PCBServer.PCBContourFactory;',
        '    If Assigned(Contour) Then',
        '    Begin',
        '        Contour.Clear;',
        '        Region := PCBServer.PCBObjectFactory(eRegionObject, eNoDimension, eCreate_Default);',
        '        If Assigned(Region) Then',
        '        Begin',
        '            Region.Layer := ' + pcbLayer(layer) + ';',
      );
      for (const p of points) {
        out.push('            Contour.AddPoint(MMsToCoord(' + num(mm(p[0])) + '), MMsToCoord(' + num(mm(p[1])) + '));');
      }
      out.push(
        '            Region.SetOutlineContour(Contour);',
        '            Target.AddPCBObject(Region);',
        '        End;',
        '    End;',
      );
      // Sub-contours are holes: draw their boundary so the void is visible.
      for (const hole of region.holes || []) {
        if (Array.isArray(hole) && hole.length >= 3) addOutline(hole, layer);
      }
    }
  }
  // Mechanical 8 is deliberately minimal: one small filled dot beside pad 1.
  // It is a 16-sided polygon region (the API's only filled-shape primitive here)
  // and is the sole object emitted on that layer.
  const dot = pin1Dot(model);
  if (dot) {
    out.push(
      '    Contour := PCBServer.PCBContourFactory;',
      '    If Assigned(Contour) Then',
      '    Begin',
      '        Contour.Clear;',
      '        Region := PCBServer.PCBObjectFactory(eRegionObject, eNoDimension, eCreate_Default);',
      '        If Assigned(Region) Then',
      '        Begin',
      '            Region.Layer := eMechanical8;',
    );
    for (let i = 0; i < PIN1_DOT_SEGMENTS; i += 1) {
      const angle = (i / PIN1_DOT_SEGMENTS) * Math.PI * 2;
      const px = dot.x + Math.cos(angle) * dot.r;
      const py = dot.y + Math.sin(angle) * dot.r;
      out.push('            Contour.AddPoint(MMsToCoord(' + num(mm(px)) + '), MMsToCoord(' + num(mm(py)) + '));');
    }
    out.push(
      '            Region.SetOutlineContour(Contour);',
      '            Target.AddPCBObject(Region);',
      '        End;',
      '    End;',
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
  const fpRegions = (model.footprint && model.footprint.regions) || [];
  const validRegions = fpRegions.filter((r) => Array.isArray(r.points) && r.points.length >= 3);
  const solidRegionCount = validRegions.filter((r) => String(r.kind || 'solid').toLowerCase() === 'solid').length;
  const outlineRegionCount = validRegions.length - solidRegionCount;
  const skippedRegionCount = fpRegions.length - validRegions.length;
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
    REGION_BODY: buildRegionBody(model),
    RUNJOB: runJobLines.join('\r\n'),
    PARTSCHLIB: pasEsc(paths.partSchLibPath),
    PARTPCBLIB: pasEsc(paths.partPcbLibPath),
    COUNTSINGLE: [
      steps.indexOf('schlib_part') >= 0
        ? "    W('COUNT single schlib comps=' + IntToStr(PartSchComps) + ' pins=" + (Array.isArray(pins) ? pins.length : 0) + " libref=" + pasEsc(libName) + " src=script-api');"
        : '',
      steps.indexOf('pcblib_part') >= 0
        ? "    W('COUNT single pcblib comps=' + IntToStr(PartPcbComps) + ' pads=" + (Array.isArray(pads) ? pads.length : 0) + " regions=" + validRegions.length + " skippedregions=" + skippedRegionCount + " name=" + pasEsc(pkg) + " src=model+file-check');"
        : '',
    ].filter(Boolean).join('\r\n'),
    PINS: String(pins.length),
    PADS: String(pads.length),
    REGIONS: String(validRegions.length),
    SKIPPEDREGIONS: String(skippedRegionCount),
    REGION_SOLID: String(solidRegionCount),
    REGION_OUTLINE: String(outlineRegionCount),
    REGION_SKIPPED: String(skippedRegionCount),
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

export default { emitScriptJob, buildSymbolBody, buildFootprintBody, buildRegionBody };
