// CONTRACT §1 ComponentModel -> 预览 SVG（无依赖、纯函数）。
// 服务端把模型渲染成 <svg> 字符串，页面直接内嵌；页面上再叠缩放/高亮等交互。
//
// 单位：符号是 mil、封装是 mm，模型里都是 y 向上；SVG 是 y 向下，所以每次落点都取反。
// 符号的线宽用 vector-effect="non-scaling-stroke"（屏幕 1.4px），
// 封装的线宽是真实尺寸（mm），随图形一起缩放，和 Altium 里看到的一致。

const SYMBOL_STROKE = 1.4;
const SYMBOL_COLOR = '#334155';   // 器件图形
const PIN_COLOR = '#0f172a';      // 引脚
const PIN_TEXT = '#64748b';       // 引脚号 / 名称

const PAD_FILL = { top: '#fcd34d', bottom: '#bfdbfe', multi: '#fcd34d' };
const PAD_STROKE = { top: '#b45309', bottom: '#1d4ed8', multi: '#b45309' };
const LAYER_STROKE = {
  top: '#b45309',
  bottom: '#1d4ed8',
  multi: '#b45309',
  top_overlay: '#64748b',
  bottom_overlay: '#94a3b8',
  top_paste: '#d97706',
  bottom_paste: '#60a5fa',
  top_solder: '#f87171',
  bottom_solder: '#fca5a5',
  board_outline: '#334155',
  document: '#e5e7eb',
  top_assembly: '#cbd5e1',
  bottom_assembly: '#e2e8f0',
  mechanical: '#cbd5e1',
  component_shape: '#94a3b8',
  lead_shape: '#94a3b8',
  component_marking: '#94a3b8',
};

function fmt(value) {
  const n = Math.round(Number(value) * 1000) / 1000;
  if (!Number.isFinite(n)) return '0';
  return Object.is(n, -0) ? '0' : String(n);
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function bounds() {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  b.add = (x, y) => {
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    if (px < b.minX) b.minX = px;
    if (px > b.maxX) b.maxX = px;
    if (py < b.minY) b.minY = py;
    if (py > b.maxY) b.maxY = py;
  };
  b.addAll = (points) => {
    for (const point of points || []) {
      if (Array.isArray(point)) b.add(point[0], point[1]);
    }
  };
  b.valid = () => Number.isFinite(b.minX) && Number.isFinite(b.maxX);
  return b;
}

/** 计算 viewBox：留 7% 边距，最窄方向至少 minExtent，避免一条线把画布压成 0 宽。 */
function viewport(b, minExtent) {
  const w = Math.max(b.maxX - b.minX, minExtent);
  const h = Math.max(b.maxY - b.minY, minExtent);
  const pad = Math.max(w, h) * 0.07;
  return {
    x: b.minX - pad,
    y: -b.maxY - pad,
    w: w + pad * 2,
    h: h + pad * 2,
    extent: Math.max(w, h),
  };
}

function svgOpen(vp, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(vp.x)} ${fmt(vp.y)} ${fmt(vp.w)} ${fmt(vp.h)}"`
    + ` preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(title)}">`
    + `<title>${esc(title)}</title>`;
}

/** 圆弧（中心 x,y、半径 r、角度 start→end，模型里逆时针为正）采样成折线点。 */
function arcPoints(arc, stepDeg = 10) {
  const cx = Number(arc.x) || 0;
  const cy = Number(arc.y) || 0;
  const r = Math.abs(Number(arc.r) || 0);
  if (!(r > 0)) return [];
  let start = Number(arc.start) || 0;
  let end = Number(arc.end) || 0;
  while (end < start) end += 360;
  const span = Math.min(Math.max(end - start, 0), 360);
  const steps = Math.max(4, Math.ceil(span / stepDeg));
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = ((start + (span * i) / steps) * Math.PI) / 180;
    points.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  return points;
}

function pointsAttr(points) {
  return points.map(([x, y]) => fmt(x) + ',' + fmt(-y)).join(' ');
}

/* ───────────────────────────── 符号（SchLib） ───────────────────────────── */

