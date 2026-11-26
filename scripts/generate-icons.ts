import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.cwd();
const BUILD_DIR = path.join(ROOT, 'build');
const APPX_DIR = path.join(BUILD_DIR, 'appx');

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lenSq = vx * vx + vy * vy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq));
  const cx = ax + t * vx;
  const cy = ay + t * vy;
  return Math.hypot(px - cx, py - cy);
}

function blendPixel(
  rgba: Uint8Array,
  idx: number,
  r: number,
  g: number,
  b: number,
  a: number
): void {
  const alpha = Math.max(0, Math.min(1, a));
  if (alpha <= 0) return;
  const dstA = rgba[idx + 3] / 255;
  const outA = alpha + dstA * (1 - alpha);
  if (outA <= 0) return;
  rgba[idx] = Math.round((r * alpha + rgba[idx] * dstA * (1 - alpha)) / outA);
  rgba[idx + 1] = Math.round((g * alpha + rgba[idx + 1] * dstA * (1 - alpha)) / outA);
  rgba[idx + 2] = Math.round((b * alpha + rgba[idx + 2] * dstA * (1 - alpha)) / outA);
  rgba[idx + 3] = Math.round(outA * 255);
}

function renderLogoIcon(width: number, height: number, wideTile = false): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  const emblemSize = Math.min(width, height);
  const offsetX = (width - emblemSize) / 2;
  const offsetY = (height - emblemSize) / 2;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const gx = x / width;
      const gy = y / height;

      if (wideTile) {
        // Subtle diagonal dark slate -> deep teal gradient tile background
        const t = Math.min(1, Math.max(0, gx * 0.6 + gy * 0.4));
        const br = Math.round(15 + t * 0);
        const bg = Math.round(23 + t * 95);
        const bb = Math.round(42 + t * 68);
        rgba[idx] = br;
        rgba[idx + 1] = bg;
        rgba[idx + 2] = bb;
        rgba[idx + 3] = 255;
      }

      // Normalized coordinates [0..1] inside square emblem area
      const u = (x + 0.5 - offsetX) / emblemSize;
      const v = (y + 0.5 - offsetY) / emblemSize;
      if (u < -0.05 || u > 1.05 || v < -0.05 || v > 1.05) continue;

      // Rounded square tile (#0F766E teal with subtle slate depth)
      if (!wideTile) {
        const pad = 0.06;
        const radius = 0.2;
        const cx = Math.max(pad + radius, Math.min(1 - pad - radius, u));
        const cy = Math.max(pad + radius, Math.min(1 - pad - radius, v));
        const dBox = Math.hypot(u - cx, v - cy) - radius;
        const aa = Math.max(0, Math.min(1, 0.5 - dBox * emblemSize * 0.9));
        if (aa > 0) {
          const grad = (u * 0.4 + v * 0.6);
          const tr = Math.round(15 * (1 - grad) + 13 * grad);
          const tg = Math.round(118 * (1 - grad) + 92 * grad);
          const tb = Math.round(110 * (1 - grad) + 96 * grad);
          blendPixel(rgba, idx, tr, tg, tb, aa);
        }
      }

      // Inner crisp border ring
      const innerPad = wideTile ? 0.14 : 0.1;
      const innerRadius = 0.16;
      const icx = Math.max(innerPad + innerRadius, Math.min(1 - innerPad - innerRadius, u));
      const icy = Math.max(innerPad + innerRadius, Math.min(1 - innerPad - innerRadius, v));
      const dRing = Math.abs(Math.hypot(u - icx, v - icy) - innerRadius);
      const ringAlpha = Math.max(0, Math.min(1, (0.012 - dRing) * emblemSize * 0.8));
      if (ringAlpha > 0) {
        blendPixel(rgba, idx, 153, 246, 228, ringAlpha * 0.35);
      }

      // Tailoring shears blades: V top meeting at pivot (0.5, 0.53) + vertical handle stem
      const bladeRadius = 0.036;
      const dLeftBlade = distToSegment(u, v, 0.28, 0.21, 0.5, 0.54);
      const dRightBlade = distToSegment(u, v, 0.72, 0.21, 0.5, 0.54);
      const dStem = distToSegment(u, v, 0.5, 0.54, 0.5, 0.79);
      const dBlades = Math.min(dLeftBlade, dRightBlade, dStem);
      const bladeAlpha = Math.max(0, Math.min(1, (bladeRadius - dBlades) * emblemSize * 0.95));
      if (bladeAlpha > 0) {
        blendPixel(rgba, idx, 255, 255, 255, bladeAlpha);
      }

      // Left & right finger loops (#99F6E4 bright mint accent rings)
      const ringStroke = 0.026;
      const dLoopL = Math.abs(Math.hypot(u - 0.35, v - 0.72) - 0.085);
      const dLoopR = Math.abs(Math.hypot(u - 0.65, v - 0.72) - 0.085);
      const dLoop = Math.min(dLoopL, dLoopR);
      const loopAlpha = Math.max(0, Math.min(1, (ringStroke - dLoop) * emblemSize * 0.95));
      if (loopAlpha > 0) {
        blendPixel(rgba, idx, 153, 246, 228, loopAlpha);
      }

      // Pivot rivet dot (#0F172A dark slate dot inside blade intersection)
      const dPivot = Math.hypot(u - 0.5, v - 0.53);
      const pivotAlpha = Math.max(0, Math.min(1, (0.022 - dPivot) * emblemSize * 0.95));
      if (pivotAlpha > 0) {
        blendPixel(rgba, idx, 15, 23, 42, pivotAlpha);
      }
    }
  }

  return rgba;
}

