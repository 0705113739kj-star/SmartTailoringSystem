import fs from 'node:fs';
import path from 'node:path';

const srcWasm = path.resolve(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const destDir = path.resolve(process.cwd(), 'public', 'wasm');
const destWasm = path.join(destDir, 'sql-wasm.wasm');

if (!fs.existsSync(srcWasm)) {
  throw new Error(`Missing sql-wasm.wasm at ${srcWasm}. Run npm install first.`);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(srcWasm, destWasm);
console.log('Copied sql-wasm.wasm -> public/wasm/sql-wasm.wasm');
