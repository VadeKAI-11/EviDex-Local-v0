import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { initializeRequest } from "../api/backend-api";
import { primaryButtonStyle, errorAlertStyle, iconSize, inputStyle as themedInputStyle } from "../styles/tokens";

type StoredRequest = {
  id: string;
  requestText: string;
  organization?: string;
  createdAt: string;
  createdBy?: string;
  status: string;
};

/* ================================================= */
/* Main Form                                         */
/* ================================================= */

export default function EvidenceRequestForm() {
  const navigate = useNavigate();
  const selectedProject =
    sessionStorage.getItem("evidex-organization")?.trim() || "";

  const [evidenceRequest, setEvidenceRequest] = useState("");
  const [category, setCategory] = useState("internal-audit");
  const [auditorEmail] = useState(
    sessionStorage.getItem("userEmail") || ""
  );
  const [auditFromDate, setAuditFromDate] = useState("");
  const [auditToDate, setAuditToDate] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!evidenceRequest.trim()) {
      setError("Please fill in all required fields.");
      return;
    }

    if (!auditorEmail.trim()) {
      setError("User email not found. Please log in again.");
      return;
    }

    if (!selectedProject || selectedProject.toLowerCase() === "unassigned") {
      setError("Please select a project before creating an evidence request.");
      return;
    }

    if (auditFromDate && auditToDate) {
      const fromDate = new Date(auditFromDate);
      const toDate = new Date(auditToDate);
      if (fromDate > toDate) {
        setError("From date cannot be later than To date.");
        return;
      }
    }

    try {
      setIsSubmitting(true);
      setError(null);

      const response = await initializeRequest(
        evidenceRequest.trim(),
        category,
        auditorEmail.trim(),
        undefined,
        "normal",
        selectedProject
      );

      const storedRequests: StoredRequest[] = JSON.parse(
        localStorage.getItem("evidex-requests") || "[]"
      );

      const newRequest: StoredRequest = {
        id: response.request_id,
        requestText: evidenceRequest.trim(),
        organization: selectedProject,
        createdAt: response.created_at,
        createdBy: auditorEmail.trim(),
        status: response.stage,
      };

      const updatedRequests = [
        newRequest,
        ...storedRequests.filter(
          (storedRequest) => storedRequest.id !== response.request_id
        ),
      ];

      localStorage.setItem(
        "evidex-requests",
        JSON.stringify(updatedRequests)
      );

      navigate(`/audit/${response.request_id}?auto=1`);
    } catch (err) {
      let message = err instanceof Error ? err.message : "Failed to submit request";
      if (message.toLowerCase().includes("failed to fetch")) {
        message =
          "Unable to reach the backend API. Check that the backend is running on port 8000 and that CORS allows your frontend origin.";
      }
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {error && (
        <div style={errorAlertStyle}>
          <FontAwesomeIcon icon={faTriangleExclamation} size={iconSize.base} style={{ marginRight: "8px" }} />
          {error}
        </div>
      )}

      <label>
        Category *
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={themedInputStyle}
          required
        >
          <option value="compliance">Compliance</option>
          <option value="financial">Financial</option>
          <option value="internal-audit">Internal Audit</option>
        </select>
      </label>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginTop: 24 }}>
        <label>
          Audit Start Date
          <input
            type="date"
            value={auditFromDate}
            onChange={(e) => setAuditFromDate(e.target.value)}
            style={fieldStyle}
          />
        </label>

        <label>
          Audit End Date
          <input
            type="date"
            value={auditToDate}
            onChange={(e) => setAuditToDate(e.target.value)}
            style={fieldStyle}
            min={auditFromDate}
          />
        </label>
      </div>

      <label style={{ marginTop: 24, display: "block" }}>
        Evidence Request *
        <textarea
          value={evidenceRequest}
          onChange={(e) => setEvidenceRequest(e.target.value)}
          style={{ ...fieldStyle, minHeight: 120 }}
          placeholder="Describe the audit request and evidence needed..."
          required
        />
      </label>

      <button type="submit" style={{ ...primaryButtonStyle, width: "100%", marginTop: "32px", padding: "14px" }} disabled={isSubmitting}>
        {isSubmitting ? "Submitting…" : "Submit Evidence Request"}
      </button>
    </form>
  );
}

/* ================================================= */
/* Styles                                            */
/* ================================================= */

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  marginTop: "8px",
  border: "1px solid var(--evidex-green)",
  borderRadius: "6px",
  background: "var(--card-bg)",
  color: "inherit",
  fontSize: "14px",
  boxSizing: "border-box",
};

