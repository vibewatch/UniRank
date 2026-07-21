import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
