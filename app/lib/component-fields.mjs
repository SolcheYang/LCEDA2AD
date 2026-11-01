// component-fields.mjs - the four user-visible SchLib component fields:
// Description, Designator, Comment and Design Item ID.
//
// The EasyEDA model only carries a description and a designator prefix, so the
// other defaults are derived here. One module owns the defaults so the preview
// API, the SchDoc writer, the SchLib emitter and the pipeline always agree:
// whatever the UI previews is exactly what the generated library receives.
//
// Optional overrides live on the ComponentModel itself (undefined = use the
// derived default):
//   model.description   string  (EasyEDA description; overridable)
//   model.designator    string  full designator text, e.g. "R??"
//   model.comment       string  Comment text
//   model.designItemId  string  Design Item ID / library reference
//
// An empty designator / designItemId falls back to the default (an empty
// component name is never useful). An empty comment or description is kept:
// the user may deliberately want no text there.

export const FIELD_KEYS = ['description', 'designator', 'comment', 'designItemId'];

const asText = (value) => String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();

/** LCEDA reference prefix (head.c_para.pre, e.g. "R?") -> "R"; U when absent. */
export function designatorPrefix(model) {
  const letters = String((model && model.designatorPrefix) || '')
    .toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  return letters || 'U';
}

/**
 * The four values written to the SchLib (and shown in the preview editor).
 * @param {object} model ComponentModel, optionally carrying field overrides
 * @returns {{description: string, designator: string, comment: string, designItemId: string}}
 */
export function schlibFields(model) {
  const m = model && typeof model === 'object' ? model : {};
  const lcsc = asText(m.lcsc);
  const fallbackName = asText(m.mpn) || lcsc;
  const designatorOverride = asText(m.designator);
  const designItemIdOverride = asText(m.designItemId);
  return {
    description: typeof m.description === 'string' ? asText(m.description) : '',
    designator: designatorOverride || designatorPrefix(m) + '??',
    comment: typeof m.comment === 'string' ? asText(m.comment) : fallbackName,
    designItemId: designItemIdOverride || fallbackName || lcsc,
  };
}

/**
 * Validate field overrides coming from the HTTP body / pipeline env.
 * Unknown keys are dropped and everything is coerced to a single-line string.
 * @returns {object|null} null when there is nothing to override
 */
export function sanitizeFieldOverrides(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const key of FIELD_KEYS) {
    if (typeof raw[key] !== 'string') continue;
    const max = key === 'description' ? 4000 : 200;
    out[key] = raw[key].replace(/[\r\n]+/g, ' ').slice(0, max);
  }
  return Object.keys(out).length ? out : null;
}

/** Apply validated overrides to a copy of the model (never mutates the input). */
export function withFieldOverrides(model, overrides) {
  if (!overrides) return model;
  return { ...model, ...overrides };
}

export default { FIELD_KEYS, designatorPrefix, schlibFields, sanitizeFieldOverrides, withFieldOverrides };