function renderRoundIcon(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (y * size + x) * 4;
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      const dCircle = Math.hypot(u - 0.5, v - 0.5) - 0.45;
      const aa = Math.max(0, Math.min(1, 0.5 - dCircle * size * 0.9));
      if (aa > 0) {
        const grad = u * 0.4 + v * 0.6;
        const tr = Math.round(15 * (1 - grad) + 13 * grad);
        const tg = Math.round(118 * (1 - grad) + 92 * grad);
        const tb = Math.round(110 * (1 - grad) + 96 * grad);
        blendPixel(rgba, idx, tr, tg, tb, aa);
      }

      const bladeRadius = 0.036;
      const dLeftBlade = distToSegment(u, v, 0.28, 0.21, 0.5, 0.54);
      const dRightBlade = distToSegment(u, v, 0.72, 0.21, 0.5, 0.54);
      const dStem = distToSegment(u, v, 0.5, 0.54, 0.5, 0.79);
      const dBlades = Math.min(dLeftBlade, dRightBlade, dStem);
      const bladeAlpha = Math.max(0, Math.min(1, (bladeRadius - dBlades) * size * 0.95));
      if (bladeAlpha > 0) {
        blendPixel(rgba, idx, 255, 255, 255, bladeAlpha);
      }

      const ringStroke = 0.026;
      const dLoopL = Math.abs(Math.hypot(u - 0.35, v - 0.72) - 0.085);
      const dLoopR = Math.abs(Math.hypot(u - 0.65, v - 0.72) - 0.085);
      const loopAlpha = Math.max(0, Math.min(1, (ringStroke - Math.min(dLoopL, dLoopR)) * size * 0.95));
      if (loopAlpha > 0) {
        blendPixel(rgba, idx, 153, 246, 228, loopAlpha);
      }

      const dPivot = Math.hypot(u - 0.5, v - 0.53);
      const pivotAlpha = Math.max(0, Math.min(1, (0.022 - dPivot) * size * 0.95));
      if (pivotAlpha > 0) {
        blendPixel(rgba, idx, 15, 23, 42, pivotAlpha);
      }
    }
  }
  return rgba;
}

function renderAdaptiveForeground(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (y * size + x) * 4;
      // Scale shears into the central 64% safe zone of the 108dp adaptive foreground
      const rawU = (x + 0.5) / size;
      const rawV = (y + 0.5) / size;
      const u = (rawU - 0.5) / 0.64 + 0.5;
      const v = (rawV - 0.5) / 0.64 + 0.5;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;

      const bladeRadius = 0.036;
      const dLeftBlade = distToSegment(u, v, 0.28, 0.21, 0.5, 0.54);
      const dRightBlade = distToSegment(u, v, 0.72, 0.21, 0.5, 0.54);
      const dStem = distToSegment(u, v, 0.5, 0.54, 0.5, 0.79);
      const dBlades = Math.min(dLeftBlade, dRightBlade, dStem);
      const bladeAlpha = Math.max(0, Math.min(1, (bladeRadius - dBlades) * size * 0.64 * 0.95));
      if (bladeAlpha > 0) {
        blendPixel(rgba, idx, 255, 255, 255, bladeAlpha);
      }

      const ringStroke = 0.026;
      const dLoopL = Math.abs(Math.hypot(u - 0.35, v - 0.72) - 0.085);
      const dLoopR = Math.abs(Math.hypot(u - 0.65, v - 0.72) - 0.085);
      const loopAlpha = Math.max(0, Math.min(1, (ringStroke - Math.min(dLoopL, dLoopR)) * size * 0.64 * 0.95));
      if (loopAlpha > 0) {
        blendPixel(rgba, idx, 153, 246, 228, loopAlpha);
      }

      const dPivot = Math.hypot(u - 0.5, v - 0.53);
      const pivotAlpha = Math.max(0, Math.min(1, (0.022 - dPivot) * size * 0.64 * 0.95));
      if (pivotAlpha > 0) {
        blendPixel(rgba, idx, 15, 23, 42, pivotAlpha);
      }
    }
  }
  return rgba;
}

