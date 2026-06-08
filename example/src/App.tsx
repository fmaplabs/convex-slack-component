import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

const STATUS_LABEL: Record<string, string> = {
  pending: "⏳ pending",
  sent: "✅ sent",
  failed: "❌ failed",
  skipped: "⏭️ skipped",
};

function App() {
  const notifySkip = useMutation(api.example.notifySkip);
  const notifyCancel = useMutation(api.example.notifyCancel);
  const recent = useQuery(api.example.recentNotifications, { limit: 20 });

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
