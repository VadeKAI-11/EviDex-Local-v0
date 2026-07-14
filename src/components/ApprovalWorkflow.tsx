import { useState } from "react";
import {
  approveRequest,
  rejectRequest,
  requestRevision,
} from "../api/backend-api";
import { ApprovalStatus } from "../api/types";
import { useToast } from "../context/ToastContext";
import {
  cardStyle,
  successButtonStyle,
  dangerButtonStyle,
  warningButtonStyle,
  secondaryButtonStyle,
} from "../styles/tokens";

interface ApprovalWorkflowProps {
  requestId: string;
  auditorEmail: string;
  approvalStatus: ApprovalStatus;
  readOnly?: boolean;
  onApprovalChange?: (newStatus: ApprovalStatus) => void;
  onError?: (error: string) => void;
}

export default function ApprovalWorkflow({
  requestId,
  auditorEmail,
  approvalStatus,
  readOnly = false,
  onApprovalChange,
  onError,
}: ApprovalWorkflowProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [showRevisionForm, setShowRevisionForm] = useState(false);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [revisionNotes, setRevisionNotes] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [approvalNotes, setApprovalNotes] = useState("");
  const { showToast } = useToast();

  const isApprovalStage = approvalStatus === ApprovalStatus.PENDING && !readOnly;
  const isApproved = approvalStatus === ApprovalStatus.APPROVED;
  const isRejected = approvalStatus === ApprovalStatus.REJECTED;
  const isRevising = approvalStatus === ApprovalStatus.REVISING;

  async function handleApprove() {
    try {
      setIsProcessing(true);
      await approveRequest(
        requestId,
        auditorEmail,
        approvalNotes
      );
      onApprovalChange?.(ApprovalStatus.APPROVED);
      setApprovalNotes("");
      showToast("Request approved.", "success");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Approval failed";
      onError?.(message);
      showToast(message, "error");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleReject() {
    try {
      setIsProcessing(true);
      await rejectRequest(requestId, auditorEmail, rejectionReason);
      onApprovalChange?.(ApprovalStatus.REJECTED);
      setRejectionReason("");
      setShowRejectForm(false);
      showToast("Request rejected.", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Rejection failed";
      onError?.(message);
      showToast(message, "error");
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleRequestRevision() {
    try {
      setIsProcessing(true);
      await requestRevision(requestId, auditorEmail, revisionNotes);
      onApprovalChange?.(ApprovalStatus.REVISING);
      setRevisionNotes("");
      setShowRevisionForm(false);
      showToast("Revision requested.", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Request failed";
      onError?.(message);
      showToast(message, "error");
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <div style={cardStyle}>
      <h3 style={{ marginTop: 0, marginBottom: "24px", fontSize: "18px", fontWeight: 600 }}>
        Approval Workflow
      </h3>

      {readOnly && (
        <div
          style={{
            marginBottom: "16px",
            padding: "10px 12px",
            borderRadius: "8px",
            border: "1px solid var(--border-color)",
            background: "var(--card-bg-subtle)",
            fontSize: "13px",
            color: "var(--text-muted)",
          }}
        >
          This archived workflow is view-only. Approval actions are disabled.
        </div>
      )}

      {/* Status Badge */}
      <div style={{ marginBottom: "24px" }}>
        <div
          style={{
            display: "inline-block",
            padding: "6px 14px",
            borderRadius: "9999px",
            fontWeight: 600,
            fontSize: "13px",
            background: isApproved
              ? "var(--color-success-bg)"
              : isRejected
                ? "var(--color-danger-bg)"
                : isRevising
                  ? "var(--color-warning-bg)"
                  : "var(--color-info-bg)",
            color: isApproved
              ? "var(--color-success-text)"
              : isRejected
                ? "var(--color-danger-text)"
                : isRevising
                  ? "var(--color-warning-text)"
                  : "var(--color-info-text)",
            border: `1px solid ${
              isApproved
                ? "var(--color-success-border)"
                : isRejected
                  ? "var(--color-danger-border)"
                  : isRevising
                    ? "var(--color-warning-border)"
                    : "var(--color-info-border)"
            }`,
          }}
        >
          {approvalStatus === ApprovalStatus.PENDING
            ? "Pending Approval"
            : approvalStatus === ApprovalStatus.APPROVED
              ? "✓ Approved"
              : approvalStatus === ApprovalStatus.REJECTED
                ? "✗ Rejected"
                : "Requesting Revisions"}
        </div>
      </div>

      {isApprovalStage && (
        <div
          style={{
            background: "var(--card-bg-subtle)",
            border: "1px solid var(--border-color)",
            borderRadius: "8px",
            padding: "24px",
          }}
        >
          <p style={{ margin: "0 0 16px 0", fontSize: "14px", color: "var(--text-muted)" }}>
            Review the audit conclusion and evidence. Choose to approve,
            request revisions, or reject.
          </p>

          {/* Approval Notes */}
          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", marginBottom: "8px", fontSize: "14px", fontWeight: 600 }}>
              Approval Notes (optional)
            </label>
            <textarea
              value={approvalNotes}
              onChange={(e) => setApprovalNotes(e.target.value)}
              placeholder="Add notes about this approval..."
              style={{
                width: "100%",
                minHeight: "80px",
                padding: "10px 12px",
                border: "1px solid var(--border-color)",
                borderRadius: "6px",
                fontFamily: "inherit",
                fontSize: "14px",
                boxSizing: "border-box",
                background: "var(--input-bg)",
                color: "inherit",
                resize: "vertical",
              }}
            />
          </div>

          {/* Action Buttons */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
            {/* Approve Button */}
            <button
              onClick={handleApprove}
              disabled={isProcessing}
              style={{ ...successButtonStyle, opacity: isProcessing ? 0.55 : 1 }}
            >
              {isProcessing ? "Processing..." : "✓ Approve"}
            </button>

            {/* Request Revision Button */}
            <button
              onClick={() => setShowRevisionForm(!showRevisionForm)}
              disabled={isProcessing}
              style={{ ...warningButtonStyle, opacity: isProcessing ? 0.55 : 1 }}
            >
              Request Revisions
            </button>

            {/* Reject Button */}
            <button
              onClick={() => {
                setShowRejectForm((prev) => !prev);
                setShowRevisionForm(false);
                if (!showRejectForm) {
                  setRejectionReason("");
                }
              }}
              disabled={isProcessing}
              style={{ ...dangerButtonStyle, opacity: isProcessing ? 0.55 : 1 }}
            >
              ✗ Reject
            </button>
          </div>

          {showRejectForm && (
            <div
              style={{
                marginTop: "16px",
                padding: "16px",
                background: "var(--color-danger-bg)",
                border: "1px solid var(--color-danger-border)",
                borderRadius: "6px",
              }}
            >
              <label style={{ display: "block", marginBottom: "8px", fontSize: "14px", fontWeight: 600 }}>
                Rejection Reason *
              </label>
              <textarea
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="Describe why this request is being rejected..."
                style={{
                  width: "100%",
                  minHeight: "100px",
                  padding: "10px 12px",
                  border: "1px solid var(--color-danger-border)",
                  borderRadius: "6px",
                  fontFamily: "inherit",
                  fontSize: "14px",
                  boxSizing: "border-box",
                  marginBottom: "12px",
                  background: "transparent",
                  color: "inherit",
                  resize: "vertical",
                }}
              />
              <div style={{ display: "flex", gap: "12px" }}>
                <button
                  onClick={handleReject}
                  disabled={!rejectionReason.trim() || isProcessing}
                  style={{ ...dangerButtonStyle, opacity: !rejectionReason.trim() || isProcessing ? 0.55 : 1 }}
                >
                  Submit Rejection
                </button>
                <button
                  onClick={() => { setShowRejectForm(false); setRejectionReason(""); }}
                  style={secondaryButtonStyle}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Revision Form */}
          {showRevisionForm && (
            <div
              style={{
                marginTop: "16px",
                padding: "16px",
                background: "var(--color-warning-bg)",
                border: "1px solid var(--color-warning-border)",
                borderRadius: "6px",
              }}
            >
              <label style={{ display: "block", marginBottom: "8px", fontSize: "14px", fontWeight: 600 }}>
                Revision Details *
              </label>
              <textarea
                value={revisionNotes}
                onChange={(e) => setRevisionNotes(e.target.value)}
                placeholder="Describe what needs to be revised..."
                style={{
                  width: "100%",
                  minHeight: "100px",
                  padding: "10px 12px",
                  border: "1px solid var(--color-warning-border)",
                  borderRadius: "6px",
                  fontFamily: "inherit",
                  fontSize: "14px",
                  boxSizing: "border-box",
                  marginBottom: "12px",
                  background: "transparent",
                  color: "inherit",
                  resize: "vertical",
                }}
              />
              <div style={{ display: "flex", gap: "12px" }}>
                <button
                  onClick={handleRequestRevision}
                  disabled={!revisionNotes.trim() || isProcessing}
                  style={{ ...warningButtonStyle, opacity: !revisionNotes.trim() || isProcessing ? 0.55 : 1 }}
                >
                  Submit Revision Request
                </button>
                <button
                  onClick={() => { setShowRevisionForm(false); setRevisionNotes(""); }}
                  style={secondaryButtonStyle}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {/* Approved Status */}
      {isApproved && (
        <div
          style={{
            background: "var(--color-success-bg)",
            border: "1px solid var(--color-success-border)",
            borderRadius: "8px",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <p style={{ margin: "0 0 8px 0", fontSize: "28px" }}>✓</p>
          <p style={{ margin: 0, fontSize: "16px", fontWeight: 600, color: "var(--color-success-text)" }}>
            Approved
          </p>
          <p style={{ margin: "8px 0 0 0", fontSize: "13px", color: "var(--text-muted)" }}>
            This audit request has been approved and is ready for export.
          </p>
        </div>
      )}

      {/* Rejected Status */}
      {isRejected && (
        <div
          style={{
            background: "var(--color-danger-bg)",
            border: "1px solid var(--color-danger-border)",
            borderRadius: "8px",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <p style={{ margin: "0 0 8px 0", fontSize: "28px" }}>✗</p>
          <p style={{ margin: 0, fontSize: "16px", fontWeight: 600, color: "var(--color-danger-text)" }}>
            Rejected
          </p>
          <p style={{ margin: "8px 0 0 0", fontSize: "13px", color: "var(--text-muted)" }}>
            This audit request has been rejected.
          </p>
        </div>
      )}

      {/* Revising Status */}
      {isRevising && (
        <div
          style={{
            background: "var(--color-warning-bg)",
            border: "1px solid var(--color-warning-border)",
            borderRadius: "8px",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <p style={{ margin: "0 0 8px 0", fontSize: "28px" }}>⟳</p>
          <p style={{ margin: 0, fontSize: "16px", fontWeight: 600, color: "var(--color-warning-text)" }}>
            Revisions Requested
          </p>
          <p style={{ margin: "8px 0 0 0", fontSize: "13px", color: "var(--text-muted)" }}>
            The auditor has requested revisions to this audit.
          </p>
        </div>
      )}
    </div>
  );
}
