/* global process, console, URL */
// Fails if docs/evidence/edge-cases.md cites a test title that does not exist in the cited test file,
// if a row cites no test, or if any of edge cases 1..18 is missing. Wired into `npm run verify`.
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TABLE = join(ROOT, 'docs/evidence/edge-cases.md');
const SEARCH_DIRS = ['apps', 'packages', 'e2e', 'smoke'];
const CASE_COUNT = 18;
const HEADER = /^\| # \| Case \|/;
const ROW = /^\| (\d+) \|/;
const CITATION = /`([^`]+\.(?:test|spec)\.ts)` → "([^"]+)"/g;

function collectTestFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, out);
    else if (/\.(test|spec)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

function indexByName(paths) {
  const byName = new Map();
  for (const p of paths) byName.set(basename(p), [...(byName.get(basename(p)) ?? []), readFileSync(p, 'utf8')]);
  return byName;
}

function checkRow(line, byName, errors) {
  const id = Number(line.match(ROW)[1]);
  const citations = [...line.matchAll(CITATION)];
  if (citations.length === 0) errors.push(`#${id}: cites no test title`);
  for (const [, file, title] of citations) {
    const sources = byName.get(file);
    if (!sources) errors.push(`#${id}: no test file named ${file}`);
    else if (!sources.some((src) => src.includes(title))) errors.push(`#${id}: "${title}" not found in ${file}`);
  }
  return { id, count: citations.length };
}

const testFiles = SEARCH_DIRS.flatMap((d) => collectTestFiles(join(ROOT, d), []));
const byName = indexByName(testFiles);
const errors = [];
/** Rows of the first table whose header starts with `| # | Case |`, up to the next non-table line. */
function edgeRows(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => HEADER.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && !line.startsWith('|'));
  return lines.slice(start, end < 0 ? undefined : end).filter((line) => ROW.test(line));
}

const rows = edgeRows(readFileSync(TABLE, 'utf8')).map((line) => checkRow(line, byName, errors));

for (let id = 1; id <= CASE_COUNT; id++) {
  const n = rows.filter((r) => r.id === id).length;
  if (n !== 1) errors.push(`#${id}: appears ${n} times in the table`);
}

const cited = rows.reduce((sum, r) => sum + r.count, 0);
if (errors.length > 0) {
  console.error(`edge-case table: ${errors.length} problem(s)\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log(`edge-case table OK: ${rows.length} cases, ${cited} cited test titles found in ${testFiles.length} test files`);
