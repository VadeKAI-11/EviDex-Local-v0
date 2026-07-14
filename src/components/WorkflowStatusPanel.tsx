import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { getWorkflowStatus } from "../api/backend-api";
import { WorkflowStage } from "../api/types";
import type { WorkflowStatus } from "../api/types";
import { cardStyle, errorAlertStyle, iconSize } from "../styles/tokens";
import { formatDateTimeDMY } from "../utils/dateTime";

interface WorkflowStatusPanelProps {
  requestId: string;
  autoRefresh?: boolean;
  refreshInterval?: number;
  onEvidenceItemsClick?: () => void;
  footerContent?: ReactNode;
}

const stageColors: Record<WorkflowStage, string> = {
  [WorkflowStage.INITIALIZATION]: "#3b82f6",
  [WorkflowStage.INTERPRETATION]: "#8b5cf6",
  [WorkflowStage.RETRIEVAL]: "#06b6d4",
  [WorkflowStage.VALIDATION]: "#f59e0b",
  [WorkflowStage.CONCLUSION]: "#10b981",
  [WorkflowStage.APPROVAL]: "#ec4899",
  [WorkflowStage.EXPORTED]: "#6b7280",
};

const stageLabels: Record<WorkflowStage, string> = {
  [WorkflowStage.INITIALIZATION]: "Initializing",
  [WorkflowStage.INTERPRETATION]: "Interpreting Request",
  [WorkflowStage.RETRIEVAL]: "Retrieving Evidence",
  [WorkflowStage.VALIDATION]: "Validating Evidence",
  [WorkflowStage.CONCLUSION]: "Generating Conclusion",
  [WorkflowStage.APPROVAL]: "Awaiting Approval",
  [WorkflowStage.EXPORTED]: "Exported",
};

const stageOrder: WorkflowStage[] = [
  WorkflowStage.INITIALIZATION,
  WorkflowStage.INTERPRETATION,
  WorkflowStage.RETRIEVAL,
  WorkflowStage.VALIDATION,
  WorkflowStage.CONCLUSION,
  WorkflowStage.APPROVAL,
  WorkflowStage.EXPORTED,
];

