/// <reference types="vite/client" />
import { test } from "vitest";
import schema from "./schema.js";
import { convexTest } from "convex-test";
import workpool from "@convex-dev/workpool/test";
export const modules = import.meta.glob("./**/*.*s");

export function initConvexTest() {
  const t = convexTest(schema, modules);
  // The slack component is the test root here, so its nested workpool resolves
  // to the bare path "sendWorkpool" (no parent prefix).
  workpool.register(t, "sendWorkpool");
  return t;
}
test("setup", () => {});
