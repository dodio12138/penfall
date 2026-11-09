'use strict';
// Converts Hershey .jhf fonts into web/glyphs libraries and registers them in web/glyphs/index.json.
// Usage: node tools/make-hershey-glyphs.cjs <dir with .jhf files>
const fs = require('node:fs');
const path = require('node:path');
const Glyphs = require('../web/js/glyphs.js');
const source = process.argv[2];
if (!source) { console.error('Usage: node tools/make-hershey-glyphs.cjs <jhf directory>'); process.exit(1); }
const fonts = [
  { file: 'futural', id: 'hershey-sans', name: 'Hershey 无衬线（单线）', description: 'Hershey Futura Light：单线无衬线，含大小写、数字和 ASCII 标点。' },
  { file: 'rowmans', id: 'hershey-roman', name: 'Hershey 罗马（单线）', description: 'Hershey Roman Simplex：单线罗马体，含大小写、数字和 ASCII 标点。' },
  { file: 'scripts', id: 'hershey-script', name: 'Hershey 手写体（单线）', description: 'Hershey Script Simplex：单线斜体手写风格。' },
  { file: 'cursive', id: 'hershey-cursive', name: 'Hershey 连笔体（单线）', description: 'Hershey Cursive：单线连笔风格。' },
];
const out = path.join(__dirname, '../web/glyphs');
const indexPath = path.join(out, 'index.json');
const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : { libraries: [] };
for (const font of fonts) {
  const library = Glyphs.fromJHF(fs.readFileSync(path.join(source, `${font.file}.jhf`), 'latin1'), { id: font.id, name: font.name, description: font.description, author: 'Dr. A. V. Hershey（数据格式 James Hurt）' });
  fs.writeFileSync(path.join(out, `${font.id}.json`), JSON.stringify(library));
  index.libraries = index.libraries.filter((entry) => entry.id !== font.id);
  index.libraries.push({ id: library.id, name: library.name, file: `${font.id}.json`, chars: library.glyphs.length, description: library.description });
  console.log(`${font.id}: ${library.glyphs.length} chars`);
}
fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
