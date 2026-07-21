import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { onPageLeave } from "../src/lib/client-lifecycle.ts";

test("page cleanup runs once when Astro swaps the document", () => {
  const target = new EventTarget();
  let calls = 0;
  const cleanup = onPageLeave(target, () => {
    calls += 1;
  });

  target.dispatchEvent(new Event("astro:before-swap"));
  target.dispatchEvent(new Event("astro:before-swap"));
  cleanup();

  assert.equal(calls, 1);
});

test("page cleanup can run early and unregister from the swap event", () => {
  const target = new EventTarget();
  let calls = 0;
  const cleanup = onPageLeave(target, () => {
    calls += 1;
  });

  cleanup();
  target.dispatchEvent(new Event("astro:before-swap"));

  assert.equal(calls, 1);
});

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith(".astro") || entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("client source does not assign provider data to raw HTML sinks", () => {
  const sink = /\b(?:innerHTML|outerHTML)\s*=|\binsertAdjacentHTML\s*\(/;
  for (const path of sourceFiles("src")) {
    assert.doesNotMatch(readFileSync(path, "utf8"), sink, path);
  }
});

test("subjects page headings use rendered punctuation instead of literal entities", () => {
  const source = readFileSync("src/pages/subjects.astro", "utf8");
  assert.doesNotMatch(source, /&(?:mdash|rsquo);/);
  assert.match(source, /top schools—and narrow to a country you’d actually consider/);
});

test("atlas destination picker uses the shared custom select", () => {
  const source = readFileSync("src/components/CountryDetail.astro", "utf8");
  assert.match(source, /import CustomSelect from ['"]\.\/CustomSelect\.astro['"]/);
  assert.match(source, /<CustomSelect data-country-picker/);
  assert.doesNotMatch(source, /<select data-country-picker/);
  assert.match(source, /picker\.dispatchEvent\(new Event\(['"]change['"]/);
});

test("university comparison feature is removed", () => {
  assert.equal(existsSync("src/pages/compare.astro"), false);
  assert.equal(existsSync("src/lib/shortlist.ts"), false);

  const layout = readFileSync("src/layouts/BaseLayout.astro", "utf8");
  const home = readFileSync("src/pages/index.astro", "utf8");
  const finder = readFileSync("src/pages/finder.astro", "utf8");
  for (const [path, source] of [
    ["BaseLayout.astro", layout],
    ["index.astro", home],
    ["finder.astro", finder],
  ] as const) {
    assert.doesNotMatch(source, /\/compare\/|data-compare|lib\/shortlist/, path);
  }
});

test("finder is subject-first without redundant ranking controls", () => {
  const page = readFileSync("src/pages/finder.astro", "utf8");
  const component = readFileSync("src/components/UniversityFinder.astro", "utf8");

  assert.match(page, /<UniversityFinder/);
  assert.match(component, /data-view-button="subject"/);
  assert.match(component, /data-view-button="overall"/);
  assert.match(component, /data-subject-source/);
  assert.match(component, /data-subject-table/);
  assert.match(component, /fetch\(board\.detailPath/);
  assert.match(component, /Published rank order/);
  assert.doesNotMatch(component, /data-(?:provider|coverage|sort)(?:\s|=)/);
  assert.doesNotMatch(page, /Ranked by|Best coverage|Most rankings/);
});
