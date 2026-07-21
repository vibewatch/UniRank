import { test } from "node:test";
import assert from "node:assert/strict";

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
