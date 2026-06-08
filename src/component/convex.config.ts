import { defineComponent } from "convex/server";
import { v } from "convex/values";
import workpool from "@convex-dev/workpool/convex.config.js";

// Declared component env vars. These are *not* read from the app's
// `process.env` — the app binds its own deployment vars to these by reference
// in `app.use(slack, { env: { ... } })`. Convex makes the bound values
// available to this component's functions via `process.env.SLACK_*`.
// All optional so an unconfigured deployment is a silent no-op.
const component = defineComponent("slack", {
  env: {
    SLACK_WEBHOOK_URL: v.optional(v.string()),
    SLACK_BOT_TOKEN: v.optional(v.string()),
    SLACK_DEFAULT_CHANNEL: v.optional(v.string()),
    // OAuth "Add to Slack" installation flow (all optional → unconfigured = no-op).
    SLACK_CLIENT_ID: v.optional(v.string()),
    SLACK_CLIENT_SECRET: v.optional(v.string()),
    SLACK_SCOPES: v.optional(v.string()), // comma-separated bot scopes
    SLACK_INSTALL_SUCCESS_URL: v.optional(v.string()), // post-install redirect
  },
});

// Child workpool for durable, retried delivery of `send`.
// (`@convex-dev/resend` nests a workpool the same way.)
component.use(workpool, { name: "sendWorkpool" });

export default component;
