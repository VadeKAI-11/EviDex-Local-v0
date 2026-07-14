import { useParams, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import WorkflowStatusPanel from "../components/WorkflowStatusPanel";
import StepLogViewer from "../components/StepLogViewer";
import AgentTimelinePanel from "../components/AgentTimelinePanel";
import AskAgentWhyPanel from "../components/AskAgentWhyPanel";
import { getRequestDetails } from "../api/backend-api";
import type { RequestDetails } from "../api/types";
import { getStoredRequests, moveRequestToArchive } from "../utils/recycleBin";
import { useToast } from "../context/ToastContext";
import RequestActions from "../components/RequestActions";
import ArchiveConfirmationModal from "../components/ArchiveConfirmationModal";
import { formatDateTimeDMY } from "../utils/dateTime";

export default function EvidenceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [request, setRequest] = useState<RequestDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);

  useEffect(() => {
    if (!id) return;
    const currentRequestId: string = id;

    async function fetchRequest() {
      try {
        setLoading(true);
        const data = await getRequestDetails(currentRequestId);
        setRequest(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load request");
        setLoading(false);
      } finally {
        setLoading(false);
      }
    }

    fetchRequest();
  }, [id]);

  function handleArchiveRequest() {
    if (!id) {
      showToast("No request selected to archive.", "error");
      return;
    }

    const requestExists = getStoredRequests().some((entry) => entry.id === id);
    if (!requestExists) {
      showToast("Request is not available in local history to archive.", "error");
      return;
    }

    moveRequestToArchive(id, sessionStorage.getItem("userEmail") || "");
    showToast("Request archived.", "success");
    navigate("/archive");
  }

  if (loading) return <div style={{ maxWidth: "1200px", margin: "48px auto" }}>Loading...</div>;
  if (error) return <div style={{ maxWidth: "1200px", margin: "48px auto", color: "#991b1b" }}>Error: {error}</div>;
  if (!request || !id) return <div style={{ maxWidth: "1200px", margin: "48px auto" }}>Request not found.</div>;

  return (
    <div style={{ maxWidth: "1200px", margin: "48px auto", padding: "0 24px" }}>
      {/* Header */}
      <div style={{ marginBottom: "32px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "16px" }}>
          <h1 style={{ margin: 0 }}>Evidence Details</h1>
          <button
            onClick={() => navigate(`/audit/${id}`)}
            style={{
              padding: "8px 16px",
              background: "#99cc00",
              color: "white",
              border: "none",
              borderRadius: "6px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            → Go to Workflow
          </button>
          <RequestActions
            onArchive={() => setShowArchiveConfirm(true)}
            archiveTitle="Archive this request"
          />
        </div>
        <p style={{ margin: "0 0 8px 0", opacity: 0.7 }}>{request.request_text}</p>
        <p style={{ margin: 0, fontSize: "13px", opacity: 0.6 }}>
          ID: <strong>{id}</strong> • Category: <strong>{request.category}</strong> • Stage: <strong>{request.current_stage}</strong>
        </p>
      </div>

      {/* Main Content Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px", marginBottom: "24px" }}>
        <WorkflowStatusPanel requestId={id} />
        <div
          style={{
            border: "2px solid #99cc00",
            borderRadius: "12px",
            padding: "24px",
            background: "#fafbf7",
          }}
        >
          <h3 style={{ marginTop: 0, marginBottom: "16px", fontSize: "18px", fontWeight: 600 }}>
            Request Information
          </h3>
          <div style={{ display: "grid", gap: "12px" }}>
            <div>
              <p style={{ margin: 0, fontSize: "12px", opacity: 0.7, fontWeight: 600 }}>Request ID</p>
              <p style={{ margin: "4px 0 0 0", fontFamily: "monospace" }}>{id}</p>
            </div>
            <div>
              <p style={{ margin: 0, fontSize: "12px", opacity: 0.7, fontWeight: 600 }}>Auditor</p>
              <p style={{ margin: "4px 0 0 0" }}>{request.auditor_email}</p>
            </div>
            <div>
              <p style={{ margin: 0, fontSize: "12px", opacity: 0.7, fontWeight: 600 }}>Category</p>
              <p style={{ margin: "4px 0 0 0", textTransform: "capitalize" }}>{request.category}</p>
            </div>
            <div>
              <p style={{ margin: 0, fontSize: "12px", opacity: 0.7, fontWeight: 600 }}>Evidence Count</p>
              <p style={{ margin: "4px 0 0 0" }}>{request.evidence_count ?? 0} items</p>
            </div>
            <div>
              <p style={{ margin: 0, fontSize: "12px", opacity: 0.7, fontWeight: 600 }}>Created</p>
              <p style={{ margin: "4px 0 0 0", fontSize: "13px" }}>{formatDateTimeDMY(request.created_at)}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Step Logs */}
      <div style={{ marginBottom: "24px" }}>
        <StepLogViewer requestId={id} />
      </div>

      {/* Agent Panels */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
        <AgentTimelinePanel requestId={id} />
        <AskAgentWhyPanel requestId={id} />
      </div>

      {showArchiveConfirm && (
        <ArchiveConfirmationModal
          onCancel={() => setShowArchiveConfirm(false)}
          onConfirm={() => {
            setShowArchiveConfirm(false);
            handleArchiveRequest();
          }}
        />
      )}
    </div>
  );
}