import { defineApp } from "convex/server";
import slack from "@fmaplabs/convex-slack/convex.config.js";

const app = defineApp();
app.use(slack, { httpPrefix: "/comments/" });

export default app;
