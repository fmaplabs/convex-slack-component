import "./App.css";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

const STATUS_LABEL: Record<string, string> = {
  pending: "⏳ pending",
  sent: "✅ sent",
  failed: "❌ failed",
  skipped: "⏭️ skipped",
};

// HTTP Actions live on the `.convex.site` origin; the React client is given the
// `.convex.cloud` URL. Derive the install link from it.
const SITE_URL = (import.meta.env.VITE_CONVEX_URL as string | undefined)?.replace(
  ".convex.cloud",
  ".convex.site",
);
const INSTALL_URL = SITE_URL ? `${SITE_URL}/slack/install` : undefined;

function App() {
  const notifySkip = useMutation(api.example.notifySkip);
  const notifyCancel = useMutation(api.example.notifyCancel);
  const notifyOAuth = useMutation(api.example.notifyOAuth);
  const recent = useQuery(api.example.recentNotifications, { limit: 20 });
  const [teamId, setTeamId] = useState("");

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", textAlign: "left" }}>
      <h1>Slack component — lifecycle demo</h1>
      <p style={{ color: "#444" }}>
        Fire a sample subscription event. With no <code>SLACK_*</code> env var
        set, sends are a silent no-op (nothing is written). Set{" "}
        <code>SLACK_WEBHOOK_URL</code> (or <code>SLACK_BOT_TOKEN</code> +{" "}
        <code>SLACK_DEFAULT_CHANNEL</code>) with{" "}
        <code>npx convex env set</code> to post for real.
      </p>

      <div style={{ display: "flex", gap: "0.75rem", margin: "1.25rem 0" }}>
        <button
          onClick={() => void notifySkip({})}
          style={{
            padding: "0.6rem 1.1rem",
            background: "#0b6b3a",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          ⏭️ Notify “cycle skipped”
        </button>
        <button
          onClick={() => void notifyCancel({})}
          style={{
            padding: "0.6rem 1.1rem",
            background: "#9b1c1c",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          🛑 Notify “cancelled”
        </button>
      </div>

      <h2 style={{ fontSize: "1.1rem" }}>OAuth installation</h2>
      <p style={{ color: "#444" }}>
        Set <code>SLACK_CLIENT_ID</code>, <code>SLACK_CLIENT_SECRET</code>, and{" "}
        <code>SLACK_SCOPES</code> (e.g. <code>chat:write</code>), register{" "}
        <code>{SITE_URL ? `${SITE_URL}/slack/oauth_redirect` : "<site>/slack/oauth_redirect"}</code>{" "}
        as your Slack app's redirect URL, then click below to install into a
        workspace. After installing, paste that workspace's team id (e.g.{" "}
        <code>T0123ABCD</code>) to send a message with its own bot token.
      </p>

      <div style={{ display: "flex", gap: "0.75rem", margin: "1rem 0", flexWrap: "wrap", alignItems: "center" }}>
        {INSTALL_URL ? (
          <a
            href={INSTALL_URL}
            style={{
              padding: "0.6rem 1.1rem",
              background: "#4a154b",
              color: "#fff",
              borderRadius: 6,
              textDecoration: "none",
            }}
          >
            ➕ Add to Slack
          </a>
        ) : (
          <span style={{ color: "#9b1c1c" }}>VITE_CONVEX_URL not set</span>
        )}
        <input
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          placeholder="Team id (e.g. T0123ABCD)"
          style={{
            padding: "0.55rem 0.7rem",
            border: "1px solid #b0b0b0",
            borderRadius: 6,
            minWidth: 220,
          }}
        />
        <button
          disabled={teamId.trim() === ""}
          onClick={() => void notifyOAuth({ teamId: teamId.trim() })}
          style={{
            padding: "0.6rem 1.1rem",
            background: teamId.trim() === "" ? "#9aa0a6" : "#1264a3",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: teamId.trim() === "" ? "not-allowed" : "pointer",
          }}
        >
          📨 Send via OAuth
        </button>
      </div>

      <h2 style={{ fontSize: "1.1rem" }}>Recent sends</h2>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {recent?.map((m) => (
          <li
            key={m._id}
            style={{
              padding: "0.6rem 0.75rem",
              marginBottom: "0.5rem",
              border: "1px solid #d0d0d0",
              borderRadius: 6,
              display: "flex",
              justifyContent: "space-between",
              gap: "1rem",
            }}
          >
            <span style={{ color: "#222" }}>
              {m.text?.split("\n")[0] ?? "(no text)"}
            </span>
            <span style={{ color: "#555", whiteSpace: "nowrap" }}>
              {STATUS_LABEL[m.status] ?? m.status}
              {m.transport ? ` · ${m.transport}` : ""}
            </span>
          </li>
        ))}
        {recent?.length === 0 && (
          <li style={{ color: "#666", fontStyle: "italic" }}>
            No sends yet — click a button above.
          </li>
        )}
      </ul>
    </main>
  );
}

export default App;
