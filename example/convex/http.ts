import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { slack } from "./example.js";

// The app owns its HTTP routes and mounts the Slack component's handlers itself
// (the resend pattern) — no httpPrefix indirection. Paths are entirely up to
// you; keep `oauth_redirect` a sibling of `install` (and register that callback
// URL in your Slack app config).
const http = httpRouter();

http.route({
  path: "/slack/install",
  method: "GET",
  handler: httpAction((ctx, req) => slack.handleInstall(ctx, req)),
});

http.route({
  path: "/slack/oauth_redirect",
  method: "GET",
  handler: httpAction((ctx, req) => slack.handleOAuthRedirect(ctx, req)),
});

// Demo: most recent send as JSON (previously the component's built-in /last).
http.route({
  path: "/slack/last",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const recent = await slack.listRecent(ctx, 1);
    return new Response(JSON.stringify(recent[0] ?? null), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
