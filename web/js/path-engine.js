/* Text layout + single-line G-code generation, and a strict G-code parser for preview. */
(function (root) {
  'use strict';
  const Glyphs = typeof module !== 'undefined' && module.exports ? require('./glyphs.js') : root.Glyphs;
  const defaultResolver = () => Glyphs.createResolver(Glyphs.DEFAULT_SELECTION, new Map([[Glyphs.BUILTIN_ID, Glyphs.builtinLibrary()]]));
  const WHITESPACE_ADVANCE = .7; // × font size, matches the built-in Latin advance.

  /**
   * Shared by the paper preview and the generator so both place every character identically.
   * resolve(index, char) → glyph | null; fallbackAdvance(char) → mm width for characters without a glyph.
   * Indexes are Unicode code point positions in the original text (used by per-character pins).
   */
  function layoutText(text, options, resolve = defaultResolver(), fallbackAdvance = () => options.size * WHITESPACE_ADVANCE) {
    const { width, height, margin, size, gap, lineGap } = options;
    const chars = Array.from(text);
    const placements = [], missing = new Set();
    let x = margin, y = margin, overflow = false;
    for (let index = 0; index < chars.length; index++) {
      let char = chars[index];
      if (char === '\r') { if (chars[index + 1] === '\n') continue; char = '\n'; }
      if (char === '\n') { x = margin; y += size + lineGap; continue; }
      const blank = /\s/.test(char);
      const glyph = blank ? null : resolve(index, char);
      if (!blank && !glyph) missing.add(char);
      const body = blank ? (char === '\t' ? 4 * (size * WHITESPACE_ADVANCE + gap) - gap : size * WHITESPACE_ADVANCE) : glyph ? glyph.advance / glyph.unitsPerEm * size : fallbackAdvance(char);
      if (x + body > width - margin && x > margin) { x = margin; y += size + lineGap; }
      if (y + size > height - margin) { overflow = true; break; }
      if (!blank) placements.push({ index, char, x, y, width: body, glyph });
      x += body + gap;
    }
    return { placements, missing: [...missing], overflow };
  }

  function generate(text, options) {
    const { width, height, margin, size, gap, lineGap, feed, penUp, penDown } = options;
    // Pen zero (work 0,0) in paper mm from the left / bottom edge, and machine axis directions.
    const origin = { x: 0, y: 0, dirX: 1, dirY: 1, ...options.origin };
    if (![origin.x, origin.y].every(Number.isFinite) || ![1, -1].includes(origin.dirX) || ![1, -1].includes(origin.dirY)) throw Error('笔起点或坐标方向无效。');
    if (![width,height,margin,size,gap,lineGap,feed,penUp,penDown].every(Number.isFinite) || width<=0 || height<=0 || size<=0 || feed<=0 || margin<0 || gap<0 || lineGap<0 || margin*2+size>Math.min(width,height) || penUp<=penDown) throw Error('纸张、速度或抬落笔参数无效（抬笔 Z 必须大于落笔 Z）。');
    const result = layoutText(text, options, options.resolve || defaultResolver());
    if (result.missing.length) throw Error(`字库暂不支持：${result.missing.slice(0,20).join(' ')}${result.missing.length > 20 ? ` 等 ${result.missing.length} 个字` : ''}。请在「字形」面板启用含这些字的字库，或导入外部生成的 G-code；不能用系统字体冒充笔迹。`);
    if (!text.trim()) throw Error('请先输入书写内容。');
    if (result.overflow) throw Error('内容超出单页，请调整字号或分段生成。');
    const n = value => Number(value.toFixed(3));
    const lines = ['; Single-line text / Z-axis pen profile - review before use',
      `; Pen zero at ${n(origin.x)} mm from paper left, ${n(origin.y)} mm from paper bottom; +X ${origin.dirX > 0 ? 'right' : 'left'}, +Y ${origin.dirY > 0 ? 'up' : 'down'}`,
      'G21', 'G90', 'G17', `G0 Z${n(penUp)}`, `G1 F${n(feed)}`];
    for (const { x, y, glyph } of result.placements) {
      const scale = size / glyph.unitsPerEm;
      const point = p => `X${n(origin.dirX*(x+p[0]*scale-origin.x))} Y${n(origin.dirY*(height-y-p[1]*scale-origin.y))}`;
      for (const stroke of glyph.strokes) {
        lines.push(`G0 ${point(stroke[0])}`, `G1 Z${n(penDown)} F${n(Math.min(feed,300))}`);
        for (const p of stroke.slice(1)) lines.push(`G1 ${point(p)} F${n(feed)}`);
        lines.push(`G0 Z${n(penUp)}`);
      }
    }
    lines.push('; End - pen remains raised, no automatic homing');
    return lines.join('\n');
  }
  // Deliberately strict subset: do not silently simulate unknown machine commands.
  function parse(source, penDown=0) {
    if (source.length > 500000) return { segments: [], errors: ['程序超过 500 KB 预览上限，请拆分。'], commands: [], bounds: { minX:0,minY:0,maxX:0,maxY:0,minZ:0,maxZ:0 }, length: 0 };
    let pos={x:0,y:0,z:0}, absolute=true, unit=1, mode=0, feed=1000, explicitPen=null;
    const segments=[], errors=[], commands=[];
    const bounds={minX:0,minY:0,maxX:0,maxY:0,minZ:0,maxZ:0};
    let length=0;
    source.split(/\r?\n/).forEach((raw,index)=>{
      if (segments.length >= 200000) { if (errors.at(-1) !== '轨迹超过 200000 段，请拆分。') errors.push('轨迹超过 200000 段，请拆分。'); return; }
      const line=index+1;
      const code=raw.replace(/\([^)]*\)/g,'').replace(/;.*/,'').trim().toUpperCase();
      if (!code) return;
      const tokens=[...code.matchAll(/([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g)];
      if (!tokens.length || code.replace(/([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g,'').trim()) { errors.push(`第 ${line} 行：无法解析`); return; }
      const words={}; let invalid=false;
      for (const [,letter,num] of tokens) {
        const value=Number(num);
        if (!Number.isFinite(value)) {invalid=true;break;}
        if (letter==='G') {
          if ([0,1,2,3].includes(value)) mode=value;
          else if (value===90) absolute=true;
          else if (value===91) absolute=false;
          else if (value===20) unit=25.4;
          else if (value===21) unit=1;
          else if (value!==17) invalid=true;
        } else if (letter==='M') {
          if (value===3) explicitPen=true;
          else if (value===5) explicitPen=false;
          else if (![2,30].includes(value)) invalid=true;
          if ([2,30].includes(value)) { errors.push(`第 ${line} 行：请移除 M2 / M30 结束标记后再导入`); invalid=true; }
        } else if ('XYZIJFSN'.includes(letter)) { if (letter in words) invalid=true; words[letter]=value; }
        else invalid=true;
      }
      if (invalid) { errors.push(`第 ${line} 行：包含不支持的指令；仅支持 G0–G3、G17、G20/21、G90/91、M3/5 和 XYZ/IJ/F/S/N`); return; }
      if (words.F!==undefined) {feed=words.F*unit;if(feed<=0) {errors.push(`第 ${line} 行：进给速度必须为正数`);return;}}
      const next={...pos};
      for (const axis of ['x','y','z']) if (words[axis.toUpperCase()]!==undefined) next[axis]=(absolute?0:pos[axis])+words[axis.toUpperCase()]*unit;
      const hasXY=words.X!==undefined||words.Y!==undefined;
      const arc=[2,3].includes(mode)&&(hasXY||words.I!==undefined||words.J!==undefined);
      const rapid=mode===0;
      const drawing=!rapid&&(explicitPen===null?next.z<=penDown+.001:explicitPen);
      const add=(from,to)=>{
        const distance=Math.hypot(to.x-from.x,to.y-from.y,to.z-from.z);
        if (distance<1e-9) return;
        length+=distance;
        segments.push({from:{...from},to:{...to},line,rapid,drawing,feed,length,distance});
        for (const p of [from,to]) for (const axis of ['X','Y','Z']) {bounds[`min${axis}`]=Math.min(bounds[`min${axis}`],p[axis.toLowerCase()]);bounds[`max${axis}`]=Math.max(bounds[`max${axis}`],p[axis.toLowerCase()]);}
      };
      if (arc) {
        if (words.I===undefined&&words.J===undefined) {errors.push(`第 ${line} 行：圆弧需要相对圆心 I/J；暂不支持 R 圆弧`);return;}
        const cx=pos.x+(words.I||0)*unit,cy=pos.y+(words.J||0)*unit;
        const radius=Math.hypot(pos.x-cx,pos.y-cy),endRadius=Math.hypot(next.x-cx,next.y-cy);
        if (radius<.001||Math.abs(radius-endRadius)>.05) {errors.push(`第 ${line} 行：圆弧半径不一致`);return;}
        const start=Math.atan2(pos.y-cy,pos.x-cx),end=Math.atan2(next.y-cy,next.x-cx);
        let angle=end-start;
        if(mode===2) {while(angle>=-1e-10) angle-=2*Math.PI;} else {while(angle<=1e-10) angle+=2*Math.PI;}
        const steps=Math.min(10000,Math.max(8,Math.ceil(Math.abs(angle)*radius/.5)));
        let from=pos;
        for(let i=1;i<=steps;i++) {const a=start+angle*i/steps;const to=i===steps?next:{x:cx+radius*Math.cos(a),y:cy+radius*Math.sin(a),z:pos.z+(next.z-pos.z)*i/steps};add(from,to);from=to;}
      } else if (hasXY||words.Z!==undefined) add(pos,next);
      pos=next;
      commands.push({line,code});
    });
    return {segments,errors,commands,bounds,length};
  }
  const api={generate,parse,layoutText};
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
  else root.PathEngine=api;
})(typeof window!=='undefined'?window:globalThis);
