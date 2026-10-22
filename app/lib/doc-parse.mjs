// doc-parse.mjs - parse the Altium ASCII documents that the EasyEDA web export
// produces, so the library stages can be built from the exported files themselves
// instead of driving Altium's UI.
//
// The export is ASCII (not OLE): every record is one line starting with '|' and
// every field is KEY=VALUE. Coordinates carry a unit suffix ("1234.5600mil").
//
// parseSchDoc(buffer) -> {
//   libReference, partCount, description,
//   pins:   [{ number, name, x, y, length, orient, electrical }],   // mil, lib-relative
//   shapes: [{ kind:'rect', x1,y1,x2,y2 } | { kind:'ellipse', x,y,rx,ry }],
//   stats:  { pins, rects, ellipses }
// }
//
// UNIT NOTE (verified on C92116): SchDoc ASCII stores schematic coordinates in
// 10-mil units. The EasyEDA model pin 1 is -600 mil; the document record is -60.
// Everything returned here is therefore multiplied by 10 and is in mil, which is
// what the SchLib API (MilsToCoord) expects. PcbDoc records carry an explicit
// "mil"/"mm" suffix, so they are parsed as-is.
//
// parsePcbDoc(buffer) -> {
//   pattern, origin:{x,y}, pads, tracks, arcs, regions, texts,
//   stats: { pads, tracks, arcs, regions, texts }
// }
//
// Pin convention conversion (verified against the EasyEDA model for C92116):
//   In the ASCII SchDoc LOCATION is the point where the pin meets the component
//   body and the low two bits of PINCONGLOMERATE point OUTWARD. In the SchLib API
//   Pin.Location is the electrical connection tip and Pin.Orientation points from
//   the tip toward the body. So: tip = location + outward*length, and the API
//   orientation is the opposite of the document orientation.
//   Example: doc pin 1 at (-50,+70)mil, length 10, conglomerate 58 (left)
//            -> tip (-60,+70), orientation 0 (right) - exactly the model pin.

export function parseAsciiRecords(input) {
  const text = Buffer.isBuffer(input) ? input.toString('latin1') : String(input == null ? '' : input);
  const records = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const kv = {};
    for (const part of line.split('|')) {
      const eq = part.indexOf('=');
      if (eq > 0) kv[part.slice(0, eq)] = part.slice(eq + 1);
    }
    records.push(kv);
  }
  return records;
}

/** "3029.2400mil" / "12.7mm" / "1.25" -> mil (number). */
export function toMil(value) {
  if (value == null || value === '') return null;
  const m = String(value).trim().match(/^(-?\d+(?:\.\d+)?)\s*(mil|mm|in)?$/i);
  if (!m) return null;
  let v = Number(m[1]);
  const unit = (m[2] || 'mil').toLowerCase();
  if (unit === 'mm') v *= 39.37007874015748;
  else if (unit === 'in') v *= 1000;
  return v;
}

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const milNum = (value, fallback = 0) => {
  const n = toMil(value);
  return n == null ? fallback : n;
};

const SCH_ELECTRICAL = ['input', 'output', 'bidirectional', 'passive', 'unspecified'];
const SCH_MIL_PER_UNIT = 10; // SchDoc ASCII unit = 10 mil (see the note above)

export function parseSchDoc(input) {
  const records = parseAsciiRecords(input);
  const comp = records.find((r) => r.RECORD === '1');
  if (!comp) throw new Error('SchDoc: no RECORD=1 component found');
  const oxRaw = num(comp['LOCATION.X']);
  const oyRaw = num(comp['LOCATION.Y']);
  const ox = oxRaw * SCH_MIL_PER_UNIT;
  const oy = oyRaw * SCH_MIL_PER_UNIT;
  const pins = [];
  const shapes = [];

  for (const r of records) {
    if (r.RECORD === '2') {
      const x = (num(r['LOCATION.X']) - oxRaw) * SCH_MIL_PER_UNIT;
      const y = (num(r['LOCATION.Y']) - oyRaw) * SCH_MIL_PER_UNIT;
      const length = num(r.PINLENGTH) * SCH_MIL_PER_UNIT;
      const outward = num(r.PINCONGLOMERATE) & 3; // 0=right 1=up 2=left 3=down
      const dx = outward === 0 ? 1 : outward === 2 ? -1 : 0;
      const dy = outward === 1 ? 1 : outward === 3 ? -1 : 0;
      pins.push({
        number: String(r.DESIGNATOR == null ? '' : r.DESIGNATOR),
        name: r.NAME == null || r.NAME === '' ? '~' : String(r.NAME),
        // tip + inward orientation (used by buildSchDoc to reproduce the ASCII record)
        x: x + dx * length,
        y: y + dy * length,
        length,
        orient: (((outward + 2) & 3) * 90),
        // body edge + outward orientation (this is what the SchLib pin API wants;
        // using tip+inward made every pin appear rotated by 180 degrees)
        bodyX: x,
        bodyY: y,
        outwardOrient: outward * 90,
        electrical: SCH_ELECTRICAL[num(r.ELECTRICAL, 4)] || 'unspecified',
        ownerPartId: num(r.OWNERPARTID, 1),
      });
    } else if (r.RECORD === '10') {
      shapes.push({
        kind: 'rect',
        x1: (num(r['LOCATION.X']) - oxRaw) * SCH_MIL_PER_UNIT,
        y1: (num(r['LOCATION.Y']) - oyRaw) * SCH_MIL_PER_UNIT,
        x2: (num(r['CORNER.X']) - oxRaw) * SCH_MIL_PER_UNIT,
        y2: (num(r['CORNER.Y']) - oyRaw) * SCH_MIL_PER_UNIT,
        lineWidth: num(r.LINEWIDTH, 1),
      });
    } else if (r.RECORD === '12') {
      shapes.push({
        kind: 'ellipse',
        x: (num(r['LOCATION.X']) - oxRaw) * SCH_MIL_PER_UNIT,
        y: (num(r['LOCATION.Y']) - oyRaw) * SCH_MIL_PER_UNIT,
        rx: num(r.RADIUS) * SCH_MIL_PER_UNIT,
        ry: num(r.SECONDARYRADIUS) * SCH_MIL_PER_UNIT,
        lineWidth: num(r.LINEWIDTH, 1),
      });
    }
  }

  return {
    libReference: String(comp.LIBREFERENCE || ''),
    partCount: num(comp.PARTCOUNT, 1),
    location: { x: ox, y: oy },
    pins,
    shapes,
    stats: {
      pins: pins.length,
      rects: shapes.filter((s) => s.kind === 'rect').length,
      ellipses: shapes.filter((s) => s.kind === 'ellipse').length,
    },
  };
}

