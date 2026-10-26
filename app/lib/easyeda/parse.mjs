// EasyEDA payload -> CONTRACT.md §1 normalisation.
// Units: 1 EasyEDA unit = 0.254 mm = 10 mil (proven in _probe/spec.md §3).
// EasyEDA y grows DOWN, the model is y-UP, so every y is negated after subtracting the document anchor.

export const MM_PER_UNIT = 0.254;
export const MIL_PER_UNIT = 10;

const ELECTRICAL = { 0: "unspecified", 1: "passive", 2: "output", 4: "power" };
const PAD_SHAPE = { RECT: "rect", OVAL: "round", ELLIPSE: "round", POLYGON: "octagonal" };
const PAD_LAYER = { 1: "top", 2: "bottom", 11: "multi" };
// EasyEDA Std PCB layer ids in footprint documents (verified against easyeda2kicad's
// layer table and the LCSC official Altium library):
//   1 top copper, 2 bottom copper, 3 top silk, 4 bottom silk,
//   5 top paste, 6 bottom paste, 7 top solder mask, 8 bottom solder mask,
//   10 board outline, 11 multi-layer, 12 document, 13 top assembly,
//   14 bottom assembly, 15 mechanical, 19 3D model,
//   99 component shape (body), 100 lead shape, 101 component marking (polarity).
// Every layer is carried into the model; the PcbLib emitter maps each one to the
// closest Altium layer (see PCB_LAYER in emit-script-lib.mjs).
const GRAPHIC_LAYER = {
  1: "top",
  2: "bottom",
  3: "top_overlay",
  4: "bottom_overlay",
  5: "top_paste",
  6: "bottom_paste",
  7: "top_solder",
  8: "bottom_solder",
  10: "board_outline",
  11: "multi",
  12: "document",
  13: "top_assembly",
  14: "bottom_assembly",
  15: "mechanical",
  99: "component_shape",
  100: "lead_shape",
  101: "component_marking",
};
// EasyEDA RECT carries no stroke width; use the common 8 mil silk line.
const RECT_WIDTH_MM = 0.2;

