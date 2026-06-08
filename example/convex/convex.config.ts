import { defineApp } from "convex/server";
import { v } from "convex/values";
import slack from "@fmaplabs/convex-slack/convex.config.js";

// The app declares its own deployment env vars...
const app = defineApp({
  env: {
    SLACK_WEBHOOK_URL: v.optional(v.string()),
    SLACK_BOT_TOKEN: v.optional(v.string()),
    SLACK_DEFAULT_CHANNEL: v.optional(v.string()),
  },
});

// ...and binds them to the component's declared env vars *by reference*
// (live, not a snapshot — set them later with `npx convex env set`).
app.use(slack, {
  httpPrefix: "/slack/",
  env: {
    SLACK_WEBHOOK_URL: app.env.SLACK_WEBHOOK_URL,
    SLACK_BOT_TOKEN: app.env.SLACK_BOT_TOKEN,
    SLACK_DEFAULT_CHANNEL: app.env.SLACK_DEFAULT_CHANNEL,
  },
});

export default app;