export default function WorkflowStatusPanel({
  requestId,
  autoRefresh = true,
  refreshInterval = 5000,
  onEvidenceItemsClick,
  footerContent,
}: WorkflowStatusPanelProps) {
  const [status, setStatus] = useState<WorkflowStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const statusRef = useRef<WorkflowStatus | null>(null);
  const requestSequenceRef = useRef(0);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    let disposed = false;

    async function fetchStatus() {
      const requestSequence = ++requestSequenceRef.current;

      try {
        if (!statusRef.current) {
          setLoading(true);
        }

        const data = await getWorkflowStatus(requestId);

        if (disposed || requestSequence !== requestSequenceRef.current) {
          return;
        }

        setStatus(data);
        setError(null);
        setRefreshError(null);
      } catch (err) {
        if (disposed || requestSequence !== requestSequenceRef.current) {
          return;
        }

        const message = err instanceof Error ? err.message : "Failed to fetch status";
        if (statusRef.current) {
          // Keep the current UI stable during transient refresh failures.
          setRefreshError(message);
        } else {
          setError(message);
        }
      } finally {
        if (!disposed && requestSequence === requestSequenceRef.current) {
          setLoading(false);
        }
      }
    }

    fetchStatus();

    if (autoRefresh) {
      const interval = setInterval(fetchStatus, refreshInterval);
      return () => {
        disposed = true;
        clearInterval(interval);
      };
    }

    return () => {
      disposed = true;
    };
  }, [requestId, autoRefresh, refreshInterval]);

  if (loading && !status) {
    return (
      <div style={{ ...cardStyle, border: "1px solid var(--border-color)" }}>
        <p style={{ margin: 0, color: "var(--text-muted)" }}>Loading workflow status...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={errorAlertStyle}>
        <FontAwesomeIcon icon={faTriangleExclamation} size={iconSize.base} style={{ marginRight: "8px" }} />
        {error}
      </div>
    );
  }

  if (!status) {
    return (
      <div style={{ ...cardStyle, border: "1px solid var(--border-color)" }}>
        <p style={{ margin: 0, color: "var(--text-muted)" }}>
          No workflow status data available.
        </p>
      </div>
    );
  }

  const currentStageIndex = stageOrder.indexOf(status.current_stage);
  const progressPercentage = ((currentStageIndex + 1) / stageOrder.length) * 100;

  return (
    <div style={cardStyle}>
      <h3 style={{ marginTop: 0, marginBottom: "24px", fontSize: "18px", fontWeight: 600 }}>
        Workflow Status
      </h3>

      {refreshError && (
        <div
          style={{
            marginBottom: "12px",
            padding: "8px 10px",
            borderRadius: "8px",
            border: "1px solid var(--color-warning-border)",
            background: "var(--color-warning-bg)",
            color: "var(--color-warning-text)",
            fontSize: "12px",
          }}
        >
          Live refresh delayed. Showing last known workflow status.
        </div>
      )}

      {/* Current Stage */}
      <div style={{ marginBottom: "24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "50%",
              background: stageColors[status.current_stage],
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "white",
              fontSize: "14px",
              fontWeight: 600,
            }}
          >
            {currentStageIndex + 1}
          </div>
          <div>
            <p style={{ margin: 0, fontWeight: 600 }}>
              {stageLabels[status.current_stage]}
            </p>
            <p style={{ margin: "4px 0 0 0", fontSize: "13px", opacity: 0.7 }}>
              Step {currentStageIndex + 1} of {stageOrder.length}
            </p>
          </div>
        </div>
      </div>

      {/* Progress Bar */}
      <div style={{ marginBottom: "24px" }}>
        <div
          style={{
            width: "100%",
            height: "8px",
            background: "var(--border-color)",
            borderRadius: "4px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${progressPercentage}%`,
              height: "100%",
              background: "#99cc00",
              transition: "width 0.3s ease",
            }}
          />
        </div>
        <p style={{ margin: "8px 0 0 0", fontSize: "12px", opacity: 0.7 }}>
          {progressPercentage.toFixed(0)}% Complete
        </p>
      </div>

      {/* Metrics */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: "12px",
          marginBottom: "24px",
        }}
      >
        <button
          type="button"
          onClick={() => onEvidenceItemsClick?.()}
          style={{
            padding: "12px",
            background: "var(--card-bg-subtle)",
            border: "1px solid var(--border-color)",
            borderRadius: "6px",
            textAlign: "left",
            cursor: onEvidenceItemsClick ? "pointer" : "default",
            color: "inherit",
          }}
          title={onEvidenceItemsClick ? "View evidence list" : undefined}
        >
          <p style={{ margin: 0, fontSize: "12px", color: "var(--text-muted)" }}>
            Evidence Items
          </p>
          <p style={{ margin: "4px 0 0 0", fontSize: "20px", fontWeight: 600 }}>
            {status.evidence_count}
          </p>
        </button>

        <div
          style={{
            padding: "12px",
            background: "var(--card-bg-subtle)",
            border: "1px solid var(--border-color)",
            borderRadius: "6px",
          }}
        >
          <p style={{ margin: 0, fontSize: "12px", color: "var(--text-muted)" }}>
            Step Logs
          </p>
          <p style={{ margin: "4px 0 0 0", fontSize: "20px", fontWeight: 600 }}>
            {status.step_count}
          </p>
        </div>

        <div
          style={{
            padding: "12px",
            background: "var(--card-bg-subtle)",
            border: "1px solid var(--border-color)",
            borderRadius: "6px",
          }}
        >
          <p style={{ margin: 0, fontSize: "12px", color: "var(--text-muted)" }}>
            AI Confidence
          </p>
          <p style={{ margin: "4px 0 0 0", fontSize: "20px", fontWeight: 600 }}>
            {(status.average_confidence * 100).toFixed(0)}%
          </p>
        </div>
      </div>

      {/* Timeline */}
      <div style={{ marginTop: "24px" }}>
        <p
          style={{
            margin: "0 0 12px 0",
            fontSize: "12px",
            fontWeight: 600,
            opacity: 0.7,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
          }}
        >
          Workflow Pipeline
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: "4px",
          }}
        >
          {stageOrder.map((stage, index) => {
            const isCompleted = index < currentStageIndex;
            const isCurrent = index === currentStageIndex;
            const isPending = index > currentStageIndex;

            return (
              <div
                key={stage}
                style={{
                  flex: 1,
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    width: "100%",
                    height: "6px",
                    background: isCompleted || isCurrent
                      ? stageColors[stage]
                      : "var(--border-color)",
                    borderRadius: "3px",
                    marginBottom: "8px",
                    transition: "background 0.3s ease",
                  }}
                />
                <p
                  style={{
                    margin: 0,
                    fontSize: "10px",
                    opacity: isPending ? 0.5 : 1,
                    maxHeight: "30px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={stageLabels[stage]}
                >
                  {stage.charAt(0).toUpperCase() +
                    stage.slice(1).replace("_", " ")}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Timestamps */}
      <div
        style={{
          marginTop: "24px",
          padding: "12px",
          background: "var(--card-bg-subtle)",
          border: "1px solid var(--border-color)",
          borderRadius: "6px",
          fontSize: "12px",
        }}
      >
        <p style={{ margin: "0 0 8px 0", color: "var(--text-muted)" }}>
          <strong>Created:</strong>{" "}
          {formatDateTimeDMY(status.created_at)}
        </p>
        <p style={{ margin: 0, color: "var(--text-muted)" }}>
          <strong>Last Updated:</strong>{" "}
          {formatDateTimeDMY(status.updated_at)}
        </p>
      </div>

      {footerContent && (
        <div style={{ marginTop: "16px" }}>
          {footerContent}
        </div>
      )}
    </div>
  );
}
