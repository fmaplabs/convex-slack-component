import { httpRouter } from "convex/server";
import { api } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";

const http = httpRouter();

http.route({
  // Mounted under the app's httpPrefix, as defined in the app's convex.config.ts.
  path: `/last`,
  method: "GET",
  handler: httpAction(async (ctx) => {
    const messages = await ctx.runQuery(api.lib.list, { limit: 1 });
    const last = messages[0] ?? null;
    return new Response(JSON.stringify(last), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
