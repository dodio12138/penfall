'use strict';
// Word-like editing on the paper, formatting toolbar, formulas, .docx import.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const url = process.env.TEST_URL || 'http://127.0.0.1:5173';

/** Minimal ZIP (stored entries) so the test needs no zip library. */
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, data); central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
const docx = zip({
  'word/styles.xml': `<w:styles ${ns}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="28"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:rPr><w:sz w:val="44"/></w:rPr></w:style></w:styles>`,
  'word/document.xml': `<w:document ${ns}><w:body>
    <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>物理作业</w:t></w:r></w:p>
    <w:p><w:pPr><w:ind w:firstLineChars="200" w:firstLine="560"/></w:pPr><w:r><w:t xml:space="preserve">已知 </w:t></w:r><m:oMath><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>，求解。</w:t></w:r></w:p>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>此致</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:sectPr><w:pgSz w:w="8391" w:h="11906"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>
  </w:body></w:document>`,
});

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator('#content:not([disabled])').waitFor();
    // Type directly on the paper.
    await page.locator('#preview-tab').click();
    await page.locator('[data-select-id=zoom]').click();
    await page.getByRole('option', { name: '150%' }).click();
    let box = await page.locator('#preview').boundingBox();
    await page.mouse.click(box.x + 40, box.y + 40);
    await page.keyboard.type('标题');
    await page.keyboard.press('Enter');
    await page.keyboard.type('正文第一行');
    assert.equal(await page.locator('#content').inputValue(), '标题\n正文第一行');
    assert(await page.locator('#paper-caret').isVisible());
    // Up arrow moves by the paper's rows; Home goes to row start.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => content.selectionStart), 0);
    // Heading + centre; selection-based size and pen.
    await page.locator('[data-select-id=para-style]').click();
    await page.getByRole('option', { name: '标题 1' }).click();
    let style = await page.evaluate(() => textStyle);
    assert.deepEqual(style.paras, [{ at: 0, align: 'center' }]);
    assert.deepEqual(style.runs, [{ from: 0, to: 2, size: 8 }]);
    await page.evaluate(() => content.setSelectionRange(3, 5));
    await page.locator('[data-select-id=run-pen]').click();
    await page.getByRole('option', { name: /2 · 红/ }).click();
    style = await page.evaluate(() => textStyle);
    assert.deepEqual(style.runs.at(-1), { from: 3, to: 5, pen: 2 });
    assert.equal(await page.evaluate(() => layout.placements.find((item) => item.index === 3).pen), 2);
    // Formatting follows the text when typing before it.
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.type('新');
    style = await page.evaluate(() => textStyle);
    assert.deepEqual(style.runs.at(-1), { from: 4, to: 6, pen: 2 });
    // Formula: insert, edit by clicking it, generation includes it.
    await page.keyboard.press('ControlOrMeta+End');
    await page.locator('#insert-formula').click();
    await page.locator('#formula-source').fill('\\frac{1}{');
    assert(await page.locator('#formula-accept').isDisabled());
    assert.match(await page.locator('#formula-error').textContent(), /缺少/);
    await page.locator('#formula-source').fill('\\sqrt{x^2+1}');
    await page.locator('#formula-accept').click();
    await page.keyboard.type('。');
    assert.match(await page.locator('#content').inputValue(), /\\\(\\sqrt\{x\^2\+1\}\\\)。$/);
    const formula = await page.evaluate(() => { const f = layout.placements.find((item) => item.kind === 'formula'); return { x: f.x + f.width / 2, y: f.y + f.height / 2, w: layout.width, h: layout.height }; });
    box = await page.locator('#preview').boundingBox();
    await page.mouse.click(box.x + formula.x / formula.w * box.width, box.y + formula.y / formula.h * box.height);
    await page.locator('#formula-dialog').waitFor();
    assert.equal(await page.locator('#formula-source').inputValue(), '\\sqrt{x^2+1}');
    await page.locator('#formula-source').fill('\\sqrt[3]{x}');
    await page.locator('#formula-accept').click();
    assert.match(await page.locator('#content').inputValue(), /\\\(\\sqrt\[3\]\{x\}\\\)。$/);
    await page.locator('#gcode-tab').click();
    await page.locator('#generate-code').click();
    assert((await page.locator('#gcode').inputValue()).split('\n').length > 300);
    // Right-click a character → its variant picker (click is now for the caret).
    await page.locator('#preview-tab').click();
    const glyph = await page.evaluate(() => { const g = layout.placements.find((item) => item.char === '正'); return { x: g.x + g.width / 2, y: g.y + g.size / 2, w: layout.width, h: layout.height }; });
    box = await page.locator('#preview').boundingBox();
    await page.mouse.click(box.x + glyph.x / glyph.w * box.width, box.y + glyph.y / glyph.h * box.height, { button: 'right' });
    await page.locator('.glyph-picker').waitFor();
    assert.match(await page.locator('.glyph-picker-heading').textContent(), /「正」/);
    await page.keyboard.press('Escape');
    // Persisted in the draft.
    await page.waitForFunction(() => document.querySelector('#save-indicator').textContent === '已保存');
    await page.reload();
    await page.locator('#content:not([disabled])').waitFor();
    style = await page.evaluate(() => textStyle);
    assert.deepEqual(style.paras, [{ at: 0, align: 'center' }]);
    assert.equal(style.runs.length, 2);

    // Word import: headings, indent, colour → pen, equation, table, A5 page.
    await page.locator('#document-file').setInputFiles({ name: '物理作业.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx });
    await page.waitForFunction(() => document.title.startsWith('物理作业'));
    const imported = await page.evaluate(() => ({ text: content.value, style: textStyle, paper: $('#paper').value, size: $('#font-size').value, margin: $('#margin').value }));
    assert.equal(imported.text, '物理作业\n已知 \\(\\frac{a}{b}\\)，求解。\n此致\n甲\t乙');
    assert.equal(imported.paper, 'a5');
    assert.equal(imported.size, '5');      // 14 pt default ≈ 4.9 mm → 5
    assert.equal(imported.margin, '20');   // 1134 twips = 20 mm
    assert.deepEqual(imported.style.paras.map((p) => [p.at, p.align, p.indent && Math.round(p.indent)]), [[0, 'center', undefined], [5, undefined, 10], [28, 'center', undefined]]);
    assert(imported.style.runs.some((run) => run.size === 7.8));                       // 22 pt heading
    assert(imported.style.runs.some((run) => run.pen === 2 && run.from === 23));       // red → pen 2
    assert.match(await page.locator('#log').innerText(), /表格已按行转为文字/);
    assert.deepEqual(await page.evaluate(() => layout.formulaErrors), []);
    assert.deepEqual(errors, []);
    console.log('Rich editing checks passed: typing on paper, row navigation, headings / alignment / pens, formatting follows edits, formulas (insert, validate, edit), right-click variants, persistence, .docx import.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
