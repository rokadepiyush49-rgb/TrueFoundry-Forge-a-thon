#!/usr/bin/env node
// Build docs/ForgePilot-Writeup.pdf from docs/writeup/writeup.html + data.json
// using headless Chrome (Mermaid renders in the page before printing).
import { readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "docs/writeup");
const data = JSON.parse(readFileSync(path.join(dir, "data.json"), "utf8"));
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const todo = (v, label) => (v && String(v).trim() ? esc(v) : `<span class="todo">${label}</span>`);
const missing = [];
const need = (v, label) => {
  if (!v || !String(v).trim()) missing.push(label);
  return todo(v, label);
};

let html = readFileSync(path.join(dir, "writeup.html"), "utf8");
html = html.replace("{{VIDEO_URL}}", data.videoUrl ? `<a href="${esc(data.videoUrl)}">${esc(data.videoUrl)}</a>` : need("", "video link"));
html = html.replace(
  "{{TEAM_ROWS}}",
  data.team.map((m) => `<tr><td>${need(m.name, "name")}</td><td>${need(m.org, "college / employer")}</td><td>${need(m.github, "GitHub")}</td></tr>`).join("\n"),
);
html = html.replace(
  "{{MODEL_ROWS}}",
  data.models.map((m) => `<tr><td>${esc(m.role)}</td><td><code>${esc(m.fqn)}</code></td><td>${esc(m.where)}</td><td>${need(m.cost, "cost")}</td></tr>`).join("\n"),
);
for (const [k, v] of Object.entries(data.timestamps)) html = html.replace(`{{T_${k}}}`, need(v, "mm:ss"));

const built = path.join(dir, "writeup.build.html");
writeFileSync(built, html);
const out = path.join(root, "docs/ForgePilot-Writeup.pdf");
const chrome = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!chrome) throw new Error("Chrome not found; set CHROME_PATH");
execFileSync(chrome, [
  "--headless=new",
  "--disable-gpu",
  "--no-pdf-header-footer",
  "--allow-file-access-from-files",
  "--virtual-time-budget=20000",
  `--print-to-pdf=${out}`,
  `file://${built}`,
], { stdio: "ignore" });
if (!process.env.KEEP_HTML) rmSync(built);
const pdf = readFileSync(out).toString("latin1");
const pages = (pdf.match(/\/Type\s*\/Page(?!s)/g) || []).length;
console.log(`wrote ${path.relative(root, out)}: ${pages} page(s)`);
if (missing.length) console.log(`still to fill in docs/writeup/data.json: ${[...new Set(missing)].join(", ")}`);
if (pages > 3) {
  console.error("The brief allows 1-3 pages; shorten the write-up.");
  process.exit(1);
}