const num = (value, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const round4 = (value) => {
  const rounded = Math.round(value * 1e4) / 1e4;
  return rounded === 0 ? 0 : rounded;
};

const mil = (units) => round4(units * MIL_PER_UNIT);
const mm = (units) => round4(units * MM_PER_UNIT);
const numbers = (text) => (String(text ?? "").match(/-?\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite);

/** Pairs of numbers -> [[x, y], …]. Used for the whitespace separated point lists. */
function pairs(text) {
  const values = numbers(text);
  const points = [];
  for (let i = 0; i + 1 < values.length; i += 2) points.push([values[i], values[i + 1]]);
  return points;
}

/**
 * Parse an EasyEDA path: "M 1 2 h 10", "M525,335h-10", "v -10", "A rx ry rot laf sf x y".
 * Unknown tokens are skipped instead of throwing.
 */
export function pathPoints(path) {
  const tokens = String(path ?? "").match(/[A-Za-z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  const points = [];
  let current = null;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "M" || token === "L") {
      current = [num(tokens[i + 1]), num(tokens[i + 2])];
      points.push(current);
      i += 3;
    } else if (token === "m" || token === "l") {
      const from = current || [0, 0];
      current = [from[0] + num(tokens[i + 1]), from[1] + num(tokens[i + 2])];
      points.push(current);
      i += 3;
    } else if ((token === "h" || token === "H" || token === "v" || token === "V") && current) {
      const horizontal = token === "h" || token === "H";
      const relative = token === "h" || token === "v";
      const raw = num(tokens[i + 1]);
      const coordinate = relative ? (horizontal ? current[0] : current[1]) + raw : raw;
      current = horizontal ? [coordinate, current[1]] : [current[0], coordinate];
      points.push(current);
      i += 2;
    } else if (token === "A" || token === "a") {
      current = [num(tokens[i + 6]), num(tokens[i + 7])];
      points.push(current);
      i += 8;
    } else if (token === "Z" || token === "z") {
      i += 1;
    } else {
      i += 1;
    }
  }
  return points;
}

/**
 * Split an SVG-style path into its sub-contours. EasyEDA emits one M…Z block per
 * contour; the first contour is the outer boundary, later ones are holes. The
 * model keeps the outer contour in `points` and the rest in `holes`; the PcbLib
 * emitter fills `points` and outlines each hole with closed tracks.
 */
export function pathContours(path) {
  const text = String(path ?? "");
  const chunks = text.split(/(?=[Mm])/).map((chunk) => chunk.trim()).filter(Boolean);
  const contours = [];
  for (const chunk of chunks) {
    const points = pathPoints(chunk);
    if (points.length >= 2) contours.push(points);
  }
  return contours;
}

function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

/** doc.shape is usually a string[] but tolerate a lone string / missing value. */
function shapeRecords(doc) {
  const shape = doc && typeof doc === "object" ? doc.shape : null;
  if (Array.isArray(shape)) return shape.filter((record) => typeof record === "string" && record.trim() !== "");
  if (typeof shape === "string") return shape.split("\n").filter((record) => record.trim() !== "");
  return [];
}

function anchorOf(doc) {
  const head = doc && typeof doc === "object" && doc.head && typeof doc.head === "object" ? doc.head : {};
  return [num(head.x), num(head.y)];
}

function parsePin(record, ox, oy) {
  const chunks = record.split("^^");
  const header = chunks[0].split("~");
  if (header.length < 7) return null;
  const x = num(header[4]);
  const y = num(header[5]);
  // EasyEDA only emits multiples of 90; snapping keeps the CONTRACT §1 enum {0,90,180,270}
  // intact even for odd data instead of inventing a 45 degree orientation.
  const rotation = ((Math.round(num(header[6]) / 90) * 90) % 360 + 360) % 360;
  // pin length = length of the pin line: sub-record 2 holds "path~colour"
  const lengthUnits = pathLength(pathPoints((chunks[2] || "").split("~")[0])) || 10;
  const nameChunk = chunks[3] || "";
  const nameFields = nameChunk.split("~");
  const name = nameFields.length > 4 ? nameFields[4] : "";
  const code = Math.round(num(header[2]));
  return {
    number: String(header[3] ?? ""),
    name: name || "~",
    x: mil(x - ox),
    y: mil(-(y - oy)),
    orient: (rotation + 180) % 360,
    length: mil(lengthUnits),
    electrical: ELECTRICAL[code] || "unspecified",
  };
}

function parseSymbolShape(record, ox, oy) {
  const fields = record.split("~");
  switch (fields[0]) {
    case "R": {
      // R~x~y~?~?~w~h~stroke~stroke_width~fillstyle~fill~id~locked   (x,y = top-left, y down)
      const x = num(fields[1]) - ox;
      const y = num(fields[2]) - oy;
      const width = num(fields[5]);
      const height = num(fields[6]);
      const xs = [mil(x), mil(x + width)].sort((a, b) => a - b);
      const ys = [mil(-y), mil(-(y + height))].sort((a, b) => a - b);
      return { kind: "rect", x1: xs[0], y1: ys[0], x2: xs[1], y2: ys[1] };
    }
    case "E": {
      // E~cx~cy~rx~ry~stroke~stroke_width~fillstyle~fill~id~locked
      return {
        kind: "ellipse",
        x: mil(num(fields[1]) - ox),
        y: mil(-(num(fields[2]) - oy)),
        rx: mil(num(fields[3])),
        ry: mil(num(fields[4])),
      };
    }
    case "PL": {
      // PL~x1 y1 x2 y2 …~stroke~stroke_width~fillstyle~fill~id~locked
      const points = pairs(fields[1]).map(([x, y]) => [mil(x - ox), mil(-(y - oy))]);
      return points.length >= 2 ? { kind: "polyline", points } : null;
    }
    case "PT": {
      // PT~M x y L x y … Z~stroke~stroke_width~fillstyle~fill~id~locked
      const points = pathPoints(fields[1]).map(([x, y]) => [mil(x - ox), mil(-(y - oy))]);
      return points.length >= 3 ? { kind: "polygon", points } : null;
    }
    case "PG": {
      // PG~x1 y1 x2 y2 …~stroke~stroke_width~fillstyle~fill~id~locked
      // Same point list as PL, but the shape is closed (EasyEDA filled polygon).
      const points = pairs(fields[1]).map(([x, y]) => [mil(x - ox), mil(-(y - oy))]);
      return points.length >= 3 ? { kind: "polygon", points } : null;
    }
    default:
      // "T" (text) was never observed in any probed part; skip instead of guessing.
      return null;
  }
}

/**
 * EasyEDA symbol arc record:
 *   A~M x y A rx,ry rot large sweep x2,y2~~stroke~width~fillstyle~fill~id~locked
 * Circular arcs become `arc` shapes; elliptical ones are sampled into polylines.
 */
function parseSymbolArcs(record, ox, oy) {
  const fields = record.split("~");
  const toModel = (x, y) => [mil(x - ox), mil(-(y - oy))];
  const parsed = svgPathToShapes(fields[1], toModel, mil);
  const shapes = [];
  for (const a of parsed.arcs) shapes.push({ kind: "arc", ...a });
  for (const line of parsed.polylines) {
    if (line.length >= 2) shapes.push({ kind: "polyline", points: line });
  }
  return shapes;
}

function parseSymbolDoc(doc) {
  const [ox, oy] = anchorOf(doc);
  const pins = [];
  const shapes = [];
  for (const record of shapeRecords(doc)) {
    if (record.startsWith("P~")) {
      const pin = parsePin(record, ox, oy);
      if (pin) pins.push(pin);
    } else if (record.startsWith("A~")) {
      shapes.push(...parseSymbolArcs(record, ox, oy));
    } else {
      const shape = parseSymbolShape(record, ox, oy);
      if (shape) shapes.push(shape);
    }
  }
  return { pins, shapes };
}

function parsePad(record, ox, oy) {
  // PAD~shape~cx~cy~w~h~layer~net~number~drill_radius~outline~rotation~id~…
  const fields = record.split("~");
  if (fields.length < 9) return null;
  const layerId = Math.round(num(fields[6], 1));
  const holeRadius = num(fields[9]);
  // Field 11 is the pad's rotation in degrees (verified on C84256 / C25804).
  // All Altium-supported pad shapes are centrally symmetric, so the y-mirror used
  // by the model does not change the drawn orientation.
  const rotation = ((num(fields[11]) % 360) + 360) % 360;
  // Fields 17/18 are the paste / solder-mask expansions in EasyEDA units (10 mil).
  // LCEDA's Altium export copies them verbatim: -393.7 becomes a manual
  // -3937 mil paste opening (its way of saying "paste comes from the layer-5
  // regions, not from the pad"), 0.2 becomes a manual 2 mil mask opening.
  // Keeping them makes the generated PcbLib match the exported PcbDoc.
  const pasteExpansion = mm(num(fields[17]));
  const solderExpansion = mm(num(fields[18]));
  return {
    number: String(fields[8] ?? ""),
    x: mm(num(fields[2]) - ox),
    y: mm(-(num(fields[3]) - oy)),
    w: mm(num(fields[4])),
    h: mm(num(fields[5])),
    shape: PAD_SHAPE[String(fields[1] ?? "").toUpperCase()] || "rect",
    layer: PAD_LAYER[layerId] || "top",
    hole: round4(holeRadius * 2 * MM_PER_UNIT),
    rotation: round4(rotation),
    pasteExpansion: round4(pasteExpansion),
    solderExpansion: round4(solderExpansion),
    // A drilled through-hole pad is plated; a bare HOLE record becomes an NPTH pad.
    plated: true,
  };
}

function parseTrackSegments(record, ox, oy) {
  // TRACK~stroke_width~layer~net~x1 y1 x2 y2 …~id~locked
  const fields = record.split("~");
  const layer = GRAPHIC_LAYER[Math.round(num(fields[2], 3))];
  if (!layer) return [];
  const width = mm(num(fields[1]));
  const points = pairs(fields[4]).map(([x, y]) => [mm(x - ox), mm(-(y - oy))]);
  const segments = [];
  for (let i = 1; i < points.length; i += 1) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    segments.push({ layer, x1, y1, x2, y2, width });
  }
  return segments;
}

function parseCircle(record, ox, oy) {
  // CIRCLE~cx~cy~r~stroke_width~layer~id~locked
  const fields = record.split("~");
  const layer = GRAPHIC_LAYER[Math.round(num(fields[5], 3))];
  if (!layer) return null;
  const radius = mm(num(fields[3]));
  if (radius <= 0) return null;
  return {
    layer,
    x: mm(num(fields[1]) - ox),
    y: mm(-(num(fields[2]) - oy)),
    r: radius,
    // A zero stroke width would make the circle invisible.
    width: mm(num(fields[4])) || 0.15,
  };
}

/**
 * SVG endpoint parameterisation in EasyEDA coordinates (y down). Returns null for
 * a degenerate arc. Radii are returned after SVG's out-of-range correction so the
 * caller draws what the file actually means.
 */
function svgArcParams(x1, y1, x2, y2, rxIn, ryIn, phiDeg, largeArc, sweep) {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (!(rx > 0) || !(ry > 0)) return null;
  if (Math.hypot(x2 - x1, y2 - y1) < 1e-9) return null;
  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }
  const sign = largeArc !== sweep ? 1 : -1;
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  if (!(denominator > 0)) return null;
  const coef = sign * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = coef * ((rx * y1p) / ry);
  const cyp = coef * ((-ry * x1p) / rx);
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = Math.atan2(uy, ux);
  let dtheta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  return { cx, cy, theta1, dtheta, rx, ry, phi };
}

