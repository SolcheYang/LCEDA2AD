// library-scan.mjs - byte-level reads of Altium SchLib/PcbLib files.
//
// SchDoc/PcbLib/SchLib are OLE compound documents, but component names are
// stored as plain text in the file (ANSI, GBK or UTF-16), and a SchLib header
// carries its complete component list (`CompCount=n|LibRef0=...|LibRef1=...`).
// The server uses these scans to warn about duplicates before a build; the
// pipeline uses the same helpers to decide whether a target library can be
// safely replaced. Keeping one implementation makes both agree.
import fs from 'node:fs';
import iconv from 'iconv-lite';

/** Altium's blank placeholder in a fresh SchLib; it carries no geometry. */
export const BLANK_SCH_COMPONENT = /^Component_\d+$/i;

/** Byte scan for a name; libraries may store ANSI, GBK or UTF-16. */
export function bufferHasText(buf, text) {
  const value = String(text == null ? '' : text);
  if (!value) return false;
  const needles = [Buffer.from(value, 'latin1'), Buffer.from(value, 'utf16le')];
  try { needles.push(iconv.encode(value, 'gbk')); } catch { /* not GBK-encodable: ignore */ }
  return needles.some((needle) => needle.length > 0 && buf.includes(needle));
}

/** The subset of candidates whose bytes appear in the file. */
export function namesPresent(file, candidates) {
  if (!fs.existsSync(file)) return [];
  const buf = fs.readFileSync(file);
  return candidates.filter((n) => n && bufferHasText(buf, n));
}

/**
 * Every component name stored in a SchLib, read from the ASCII header
 * (`CompCount=n|LibRef0=...`). The scripting API cannot enumerate SchLib
 * components, so this header scan is the only complete list; it is what keeps
 * the "sole-component rebuild" from deleting a component the registry forgot.
 */
export function schLibComponentNames(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const text = fs.readFileSync(file).toString('latin1');
    const names = [];
    // Non-ASCII names are stored as %UTF8%LibRefN=..., everything else as LibRefN=.
    const re = /(^|\||%)(LibRef\d+=)([^|]*)/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      let name = match[3];
      if (match[1] === '%') {
        try { name = Buffer.from(name, 'latin1').toString('utf8'); } catch { /* keep raw */ }
      }
      name = name.trim();
      if (name) names.push(name);
    }
    return Array.from(new Set(names));
  } catch {
    return [];
  }
}

export default { BLANK_SCH_COMPONENT, bufferHasText, namesPresent, schLibComponentNames };
