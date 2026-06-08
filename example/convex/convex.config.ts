import { defineApp } from "convex/server";
import { v } from "convex/values";
import slack from "@fmaplabs/convex-slack/convex.config.js";

// The app declares its own deployment env vars...
const app = defineApp({
  env: {
    SLACK_WEBHOOK_URL: v.optional(v.string()),
    SLACK_BOT_TOKEN: v.optional(v.string()),
    SLACK_DEFAULT_CHANNEL: v.optional(v.string()),
    SLACK_CLIENT_ID: v.optional(v.string()),
    SLACK_CLIENT_SECRET: v.optional(v.string()),
    SLACK_SCOPES: v.optional(v.string()),
    SLACK_INSTALL_SUCCESS_URL: v.optional(v.string()),
  },
});

// ...and binds them to the component's declared env vars *by reference*
// (live, not a snapshot — set them later with `npx convex env set`).
app.use(slack, {
  // No httpPrefix: the app mounts the component's HTTP handlers itself in
  // convex/http.ts via the Slack client (slack.handleInstall / ...).
  env: {
    SLACK_WEBHOOK_URL: app.env.SLACK_WEBHOOK_URL,
    SLACK_BOT_TOKEN: app.env.SLACK_BOT_TOKEN,
    SLACK_DEFAULT_CHANNEL: app.env.SLACK_DEFAULT_CHANNEL,
    SLACK_CLIENT_ID: app.env.SLACK_CLIENT_ID,
    SLACK_CLIENT_SECRET: app.env.SLACK_CLIENT_SECRET,
    SLACK_SCOPES: app.env.SLACK_SCOPES,
    SLACK_INSTALL_SUCCESS_URL: app.env.SLACK_INSTALL_SUCCESS_URL,
  },
});

export default app;