const ARC_SAMPLE_DEG = 10;

/**
 * Walk an SVG path ("M x y A rx ry rot large sweep x y …", with L segments too).
 * Circular arcs become {x,y,r,start,end} objects; elliptical arcs are sampled into
 * polylines (the DelphiScript arc object has one radius per object). The caller
 * supplies the coordinate/radius conversion, so this is shared by the PCB silk
 * `ARC` records and the schematic `A` records.
 */
function svgPathToShapes(path, toModel, radiusToModel, sampleDeg = ARC_SAMPLE_DEG) {
  const tokens = String(path || "").match(/[A-Za-z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  const arcs = [];
  const polylines = [];
  let cur = null;
  let line = null;
  const flush = () => {
    if (line && line.length >= 2) polylines.push(line);
    line = null;
  };
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "M" || token === "m") {
      flush();
      const relative = token === "m";
      cur = [
        num(tokens[i + 1]) + (relative && cur ? cur[0] : 0),
        num(tokens[i + 2]) + (relative && cur ? cur[1] : 0),
      ];
      i += 3;
    } else if (token === "L" || token === "l") {
      const relative = token === "l";
      const x = num(tokens[i + 1]) + (relative && cur ? cur[0] : 0);
      const y = num(tokens[i + 2]) + (relative && cur ? cur[1] : 0);
      if (cur) {
        if (!line) line = [toModel(cur[0], cur[1])];
        line.push(toModel(x, y));
      }
      cur = [x, y];
      i += 3;
    } else if (token === "A" || token === "a") {
      const relative = token === "a";
      const rx = num(tokens[i + 1]);
      const ry = num(tokens[i + 2]);
      const rotation = num(tokens[i + 3]);
      const largeArc = num(tokens[i + 4]) ? 1 : 0;
      const sweep = num(tokens[i + 5]) ? 1 : 0;
      const x = num(tokens[i + 6]) + (relative && cur ? cur[0] : 0);
      const y = num(tokens[i + 7]) + (relative && cur ? cur[1] : 0);
      const params = cur ? svgArcParams(cur[0], cur[1], x, y, rx, ry, rotation, largeArc, sweep) : null;
      if (params) {
        const circular = Math.abs(params.rx - params.ry) <= Math.max(params.rx, params.ry) * 1e-6;
        if (circular) {
          flush();
          const [x1, y1] = toModel(cur[0], cur[1]);
          const [x2, y2] = toModel(x, y);
          const [cx, cy] = toModel(params.cx, params.cy);
          const angle = (px, py) => {
            const deg = (Math.atan2(py - cy, px - cx) * 180) / Math.PI;
            return round4((deg % 360 + 360) % 360);
          };
          let start;
          let end;
          if (Math.abs(params.dtheta) >= Math.PI * 2 - 1e-6) {
            start = 0;
            end = 360;
          } else if (params.dtheta > 0) {
            // EasyEDA angles grow by -y in the mirrored (y-up) model, so the same
            // arc is traversed the other way round by Altium's CCW start/end.
            start = angle(x2, y2);
            end = angle(x1, y1);
          } else {
            start = angle(x1, y1);
            end = angle(x2, y2);
          }
          arcs.push({ x: cx, y: cy, r: radiusToModel(params.rx), start, end });
        } else {
          if (!line) line = [toModel(cur[0], cur[1])];
          const steps = Math.max(8, Math.ceil((Math.abs(params.dtheta) * 180) / Math.PI / sampleDeg));
          for (let k = 1; k <= steps; k += 1) {
            const theta = params.theta1 + (params.dtheta * k) / steps;
            const sx = params.cx + params.rx * Math.cos(theta) * Math.cos(params.phi)
              - params.ry * Math.sin(theta) * Math.sin(params.phi);
            const sy = params.cy + params.rx * Math.cos(theta) * Math.sin(params.phi)
              + params.ry * Math.sin(theta) * Math.cos(params.phi);
            line.push(toModel(sx, sy));
          }
        }
      }
      cur = [x, y];
      i += 8;
    } else {
      i += 1;
    }
  }
  flush();
  return { arcs, polylines };
}

