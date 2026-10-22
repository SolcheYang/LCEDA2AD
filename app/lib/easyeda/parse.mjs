// EasyEDA payload -> CONTRACT.md §1 normalisation.
// Units: 1 EasyEDA unit = 0.254 mm = 10 mil (proven in _probe/spec.md §3).
// EasyEDA y grows DOWN, the model is y-UP, so every y is negated after subtracting the document anchor.

export const MM_PER_UNIT = 0.254;
export const MIL_PER_UNIT = 10;

const ELECTRICAL = { 0: "unspecified", 1: "passive", 2: "output", 4: "power" };
const PAD_SHAPE = { RECT: "rect", OVAL: "round", ELLIPSE: "round", POLYGON: "octagonal" };
const PAD_LAYER = { 1: "top", 2: "bottom", 11: "multi" };
// layer 3 = top silk, layer 4 = bottom silk (CONTRACT has no bottom overlay -> "bottom"),
// 1 = top copper, 2 = bottom copper. Mask/paste/generated layers (5,7,12,99,100,101) are skipped.
const GRAPHIC_LAYER = { 1: "top", 2: "bottom", 3: "top_overlay", 4: "bottom" };

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
    default:
      // "A" (arc) and "T" (text) were never observed in any probed part; skip instead of guessing.
      return null;
  }
}

function parseSymbolDoc(doc) {
  const [ox, oy] = anchorOf(doc);
  const pins = [];
  const shapes = [];
  for (const record of shapeRecords(doc)) {
    if (record.startsWith("P~")) {
      const pin = parsePin(record, ox, oy);
      if (pin) pins.push(pin);
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
  return {
    number: String(fields[8] ?? ""),
    x: mm(num(fields[2]) - ox),
    y: mm(-(num(fields[3]) - oy)),
    w: mm(num(fields[4])),
    h: mm(num(fields[5])),
    shape: PAD_SHAPE[String(fields[1] ?? "").toUpperCase()] || "rect",
    layer: PAD_LAYER[layerId] || "top",
    hole: round4(holeRadius * 2 * MM_PER_UNIT),
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
    width: mm(num(fields[4])),
  };
}

function parseFootprintDoc(doc) {
  const [ox, oy] = anchorOf(doc);
  const pads = [];
  const tracks = [];
  const circles = [];
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
    }
    // ARC / SOLIDREGION / SVGNODE: CONTRACT §1 has no field for them (regions 99/100/101 are
    // generated decoration, SVGNODE is the 3D placeholder) -> ignored on purpose.
  }
  return { pads, tracks, circles };
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