function symbolShapeSvg(shape) {
  const common = `fill="none" stroke="${SYMBOL_COLOR}" stroke-width="${SYMBOL_STROKE}" vector-effect="non-scaling-stroke"`;
  switch (shape.kind) {
    case 'rect': {
      const x = Math.min(shape.x1, shape.x2);
      const y = Math.min(shape.y1, shape.y2);
      const w = Math.abs(shape.x2 - shape.x1);
      const h = Math.abs(shape.y2 - shape.y1);
      return `<rect x="${fmt(x)}" y="${fmt(-(y + h))}" width="${fmt(w)}" height="${fmt(h)}" ${common}/>`;
    }
    case 'ellipse':
      return `<ellipse cx="${fmt(shape.x)}" cy="${fmt(-shape.y)}" rx="${fmt(Math.abs(shape.rx))}"`
        + ` ry="${fmt(Math.abs(shape.ry))}" ${common}/>`;
    case 'polyline': {
      const points = pointsAttr(shape.points || []);
      return points ? `<polyline points="${points}" ${common}/>` : '';
    }
    case 'polygon': {
      const points = pointsAttr(shape.points || []);
      return points
        ? `<polygon points="${points}" fill="rgba(148,163,184,0.18)" stroke="${SYMBOL_COLOR}"`
          + ` stroke-width="${SYMBOL_STROKE}" vector-effect="non-scaling-stroke"/>`
        : '';
    }
    case 'arc': {
      const points = pointsAttr(arcPoints(shape));
      return points ? `<polyline points="${points}" ${common}/>` : '';
    }
    default:
      return '';
  }
}

/**
 * @param {object} model CONTRACT §1 ComponentModel
 * @returns {string} SVG 字符串；模型没有符号数据时返回 ''
 */