const PAD_SHAPE = { ROUND: 'round', RECT: 'rect', RECTANGULAR: 'rect', OCTAGONAL: 'octagonal' };
const COPPER_LAYER = {
  TOP: 'top', BOTTOM: 'bottom',
  TOPOVERLAY: 'top_overlay', BOTTOMOVERLAY: 'bottom_overlay',
  TOPPASTE: 'top_paste', BOTTOMPASTE: 'bottom_paste',
  TOPSOLDER: 'top_solder', BOTTOMSOLDER: 'bottom_solder',
  MULTILAYER: 'multi',
};

export function parsePcbDoc(input) {
  const records = parseAsciiRecords(input);
  const comp = records.find((r) => r.RECORD === 'Component');
  if (!comp) throw new Error('PcbDoc: no RECORD=Component found');
  const ox = milNum(comp.X);
  const oy = milNum(comp.Y);
  const compId = comp.ID == null ? null : String(comp.ID);
  const belongs = (r) => compId == null || r.COMPONENT == null || String(r.COMPONENT) === compId;

  const pads = [];
  const tracks = [];
  const arcs = [];
  let regions = 0;
  let texts = 0;

  for (const r of records) {
    if (!belongs(r)) continue;
    switch (r.RECORD) {
      case 'Pad': {
        const hole = milNum(r.HOLESIZE);
        const layer = COPPER_LAYER[String(r.LAYER || '').toUpperCase()] || 'top';
        pads.push({
          number: String(r.NAME == null ? '' : r.NAME),
          x: milNum(r.X) - ox,
          y: milNum(r.Y) - oy,
          w: milNum(r.XSIZE),
          h: milNum(r.YSIZE),
          shape: PAD_SHAPE[String(r.SHAPE || '').toUpperCase()] || 'rect',
          layer: hole > 0 ? 'multi' : layer,
          hole,
          rotation: milNum(r.ROTATION, 0),
        });
        break;
      }
      case 'Track': {
        const layer = COPPER_LAYER[String(r.LAYER || '').toUpperCase()];
        if (!layer) break;
        tracks.push({
          layer,
          x1: milNum(r.X1) - ox, y1: milNum(r.Y1) - oy,
          x2: milNum(r.X2) - ox, y2: milNum(r.Y2) - oy,
          width: milNum(r.WIDTH),
        });
        break;
      }
      case 'Arc': {
        const layer = COPPER_LAYER[String(r.LAYER || '').toUpperCase()];
        if (!layer) break;
        arcs.push({
          layer,
          x: milNum(r['LOCATION.X']) - ox,
          y: milNum(r['LOCATION.Y']) - oy,
          r: milNum(r.RADIUS),
          rx: milNum(r.SECONDARYRADIUS, milNum(r.RADIUS)),
          start: milNum(r.STARTANGLE, 0),
          end: milNum(r.ENDANGLE, 360),
          width: milNum(r.WIDTH),
        });
        break;
      }
      case 'Region': regions++; break;
      case 'Text': texts++; break;
      default: break;
    }
  }

  return {
    pattern: String(comp.PATTERN || ''),
    origin: { x: ox, y: oy },
    rotation: milNum(comp.ROTATION, 0),
    layer: COPPER_LAYER[String(comp.LAYER || '').toUpperCase()] || 'top',
    pads, tracks, arcs, regions, texts,
    stats: { pads: pads.length, tracks: tracks.length, arcs: arcs.length, regions, texts },
  };
}

export default { parseAsciiRecords, parseSchDoc, parsePcbDoc, toMil };
