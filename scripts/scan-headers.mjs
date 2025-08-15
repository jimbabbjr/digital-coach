// scripts/scan-headers.mjs
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "netlify", "functions");
const exts = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const NEEDLES = [
  "X-Model",
  "Access-Control-Expose-Headers",
  "X-Policy-Version",
  "X-Debug-Stamp",
];

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const fp = path.join(dir, name);
    const st = fs.statSync(fp);
    if (st.isDirectory()) walk(fp, out);
    else if (st.isFile() && exts.has(path.extname(name))) out.push(fp);
  }
  return out;
}

function scanFile(fp, needles) {
  const txt = fs.readFileSync(fp, "utf8");
  const lines = txt.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    for (const n of needles) {
      if (lines[i].includes(n)) hits.push({ line: i + 1, needle: n, text: lines[i].trim() });
    }
  }
  return hits;
}

function main() {
  if (!fs.existsSync(ROOT)) {
    console.error("Not found:", ROOT);
    process.exit(1);
  }

  // 1) chat.* siblings (a stray chat.js will shadow chat.ts)
  const siblings = fs
    .readdirSync(ROOT)
    .filter((n) => /^chat\.(ts|tsx|js|mjs|cjs)$/.test(n))
    .map((n) => path.join("netlify/functions", n));
  console.log("=== chat.* siblings ===");
  console.log(siblings.length ? siblings.join("\n") : "(none)");
  console.log("");

  // 2) grep key headers
  const files = walk(ROOT);
  const results = [];
  for (const fp of files) {
    const hits = scanFile(fp, NEEDLES);
    if (hits.length) results.push({ fp, hits });
  }

  for (const n of NEEDLES) {
    console.log(`=== Matches for "${n}" ===`);
    let any = false;
    for (const r of results) {
      for (const h of r.hits.filter((x) => x.needle === n)) {
        any = true;
        console.log(`${r.fp}:${h.line}: ${h.text}`);
      }
    }
    if (!any) console.log("(none)");
    console.log("");
  }
}

main();