/**
 * PCB silk ARC records:
 *   ARC~stroke_width~layer~net~M x,y A rx,ry rot large sweep x2,y2~id~locked
 * Circular arcs become Arc objects; elliptical/sampled paths become tracks.
 */
function parseArcRecord(record, ox, oy) {
  const fields = record.split("~");
  const layer = GRAPHIC_LAYER[Math.round(num(fields[2], 3))];
  const arcs = [];
  const tracks = [];
  if (!layer) return { arcs, tracks };
  const width = mm(num(fields[1])) || 0.15;
  const toModel = (x, y) => [mm(x - ox), mm(-(y - oy))];
  const parsed = svgPathToShapes(fields[4], toModel, mm);
  for (const a of parsed.arcs) arcs.push({ layer, ...a, width });
  for (const line of parsed.polylines) {
    for (let i = 1; i < line.length; i += 1) {
      tracks.push({
        layer,
        x1: line[i - 1][0], y1: line[i - 1][1],
        x2: line[i][0], y2: line[i][1],
        width,
      });
    }
  }
  return { arcs, tracks };
}

/**
 * RECT records (outline rectangles on silk): RECT~x~y~w~h~layer~id~locked~?~fillstyle.
 * Emitted as four tracks so the document writer and the library emitter share one
 * primitive set (the script API rectangle fill is not verified on this build).
 */
