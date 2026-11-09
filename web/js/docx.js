/* Word (.docx) → draft: text, formatting overlay (sizes, colours → pens, alignment, first-line indent, headings),
 * page format, and Word equations (OMML) → \( LaTeX \). Images are not imported (reported as warnings). */
(function (root) {
  'use strict';
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
  const PT_MM = 25.4 / 72, TWIP_MM = 25.4 / 1440;

  // --- ZIP (stored / deflate) with the platform's DecompressionStream ---
  async function unzip(buffer) {
    const bytes = new Uint8Array(buffer), view = new DataView(buffer);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) throw Error('不是有效的 .docx（ZIP 结构损坏）');
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true);
    const files = new Map();
    for (let n = 0; n < count; n++) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw Error('.docx 目录损坏');
      const method = view.getUint16(offset + 10, true), size = view.getUint32(offset + 20, true);
      const nameLength = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
      const local = view.getUint32(offset + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      files.set(name, { method, size, local });
      offset += 46 + nameLength + extra + comment;
    }
    return async (name) => {
      const entry = files.get(name);
      if (!entry) return null;
      const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
      const data = bytes.subarray(start, start + entry.size);
      if (entry.method === 0) return new TextDecoder().decode(data);
      if (entry.method !== 8) throw Error('不支持的 .docx 压缩方式');
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new TextDecoder().decode(await new Response(stream).arrayBuffer());
    };
  }

  const children = (node, ns, name) => [...(node?.childNodes || [])].filter((child) => child.namespaceURI === ns && (!name || child.localName === name));
  const child = (node, ns, name) => children(node, ns, name)[0] || null;
  const attr = (node, name) => node?.getAttributeNS(W, name) ?? node?.getAttribute?.(`w:${name}`) ?? null;
  const mattr = (node, name) => node?.getAttributeNS(M, name) ?? node?.getAttribute?.(`m:${name}`) ?? null;

  // --- OMML → LaTeX ---
  const NARY = { '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∮': '\\oint', '∬': '\\iint' };
  const SPECIAL = { '{': '\\{', '}': '\\}', '\\': '\\backslash ', '^': '\\^{}', '_': '\\_', '%': '\\%', '#': '\\#', '&': '\\&', '$': '\\$' };
  function omml(node) {
    if (!node) return '';
    const all = () => [...node.childNodes].map(omml).join('');
    const arg = (name) => omml(child(node, M, name));
    if (node.nodeType === 3) return '';
    if (node.namespaceURI !== M) return node.namespaceURI === W && node.localName === 't' ? node.textContent : '';
    switch (node.localName) {
      case 'r': return children(node, M, 't').map((t) => [...t.textContent].map((c) => SPECIAL[c] ?? c).join('')).join('');
      case 'f': return `\\frac{${arg('num')}}{${arg('den')}}`;
      case 'rad': { const degree = arg('deg'); return degree ? `\\sqrt[${degree}]{${arg('e')}}` : `\\sqrt{${arg('e')}}`; }
      case 'sSup': return `{${arg('e')}}^{${arg('sup')}}`;
      case 'sSub': return `{${arg('e')}}_{${arg('sub')}}`;
      case 'sSubSup': return `{${arg('e')}}_{${arg('sub')}}^{${arg('sup')}}`;
      case 'nary': {
        const symbol = mattr(child(child(node, M, 'naryPr'), M, 'chr'), 'val') || '∫';
        const sub = arg('sub'), sup = arg('sup');
        return `${NARY[symbol] || symbol}${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''} ${arg('e')}`;
      }
      case 'd': {
        const props = child(node, M, 'dPr');
        const open = mattr(child(props, M, 'begChr'), 'val') ?? '(', close = mattr(child(props, M, 'endChr'), 'val') ?? ')';
        const fence = (c) => c === '' ? '.' : c === '{' ? '\\{' : c === '}' ? '\\}' : c;
        return `\\left${fence(open)} ${children(node, M, 'e').map(omml).join(', ')} \\right${fence(close)}`;
      }
      case 'func': return `${arg('fName')} ${arg('e')}`;
      case 'limLow': { const base = arg('e'); return /^\s*lim\s*$/.test(base) ? `\\lim_{${arg('lim')}}` : `{${base}}_{${arg('lim')}}`; }
      case 'limUpp': return `{${arg('e')}}^{${arg('lim')}}`;
      default: return all();
    }
  }

  async function parseDocx(buffer, pens = []) {
    const read = await unzip(buffer);
    const documentXml = await read('word/document.xml');
    if (!documentXml) throw Error('.docx 中缺少 word/document.xml');
    const parser = new DOMParser();
    const doc = parser.parseFromString(documentXml, 'application/xml');
    if (doc.querySelector('parsererror')) throw Error('.docx 内容无法解析');
    // Styles: heading level, default size / alignment per paragraph style.
    const styles = new Map();
    const stylesXml = await read('word/styles.xml');
    let defaultSize = 21; // half-points (10.5 pt, Word's Chinese default)
    if (stylesXml) {
      const sdoc = parser.parseFromString(stylesXml, 'application/xml');
      const docDefault = sdoc.getElementsByTagNameNS(W, 'docDefaults')[0];
      const sz = docDefault?.getElementsByTagNameNS(W, 'sz')[0];
      if (sz) defaultSize = Number(attr(sz, 'val')) || defaultSize;
      for (const style of sdoc.getElementsByTagNameNS(W, 'style')) {
        const name = attr(child(style, W, 'name'), 'val') || '';
        const level = name.match(/^heading\s*(\d)|^标题\s*(\d)/i);
        const rPr = child(style, W, 'rPr'), pPr = child(style, W, 'pPr');
        styles.set(attr(style, 'styleId'), { heading: level ? Number(level[1] || level[2]) : 0, size: Number(attr(child(rPr, W, 'sz'), 'val')) || 0, align: attr(child(pPr, W, 'jc'), 'val') });
      }
    }
    // Numbering: numId → bullet or numbered list (format of the first level).
    const lists = new Map();
    const numberingXml = await read('word/numbering.xml');
    if (numberingXml) {
      const ndoc = parser.parseFromString(numberingXml, 'application/xml');
      const abstract = new Map([...ndoc.getElementsByTagNameNS(W, 'abstractNum')].map((node) => [attr(node, 'abstractNumId'), attr(child(child(node, W, 'lvl'), W, 'numFmt'), 'val')]));
      for (const num of ndoc.getElementsByTagNameNS(W, 'num')) lists.set(attr(num, 'numId'), abstract.get(attr(child(num, W, 'abstractNumId'), 'val')) === 'bullet' ? 'bullet' : 'number');
    }
    const on = (node) => Boolean(node) && !['false', '0', 'none'].includes(attr(node, 'val'));
    const body = doc.getElementsByTagNameNS(W, 'body')[0];
    const chars = [], runs = [], paras = [], warnings = new Set();
    const sizeCount = new Map();
    const push = (text, props) => {
      const from = chars.length;
      chars.push(...Array.from(text));
      if (props && chars.length > from) runs.push({ from, to: chars.length, ...props });
      const size = props?.sizeHalf;
      if (size) sizeCount.set(size, (sizeCount.get(size) || 0) + chars.length - from);
    };
    const colorPen = (hex) => {
      if (!hex || hex === 'auto' || /^0{6}$/.test(hex) || !pens.length) return undefined;
      const value = `#${hex.toLowerCase()}`;
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
      if (r + g + b < 120) return undefined; // near black = default pen
      return (typeof Drawing !== 'undefined' ? Drawing.nearestPen(value, pens) : 0) + 1;
    };
    function inline(node, paraStyle) {
      for (const item of node.childNodes) {
        if (item.namespaceURI === M && (item.localName === 'oMath' || item.localName === 'oMathPara')) {
          const latex = [...item.getElementsByTagNameNS(M, 'oMath')].length && item.localName === 'oMathPara'
            ? [...item.getElementsByTagNameNS(M, 'oMath')].map(omml).join(' \\quad ')
            : omml(item);
          if (latex.trim()) push(`\\(${latex.trim()}\\)`, null);
          continue;
        }
        if (item.namespaceURI !== W) continue;
        if (item.localName === 'r') {
          const rPr = child(item, W, 'rPr');
          const sizeHalf = Number(attr(child(rPr, W, 'sz'), 'val')) || paraStyle?.size || defaultSize;
          const pen = colorPen(attr(child(rPr, W, 'color'), 'val'));
          const vertical = attr(child(rPr, W, 'vertAlign'), 'val');
          const effects = { underline: on(child(rPr, W, 'u')) || undefined, strike: on(child(rPr, W, 'strike')) || on(child(rPr, W, 'dstrike')) || undefined, script: vertical === 'superscript' ? 'sup' : vertical === 'subscript' ? 'sub' : undefined };
          for (const part of item.childNodes) {
            if (part.namespaceURI !== W) continue;
            if (part.localName === 't') push(part.textContent, { sizeHalf, pen, ...effects });
            else if (part.localName === 'tab') push('\t', { sizeHalf });
            else if (part.localName === 'br' || part.localName === 'cr') push('\n', null);
            else if (part.localName === 'drawing' || part.localName === 'pict') warnings.add('图片未导入（可另存为 SVG 后作为图形添加）');
          }
        } else if (['hyperlink', 'ins', 'smartTag', 'sdt', 'sdtContent', 'fldSimple', 'customXml'].includes(item.localName)) inline(item, paraStyle);
      }
    }
    function paragraph(p) {
      if (chars.length) chars.push('\n');
      const at = chars.length;
      const pPr = child(p, W, 'pPr');
      const style = styles.get(attr(child(pPr, W, 'pStyle'), 'val')) || null;
      const jc = attr(child(pPr, W, 'jc'), 'val') || style?.align;
      const ind = child(pPr, W, 'ind');
      const firstLine = Number(attr(ind, 'firstLine')) || 0, firstChars = Number(attr(ind, 'firstLineChars')) || 0;
      inline(p, style);
      const para = { at };
      if (jc === 'center') para.align = 'center'; else if (jc === 'right' || jc === 'end') para.align = 'right';
      if (firstLine || firstChars) para.indent = firstLine ? firstLine * TWIP_MM : firstChars / 100;
      if (style?.heading && !para.align && style.heading === 1) para.align = 'center';
      const numId = attr(child(child(pPr, W, 'numPr'), W, 'numId'), 'val');
      if (numId && numId !== '0') { para.list = lists.get(numId) || 'number'; delete para.indent; }
      // Line spacing in 240ths of a line (lineRule auto) → 1.5 / 2 / 2.5 / 3.
      const spacing = child(pPr, W, 'spacing');
      const line = Number(attr(spacing, 'line')) || 0;
      if (line && (attr(spacing, 'lineRule') || 'auto') === 'auto' && line / 240 >= 1.25) para.spacing = Math.min(3, Math.round(line / 240 * 2) / 2);
      if (para.align || para.indent || para.list || para.spacing) paras.push(para);
    }
    for (const node of body.childNodes) {
      if (node.namespaceURI !== W) continue;
      if (node.localName === 'p') paragraph(node);
      else if (node.localName === 'tbl') {
        warnings.add('表格已按行转为文字（单元格之间用制表符分隔）');
        for (const row of node.getElementsByTagNameNS(W, 'tr')) {
          const cells = [...row.getElementsByTagNameNS(W, 'tc')];
          if (chars.length) chars.push('\n');
          cells.forEach((cell, index) => {
            if (index) chars.push('\t');
            [...cell.getElementsByTagNameNS(W, 'p')].forEach((p, i) => { if (i) chars.push(' '); inline(p, null); });
          });
        }
      }
    }
    // Page format from the (last) section.
    const settings = {};
    const section = body.getElementsByTagNameNS(W, 'sectPr')[0];
    const pgSz = child(section, W, 'pgSz'), pgMar = child(section, W, 'pgMar');
    if (pgSz) {
      const w = Number(attr(pgSz, 'w')) * TWIP_MM, h = Number(attr(pgSz, 'h')) * TWIP_MM;
      const [short, long] = [Math.min(w, h), Math.max(w, h)];
      settings.paper = Math.abs(short - 148) < 6 && Math.abs(long - 210) < 6 ? 'a5' : 'a4';
      if (Math.abs(short - 210) > 6 && settings.paper === 'a4') warnings.add(`纸张 ${w.toFixed(0)} × ${h.toFixed(0)} mm 不是 A4 / A5，已按 A4 排版`);
      settings.orientation = w > h ? 'landscape' : 'portrait';
    }
    if (pgMar) {
      const margins = ['left', 'right', 'top', 'bottom'].map((side) => Number(attr(pgMar, side)) * TWIP_MM).filter((value) => value > 0);
      if (margins.length) settings.margin = String(Math.round(Math.min(40, Math.max(5, Math.min(...margins)))));
    }
    // Most common size becomes the document's base size; other sizes stay as runs.
    const baseHalf = [...sizeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || defaultSize;
    const baseMm = Math.round(baseHalf / 2 * PT_MM * 2) / 2;
    settings['font-size'] = String(Math.min(15, Math.max(2, baseMm)));
    const style = {
      runs: runs.map(({ from, to, sizeHalf, pen, underline, strike, script }) => {
        const run = { from, to };
        if (sizeHalf && sizeHalf !== baseHalf) run.size = Math.round(sizeHalf / 2 * PT_MM * 10) / 10;
        if (pen) run.pen = pen;
        if (underline) run.underline = true;
        if (strike) run.strike = true;
        if (script) run.script = script;
        return run;
      }).filter((run) => Object.keys(run).length > 2),
      paras,
    };
    return { text: chars.join(''), style, settings, warnings: [...warnings] };
  }

  const api = { parseDocx, unzip, omml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Docx = api;
})(typeof window !== 'undefined' ? window : globalThis);