function buildIcoFromPngs(entries: Array<{ size: number; png: Buffer }>): Buffer {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // ICON type
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(count * 16);
  let offset = 6 + count * 16;

  entries.forEach((entry, i) => {
    const base = i * 16;
    const dimByte = entry.size >= 256 ? 0 : entry.size;
    dir[base] = dimByte;
    dir[base + 1] = dimByte;
    dir[base + 2] = 0; // palette
    dir[base + 3] = 0; // reserved
    dir.writeUInt16LE(1, base + 4); // planes
    dir.writeUInt16LE(32, base + 6); // bpp
    dir.writeUInt32LE(entry.png.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

function generateAndroidIcons() {
  const androidResDir = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
  if (!fs.existsSync(androidResDir)) return false;

  const densities: Array<{ folder: string; legacySize: number; fgSize: number }> = [
    { folder: 'mipmap-mdpi', legacySize: 48, fgSize: 108 },
    { folder: 'mipmap-hdpi', legacySize: 72, fgSize: 162 },
    { folder: 'mipmap-xhdpi', legacySize: 96, fgSize: 216 },
    { folder: 'mipmap-xxhdpi', legacySize: 144, fgSize: 324 },
    { folder: 'mipmap-xxxhdpi', legacySize: 192, fgSize: 432 },
  ];

  for (const d of densities) {
    const dir = path.join(androidResDir, d.folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'ic_launcher.png'),
      encodePng(d.legacySize, d.legacySize, renderLogoIcon(d.legacySize, d.legacySize, false))
    );
    fs.writeFileSync(
      path.join(dir, 'ic_launcher_round.png'),
      encodePng(d.legacySize, d.legacySize, renderRoundIcon(d.legacySize))
    );
    fs.writeFileSync(
      path.join(dir, 'ic_launcher_foreground.png'),
      encodePng(d.fgSize, d.fgSize, renderAdaptiveForeground(d.fgSize))
    );
  }

  const valuesDir = path.join(androidResDir, 'values');
  fs.mkdirSync(valuesDir, { recursive: true });
  fs.writeFileSync(
    path.join(valuesDir, 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0F766E</color>\n</resources>\n`,
    'utf8'
  );

  return true;
}

function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(APPX_DIR, { recursive: true });

  // Main desktop PNG icon (512x512)
  const png512 = encodePng(512, 512, renderLogoIcon(512, 512, false));
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), png512);

  // Windows ICO containing multiple PNG-encoded sizes
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoEntries = icoSizes.map((sz) => ({
    size: sz,
    png: encodePng(sz, sz, renderLogoIcon(sz, sz, false)),
  }));
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), buildIcoFromPngs(icoEntries));

  // Microsoft Store / MSIX AppX visual assets
  fs.writeFileSync(
    path.join(APPX_DIR, 'Square44x44Logo.png'),
    encodePng(44, 44, renderLogoIcon(44, 44, false))
  );
  fs.writeFileSync(
    path.join(APPX_DIR, 'Square150x150Logo.png'),
    encodePng(150, 150, renderLogoIcon(150, 150, false))
  );
  fs.writeFileSync(
    path.join(APPX_DIR, 'StoreLogo.png'),
    encodePng(50, 50, renderLogoIcon(50, 50, false))
  );
  fs.writeFileSync(
    path.join(APPX_DIR, 'Wide310x150Logo.png'),
    encodePng(310, 150, renderLogoIcon(310, 150, true))
  );

  const androidGenerated = generateAndroidIcons();

  console.log(
    androidGenerated
      ? 'Generated SmartTailoringSystem desktop, MSIX, and Android mipmap icons.'
      : 'Generated SmartTailoringSystem desktop & MSIX icons in build/ and build/appx/.'
  );
}

main();