function parseRectRecord(record, ox, oy) {
  const fields = record.split("~");
  const layer = GRAPHIC_LAYER[Math.round(num(fields[5], 3))];
  if (!layer) return [];
  const x = num(fields[1]);
  const y = num(fields[2]);
  const w = num(fields[3]);
  const h = num(fields[4]);
  if (!(w > 0) || !(h > 0)) return [];
  const corners = [
    [mm(x - ox), mm(-(y - oy))],
    [mm(x + w - ox), mm(-(y - oy))],
    [mm(x + w - ox), mm(-(y + h - oy))],
    [mm(x - ox), mm(-(y + h - oy))],
  ];
  const tracks = [];
  for (let i = 0; i < 4; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    tracks.push({ layer, x1: a[0], y1: a[1], x2: b[0], y2: b[1], width: RECT_WIDTH_MM });
  }
  return tracks;
}

/** HOLE records are non-plated mechanical holes: HOLE~cx~cy~radius~id~locked. */
function parseHoleRecord(record, ox, oy) {
  const fields = record.split("~");
  const radius = num(fields[3]);
  if (!(radius > 0)) return null;
  const diameter = round4(radius * 2 * MM_PER_UNIT);
  return {
    number: "",
    x: mm(num(fields[1]) - ox),
    y: mm(-(num(fields[2]) - oy)),
    w: diameter,
    h: diameter,
    shape: "round",
    layer: "multi",
    hole: diameter,
    rotation: 0,
    plated: false,
  };
}

