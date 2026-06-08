/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import workpool from "@convex-dev/workpool/test";
import schema from "./component/schema.js";
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component (and its nested workpool) with a convex-test instance.
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name the component is mounted as in convex.config.ts.
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "slack",
) {
  t.registerComponent(name, schema, modules);
  // When slack is mounted under `name`, its child workpool resolves to
  // `${name}/sendWorkpool` (convex-test prefixes child paths with the parent's).
  workpool.register(t, `${name}/sendWorkpool`);
}
export default { register, schema, modules };
