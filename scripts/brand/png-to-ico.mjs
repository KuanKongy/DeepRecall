#!/usr/bin/env node
// Wrap a single square PNG (≤256px) in an ICO container (PNG-in-ICO).
// Usage: node png-to-ico.mjs input.png output.ico
import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("Usage: node png-to-ico.mjs input.png output.ico");
  process.exit(1);
}

const png = readFileSync(inPath);
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // image count

const entry = Buffer.alloc(16);
entry.writeUInt8(width >= 256 ? 0 : width, 0);
entry.writeUInt8(height >= 256 ? 0 : height, 1);
entry.writeUInt16LE(1, 4); // color planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(png.length, 8); // image data size
entry.writeUInt32LE(header.length + entry.length, 12); // data offset

writeFileSync(outPath, Buffer.concat([header, entry, png]));