export function renderSymbolSvg(model) {
  const sym = model && typeof model === 'object' && model.symbol ? model.symbol : {};
  const pins = Array.isArray(sym.pins) ? sym.pins : [];
  const shapes = Array.isArray(sym.shapes) ? sym.shapes : [];
  if (pins.length === 0 && shapes.length === 0) return '';

  const b = bounds();
  for (const shape of shapes) {
    if (!shape || typeof shape !== 'object') continue;
    if (shape.kind === 'rect') {
      b.add(shape.x1, shape.y1);
      b.add(shape.x2, shape.y2);
    } else if (shape.kind === 'ellipse') {
      b.add(Number(shape.x) - Math.abs(Number(shape.rx) || 0), Number(shape.y) - Math.abs(Number(shape.ry) || 0));
      b.add(Number(shape.x) + Math.abs(Number(shape.rx) || 0), Number(shape.y) + Math.abs(Number(shape.ry) || 0));
    } else if (shape.kind === 'polyline' || shape.kind === 'polygon') {
      b.addAll(shape.points);
    } else if (shape.kind === 'arc') {
      b.addAll(arcPoints(shape));
    }
  }

  // 引脚：模型里的 (x,y) 是电气端点，orient 指向器件本体，所以本体端 = 端点 + 长度×方向。
  const pinLines = [];
  for (const pin of pins) {
    if (!pin || typeof pin !== 'object') continue;
    const length = Math.abs(Number(pin.length) || 0);
    const rad = ((Number(pin.orient) || 0) * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const tipX = Number(pin.x) || 0;
    const tipY = Number(pin.y) || 0;
    const endX = tipX + dx * length;
    const endY = tipY + dy * length;
    b.add(tipX, tipY);
    b.add(endX, endY);
    pinLines.push({ pin, tipX, tipY, endX, endY, dx, dy, length });
  }
  if (!b.valid()) return '';

  const vp = viewport(b, 20);
  const fs = vp.extent / 26;
  const showNames = pins.some((pin) => pin && pin.name && pin.name !== pin.number && pin.name !== '~');
  const parts = [];

  for (const shape of shapes) {
    const svg = symbolShapeSvg(shape);
    if (svg) parts.push(svg);
  }

  for (const line of pinLines) {
    const { pin, tipX, tipY, endX, endY, dx, dy, length } = line;
    parts.push(`<line x1="${fmt(tipX)}" y1="${fmt(-tipY)}" x2="${fmt(endX)}" y2="${fmt(-endY)}"`
      + ` stroke="${PIN_COLOR}" stroke-width="${SYMBOL_STROKE}" vector-effect="non-scaling-stroke"/>`);

    // 引脚号：放在引脚中点、朝引脚的一侧偏一点，避免压线。
    const midX = (tipX + endX) / 2;
    const midY = (tipY + endY) / 2;
    let offX = -dy;
    let offY = dx;
    const vertical = Math.abs(dy) > Math.abs(dx);
    if (vertical ? offX < 0 : offY < 0) {
      offX = -offX;
      offY = -offY;
    }
    const numX = midX + offX * fs * 0.55;
    const numY = midY + offY * fs * 0.55;
    const number = String(pin.number == null ? '' : pin.number);
    if (number) {
      parts.push(`<text x="${fmt(numX)}" y="${fmt(-numY)}" font-size="${fmt(fs * 0.8)}"`
        + ` font-family="ui-monospace, Consolas, monospace" fill="${PIN_TEXT}"`
        + ` text-anchor="middle" dominant-baseline="middle">${esc(number)}</text>`);
    }

    // 引脚名：写在本体一侧（仅当它和引脚号不同才有意义）。
    if (showNames && pin.name && pin.name !== '~') {
      const nameX = endX + dx * fs * 0.45;
      const nameY = endY + dy * fs * 0.45;
      const anchor = vertical ? 'middle' : (dx > 0 ? 'start' : 'end');
      parts.push(`<text x="${fmt(nameX)}" y="${fmt(-nameY)}" font-size="${fmt(fs * 0.75)}"`
        + ` font-family="ui-monospace, Consolas, monospace" fill="${PIN_TEXT}"`
        + ` text-anchor="${anchor}" dominant-baseline="middle">${esc(pin.name)}</text>`);
    }
  }

  const label = ((model && model.lcsc) || '') + ' 符号';
  return svgOpen(vp, label) + parts.join('') + '</svg>';
}

/* ───────────────────────────── 封装（PcbLib） ───────────────────────────── */

function padSvg(pad) {
  const x = Number(pad.x) || 0;
  const y = Number(pad.y) || 0;
  const w = Math.abs(Number(pad.w) || 0);
  const h = Math.abs(Number(pad.h) || 0);
  if (!(w > 0) || !(h > 0)) return '';
  const layer = PAD_FILL[pad.layer] ? pad.layer : 'top';
  const fill = PAD_FILL[layer];
  const stroke = PAD_STROKE[layer];
  const rotation = -((Number(pad.rotation) || 0) % 360);
  const cx = x;
  const cy = -y;
  const transform = rotation ? ` transform="rotate(${fmt(rotation)} ${fmt(cx)} ${fmt(cy)})"` : '';
  let body;
  if (pad.shape === 'round') {
    body = Math.abs(w - h) < 1e-6
      ? `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(w / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="0.02"/>`
      : `<rect x="${fmt(cx - w / 2)}" y="${fmt(cy - h / 2)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(Math.min(w, h) / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="0.02"${transform}/>`;
  } else if (pad.shape === 'octagonal') {
    const cut = Math.min(w, h) * 0.2929;
    const points = [
      [-w / 2 + cut, -h / 2], [w / 2 - cut, -h / 2], [w / 2, -h / 2 + cut],
      [w / 2, h / 2 - cut], [w / 2 - cut, h / 2], [-w / 2 + cut, h / 2],
      [-w / 2, h / 2 - cut], [-w / 2, -h / 2 + cut],
    ].map(([px, py]) => fmt(cx + px) + ',' + fmt(cy + py)).join(' ');
    body = `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="0.02"${transform}/>`;
  } else {
    body = `<rect x="${fmt(cx - w / 2)}" y="${fmt(cy - h / 2)}" width="${fmt(w)}" height="${fmt(h)}" fill="${fill}" stroke="${stroke}" stroke-width="0.02"${transform}/>`;
  }

  const hole = Number(pad.hole) > 0
    ? `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(Number(pad.hole) / 2)}" fill="#ffffff" stroke="${stroke}" stroke-width="0.02"/>`
    : '';

  const number = String(pad.number == null ? '' : pad.number);
  const numFs = Math.min(w, h) * 0.5;
  const fits = number && numFs > 0.02 && number.length * numFs * 0.62 <= w * 1.05;
  const text = fits
    ? `<text x="${fmt(cx)}" y="${fmt(cy)}" font-size="${fmt(numFs)}" font-family="ui-monospace, Consolas, monospace"`
      + ` fill="#7c2d12" text-anchor="middle" dominant-baseline="middle">${esc(number)}</text>`
    : '';
  return body + hole + text;
}

/**
 * @param {object} model CONTRACT §1 ComponentModel
 * @returns {string} SVG 字符串；模型没有封装数据时返回 ''
 */
export function renderFootprintSvg(model) {
  const fp = model && typeof model === 'object' && model.footprint ? model.footprint : {};
  const pads = Array.isArray(fp.pads) ? fp.pads : [];
  const tracks = Array.isArray(fp.tracks) ? fp.tracks : [];
  const circles = Array.isArray(fp.circles) ? fp.circles : [];
  const arcs = Array.isArray(fp.arcs) ? fp.arcs : [];
  const regions = Array.isArray(fp.regions) ? fp.regions : [];
  if (!pads.length && !tracks.length && !circles.length && !arcs.length && !regions.length) return '';

  const b = bounds();
  for (const pad of pads) {
    if (!pad || typeof pad !== 'object') continue;
    const r = Math.hypot(Number(pad.w) || 0, Number(pad.h) || 0) / 2;
    b.add(Number(pad.x) - r, Number(pad.y) - r);
    b.add(Number(pad.x) + r, Number(pad.y) + r);
  }
  for (const t of tracks) {
    if (!t || typeof t !== 'object') continue;
    b.add(t.x1, t.y1);
    b.add(t.x2, t.y2);
  }
  for (const c of circles) {
    if (!c || typeof c !== 'object') continue;
    const r = Math.abs(Number(c.r) || 0);
    b.add(Number(c.x) - r, Number(c.y) - r);
    b.add(Number(c.x) + r, Number(c.y) + r);
  }
  for (const a of arcs) b.addAll(arcPoints(a));
  for (const region of regions) {
    if (!region || typeof region !== 'object') continue;
    b.addAll(region.points);
    for (const holePoints of region.holes || []) b.addAll(holePoints);
  }
  if (!b.valid()) return '';

  const vp = viewport(b, 0.5);
  const stroke = (layer) => LAYER_STROKE[layer] || '#94a3b8';
  const parts = [];

  // 先铺区域（大块铜/本体），再画线，最后画焊盘压在最上层。
  for (const region of regions) {
    if (!region || !Array.isArray(region.points) || region.points.length < 3) continue;
    const color = stroke(region.layer);
    const fill = region.kind === 'solid' ? 'rgba(148,163,184,0.16)' : 'none';
    parts.push(`<polygon points="${pointsAttr(region.points)}" fill="${fill}" stroke="${color}" stroke-width="0.05"/>`);
    for (const holePoints of region.holes || []) {
      if (holePoints.length < 3) continue;
      parts.push(`<polygon points="${pointsAttr(holePoints)}" fill="#fbfcfd" stroke="${color}" stroke-width="0.05"/>`);
    }
  }
  for (const t of tracks) {
    if (!t || typeof t !== 'object') continue;
    const width = Math.max(Number(t.width) || 0, 0.03);
    parts.push(`<line x1="${fmt(t.x1)}" y1="${fmt(-t.y1)}" x2="${fmt(t.x2)}" y2="${fmt(-t.y2)}"`
      + ` stroke="${stroke(t.layer)}" stroke-width="${fmt(width)}" stroke-linecap="round"/>`);
  }
  for (const c of circles) {
    if (!c || typeof c !== 'object') continue;
    const r = Math.abs(Number(c.r) || 0);
    if (!(r > 0)) continue;
    const width = Math.max(Number(c.width) || 0, 0.03);
    parts.push(`<circle cx="${fmt(c.x)}" cy="${fmt(-c.y)}" r="${fmt(r)}" fill="none"`
      + ` stroke="${stroke(c.layer)}" stroke-width="${fmt(width)}"/>`);
  }
  for (const a of arcs) {
    const points = pointsAttr(arcPoints(a));
    if (!points) continue;
    const width = Math.max(Number(a.width) || 0, 0.03);
    parts.push(`<polyline points="${points}" fill="none" stroke="${stroke(a.layer)}" stroke-width="${fmt(width)}" stroke-linecap="round"/>`);
  }
  for (const pad of pads) {
    if (!pad || typeof pad !== 'object') continue;
    const svg = padSvg(pad);
    if (svg) parts.push(svg);
  }

  const label = ((model && model.lcsc) || '') + ' 封装';
  return svgOpen(vp, label) + parts.join('') + '</svg>';
}