/**
 * SOLIDREGION~layer~net~path~type~id~~locked
 * A polygon on one of the footprint layers. `type` is "solid" (filled), "cutout"
 * (negative area) or "npth" (mechanical hole outline). The model keeps `kind` so
 * the emitter can fill solids and outline cutout/npth shapes.
 */
function parseSolidRegion(record, ox, oy) {
  const fields = record.split("~");
  const layer = GRAPHIC_LAYER[Math.round(num(fields[1]))];
  if (!layer) return null;
  const kind = String(fields[4] || "solid").trim().toLowerCase();
  const contours = pathContours(fields[3]);
  if (contours.length === 0) return null;
  const toModel = ([x, y]) => [mm(x - ox), mm(-(y - oy))];
  return {
    layer,
    kind,
    points: contours[0].map(toModel),
    // Additional sub-paths are holes. DelphiScript has no verified void-contour
    // authoring call, so the emitter draws their boundary as closed tracks.
    holes: contours.slice(1).map((contour) => contour.map(toModel)),
  };
}

function parseFootprintDoc(doc) {
  const [ox, oy] = anchorOf(doc);
  const pads = [];
  const tracks = [];
  const circles = [];
  const arcs = [];
  const regions = [];
  for (const record of shapeRecords(doc)) {
    if (record.startsWith("PAD~")) {
      const pad = parsePad(record, ox, oy);
      if (pad) pads.push(pad);
      continue;
    }
    const type = record.split("~")[0];
    if (type === "TRACK") tracks.push(...parseTrackSegments(record, ox, oy));
    else if (type === "CIRCLE") {
      const circle = parseCircle(record, ox, oy);
      if (circle) circles.push(circle);
    } else if (type === "ARC") {
      const parsed = parseArcRecord(record, ox, oy);
      arcs.push(...parsed.arcs);
      tracks.push(...parsed.tracks);
    } else if (type === "RECT") {
      tracks.push(...parseRectRecord(record, ox, oy));
    } else if (type === "HOLE") {
      const hole = parseHoleRecord(record, ox, oy);
      if (hole) pads.push(hole);
    } else if (type === "SOLIDREGION") {
      const region = parseSolidRegion(record, ox, oy);
      if (region) regions.push(region);
    }
    // SVGNODE is the 3D placeholder -> ignored on purpose.
  }
  return { pads, tracks, circles, arcs, regions };
}

function docOf(node) {
  const doc = node && typeof node === "object" ? node.dataStr : null;
  return doc && typeof doc === "object" ? doc : null;
}

/** A document without a docType is sniffed: PAD records and no P records means footprint. */
function docTypeOf(doc) {
  const declared = doc?.head?.docType;
  if (declared !== undefined && declared !== null && String(declared) !== "") return String(declared);
  const records = shapeRecords(doc);
  const hasPad = records.some((record) => record.startsWith("PAD~"));
  const hasPin = records.some((record) => record.startsWith("P~"));
  return hasPad && !hasPin ? "4" : "";
}

