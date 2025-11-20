#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const icoPath = path.join(__dirname, "..", "public", "favicon.ico");

const entries = [
	{ size: 16, file: path.join(__dirname, "..", "public", "logo-16.png") },
	{ size: 32, file: path.join(__dirname, "..", "public", "logo-32.png") },
];

const pngBuffers = await Promise.all(entries.map(async (entry) => ({
	size: entry.size,
	buffer: await readFile(entry.file),
})));

const ICONDIR = Buffer.alloc(6);
ICONDIR.writeUInt16LE(0, 0); // reserved
ICONDIR.writeUInt16LE(1, 2); // type: icon
ICONDIR.writeUInt16LE(pngBuffers.length, 4); // count

const dirEntries = [];
let offset = 6 + pngBuffers.length * 16;

for (const { size, buffer } of pngBuffers) {
	const entry = Buffer.alloc(16);
	entry[0] = size === 256 ? 0 : size;
	entry[1] = size === 256 ? 0 : size;
	entry[2] = 0; // palette
	entry[3] = 0; // reserved
	entry.writeUInt16LE(1, 4); // planes
	entry.writeUInt16LE(32, 6); // bit count
	entry.writeUInt32LE(buffer.length, 8);
	entry.writeUInt32LE(offset, 12);
	dirEntries.push(entry);
	offset += buffer.length;
}

const icoBuffer = Buffer.concat([
	ICONDIR,
	...dirEntries,
	...pngBuffers.map(({ buffer }) => buffer),
]);

await writeFile(icoPath, icoBuffer);
console.log(`favicon.ico written to ${icoPath}`);
