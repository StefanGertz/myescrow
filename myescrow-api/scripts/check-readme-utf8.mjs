#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const target = path.resolve("README.md");
const text = fs.readFileSync(target, "utf8");
const invalid = [];

for (let i = 0; i < text.length; i += 1) {
  const code = text.charCodeAt(i);
  // allow standard ASCII (<= 0x7f)
  if (code > 0x7f) {
    invalid.push({ index: i, code });
  }
}

if (invalid.length > 0) {
  console.error(`Found ${invalid.length} non-ASCII character(s) in ${target}`);
  invalid.slice(0, 10).forEach(({ index, code }) => {
    const context = text.slice(Math.max(0, index - 20), Math.min(text.length, index + 20));
    console.error(`  index ${index}, code 0x${code.toString(16)} -> context: ${JSON.stringify(context)}`);
  });
  if (invalid.length > 10) {
    console.error(`  ...and ${invalid.length - 10} more`);
  }
  process.exit(1);
}

console.log(`UTF-8 check passed for ${target}`);