function splitDocs(result) {
  const unitDocs = [];
  let footprintDoc = docOf(result.packageDetail);
  const candidates = [docOf(result)];
  if (Array.isArray(result.subparts)) {
    for (const subpart of result.subparts) candidates.push(docOf(subpart));
  }
  for (const doc of candidates) {
    if (!doc) continue;
    if (docTypeOf(doc) === "4") {
      // some products ship the footprint as the primary document
      if (!footprintDoc) footprintDoc = doc;
      continue;
    }
    unitDocs.push(doc);
  }
  return { unitDocs, footprintDoc };
}

function firstCpara(docs) {
  for (const doc of docs) {
    const cpara = doc?.head?.c_para;
    if (cpara && typeof cpara === "object" && Object.keys(cpara).length > 0) return cpara;
  }
  return {};
}

function tierPrice(price) {
  if (Array.isArray(price)) {
    for (const tier of price) {
      if (!Array.isArray(tier) || tier.length < 2) continue;
      const value = Number.parseFloat(tier[1]);
      if (Number.isFinite(value)) return round4(value);
    }
    return 0;
  }
  if (price && typeof price === "object") {
    const value = Number.parseFloat(price.price ?? price.value);
    if (Number.isFinite(value)) return round4(value);
  }
  return 0;
}

/**
 * Normalise an /api/products/{LCSC}/components body into a CONTRACT §1 ComponentModel.
 * @param {unknown} raw parsed API envelope ({"success":…,"result":…})
 * @param {string} [lcscHint] used when the payload carries no LCSC number
 */
export function buildComponentModel(raw, lcscHint = "") {
  const result = raw && typeof raw === "object" ? raw.result : null;
  if (!result || typeof result !== "object") {
    throw new Error(`payload has no result (${lcscHint || "unknown part"})`);
  }
  const { unitDocs, footprintDoc } = splitDocs(result);
  const pins = [];
  const shapes = [];
  for (const doc of unitDocs) {
    const parsed = parseSymbolDoc(doc);
    pins.push(...parsed.pins);
    shapes.push(...parsed.shapes);
  }
  const footprint = parseFootprintDoc(footprintDoc);
  const cpara = firstCpara([...unitDocs, footprintDoc]);
  const lcsc = String(result.lcsc?.number || cpara["Supplier Part"] || lcscHint || "").trim();
  return {
    lcsc,
    mpn: String(cpara["Manufacturer Part"] || result.title || ""),
    manufacturer: String(cpara.Manufacturer || ""),
    package: String(cpara.package || result.packageDetail?.title || ""),
    // EasyEDA's component description (C25804: "10KΩ (1002) ±1%"; some parts return "").
    description: String(cpara.Description || result.description || "").trim(),
    // EasyEDA's Value field, e.g. C25804: "10kΩ". Many ICs have no Value.
    value: String(cpara.Value || cpara.value || "").trim(),
    // No trustworthy datasheet field in the public API (head.c_para.link is often a package
    // drawing or a sibling part's PDF) -> deliberately empty.
    datasheet: "",
    symbol: { pins, shapes, texts: [] },
    footprint,
  };
}

/**
 * Normalise an /api/eda/product/search body into CONTRACT §2 candidates.
 * price = the first (smallest-quantity) tier's unit price as a number.
 */
export function mapSearchResults(raw, limit = 20) {
  const list = raw && typeof raw === "object" ? raw.result?.productList : null;
  if (!Array.isArray(list)) return [];
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 20;
  return list
    .slice(0, max)
    .map((item) => ({
      lcsc: String(item?.number ?? ""),
      mpn: String(item?.mpn ?? ""),
      manufacturer: String(item?.manufacturer ?? ""),
      package: String(item?.package ?? ""),
      description: String(item?.description ?? ""),
      stock: Math.max(0, Math.round(num(item?.stock))),
      price: tierPrice(item?.price),
    }))
    .filter((candidate) => candidate.lcsc !== "");
}
