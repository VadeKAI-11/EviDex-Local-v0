import EvidenceRequestForm from "../components/EvidenceRequestForm";
import RecentRequestsPanel from "../components/RecentRequestsPanel";

export default function NewEvidenceRequestPage() {
  return (
    <div
      style={{
        maxWidth: "1200px",
        height: "calc(100vh - 64px)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <h1 style={{ marginBottom: "6px", marginTop: 0 }}>New Evidence Request</h1>

      <p
        style={{
          marginTop: 0,
          marginBottom: "18px",
          color: "var(--text-muted)",
          lineHeight: 1.6,
          maxWidth: "800px",
        }}
      >
        Submit a request for audit evidence. EviDex will interpret the request
        and evaluate supplied documentation using an agent‑based workflow.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "7fr 3fr",
          gap: "20px",
          alignItems: "stretch",
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* Left: Evidence Request Form */}
        <div
          style={{
            border: "2px solid var(--evidex-green)",
            borderRadius: "12px",
            padding: "22px",
            background: "var(--card-bg)",
            overflowY: "auto",
            minHeight: 0,
          }}
        >
          <EvidenceRequestForm />
        </div>

        {/* Right: Recent Requests */}
        <div style={{ minHeight: 0, overflowY: "auto" }}>
          <RecentRequestsPanel />
        </div>
      </div>
    </div>
  );
}