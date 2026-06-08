/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      enqueue: FunctionReference<
        "mutation",
        "internal",
        {
          blocks?: any;
          channel?: string;
          idempotencyKey?: string;
          text?: string;
          transport?: "webhook" | "botToken";
        },
        string | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { limit?: number },
        Array<{
          _creationTime: number;
          _id: string;
          blocks?: any;
          channel?: string;
          error?: string;
          httpStatus?: number;
          idempotencyKey?: string;
          slackTs?: string;
          status: "pending" | "sent" | "failed" | "skipped";
          text?: string;
          transport: "webhook" | "botToken";
          workId?: string;
        }>,
        Name
      >;
    };
  };
