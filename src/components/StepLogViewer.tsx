import { useCallback, useEffect, useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangleExclamation, faArrowsRotate } from "@fortawesome/free-solid-svg-icons";
import {
  generateConclusion,
  getRequestDetails,
  getStepLogs,
  interpretRequest,
  retrieveEvidence,
  validateEvidence,
} from "../api/backend-api";
import {
  WorkflowStage,
  type ConcludeResponse,
  type RequestDetails,
  type ValidateResponse,
  type WorkflowStepLog,
} from "../api/types";
import { useToast } from "../context/ToastContext";
import { formatDateTimeDMY, formatTimeHM, getDisplayTimeZoneLabel, getDisplayTimeZoneName } from "../utils/dateTime";

interface StepLogViewerProps {
  requestId: string;
  onReplayUpdate?: (update: {
    phase: "start" | "stage-start" | "stage-complete" | "done" | "error";
    stage?: WorkflowStage;
    details?: RequestDetails;
    validation?: ValidateResponse["validation"];
    conclusion?: ConcludeResponse["conclusion"];
    bedrockSummary?: ConcludeResponse["bedrock_summary"];
  }) => void;
}

const agentColors: Record<string, string> = {
  access_agent: "#3b82f6",
  interpretation_agent: "#8b5cf6",
  collection_agent: "#06b6d4",
  validation_agent: "#f59e0b",
  summarization_agent: "#10b981",
  workflow_orchestrator: "#ec4899",
};

function statusColors(status: string) {
  switch (status) {
    case "completed":
      return {
        bg: "var(--color-success-bg, #dcfce7)",
        border: "var(--color-success-border, #86efac)",
        text: "var(--color-success-text, #166534)",
      };
    case "failed":
      return {
        bg: "var(--color-danger-bg, #fee2e2)",
        border: "var(--color-danger-border, #fca5a5)",
        text: "var(--color-danger-text, #991b1b)",
      };
    default:
      return {
        bg: "var(--color-warning-bg, #fef9c3)",
        border: "var(--color-warning-border, #fde047)",
        text: "var(--color-warning-text, #854d0e)",
      };
  }
}

/**
 * Intelligently format output values for display.
 * Converts finding objects and arrays into readable text instead of raw JSON.
 */
function formatOutputValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    // Check if it's an array of finding objects
    if (value.length > 0 && value[0] && typeof value[0] === "object") {
      const first = value[0] as Record<string, unknown>;
      if ("finding" in first || "document" in first) {
        // Format as a list of findings
        return value
          .map((item: unknown) => {
            if (typeof item === "object" && item !== null) {
              const obj = item as Record<string, unknown>;
              if ("finding" in obj && "document" in obj) {
                return `• ${obj.finding}: ${obj.document}`;
              }
              return `• ${JSON.stringify(item)}`;
            }
            return `• ${String(item)}`;
          })
          .join("\n");
      }
    }
    // For other arrays, return compact format
    return `[${value.length} items]`;
  }

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    // Format single finding object
    if ("finding" in obj && "document" in obj) {
      return `${obj.finding}\n${obj.document}`;
    }
    // Format other common object types
    if ("filename" in obj || "evidence_id" in obj) {
      return Object.entries(obj)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
    }
  }

  // Default to JSON for other types
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export default function StepLogViewer({ requestId, onReplayUpdate }: StepLogViewerProps) {
  const { showToast } = useToast();
  const timeZoneLabel = getDisplayTimeZoneLabel();
  const timeZoneName = getDisplayTimeZoneName();
  const [steps, setSteps] = useState<WorkflowStepLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedStepGroups, setExpandedStepGroups] = useState<Set<string>>(new Set());

  const toggleExpandedGroup = useCallback((groupKey: string) => {
    setExpandedStepGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }, []);

  const stepGroups = useMemo(() => {
    type StepGroup = {
      groupKey: string;
      stepName: string;
      agentName: string;
      attempts: WorkflowStepLog[];
    };

    const groupsByKey = new Map<string, StepGroup>();
    const orderedGroups: StepGroup[] = [];

    steps.forEach((step) => {
      const groupKey = step.step_name;
      let group = groupsByKey.get(groupKey);

      if (!group) {
        group = {
          groupKey,
          stepName: step.step_name,
          agentName: step.agent_name,
          attempts: [],
        };
        groupsByKey.set(groupKey, group);
        orderedGroups.push(group);
      }

      group.attempts.push(step);
    });

    return orderedGroups;
  }, [steps]);

  const fetchLogs = useCallback(
    async (isManualRefresh = false) => {
      try {
        if (isManualRefresh) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }
        const logs = await getStepLogs(requestId);
        setSteps(logs);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch logs");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [requestId]
  );

  const runRefreshReplay = useCallback(async () => {
    try {
      setRefreshing(true);
      setError(null);
      setRefreshStatus("Checking current workflow stage...");
      showToast("Refreshing process traceability steps...", "info");
      onReplayUpdate?.({ phase: "start" });

      let latestLogs = await getStepLogs(requestId);
      setSteps(latestLogs);
      let previousStepIds = new Set(latestLogs.map((step) => step.step_id));

      let details = await getRequestDetails(requestId);
      let currentStage = details.current_stage;
      const maxTransitions = 6;
      let transitions = 0;

      while (transitions < maxTransitions) {
        if (
          currentStage === WorkflowStage.CONCLUSION ||
          currentStage === WorkflowStage.APPROVAL ||
          currentStage === WorkflowStage.EXPORTED
        ) {
          break;
        }

        const stageBefore = currentStage;
        transitions += 1;
        let completedStage: WorkflowStage | null = null;
        let completedValidation: ValidateResponse["validation"] | undefined;
        let completedConclusion: ConcludeResponse["conclusion"] | undefined;
        let completedBedrockSummary: ConcludeResponse["bedrock_summary"] | undefined;

        if (currentStage === WorkflowStage.INITIALIZATION) {
          setRefreshStatus("Refreshing interpretation step...");
          onReplayUpdate?.({ phase: "stage-start", stage: WorkflowStage.INTERPRETATION });
          await interpretRequest(requestId);
          showToast("Interpretation refreshed.", "success");
          completedStage = WorkflowStage.INTERPRETATION;
        } else if (currentStage === WorkflowStage.INTERPRETATION) {
          setRefreshStatus("Refreshing retrieval step...");
          onReplayUpdate?.({ phase: "stage-start", stage: WorkflowStage.RETRIEVAL });
          await retrieveEvidence(requestId, []);
          showToast("Retrieval refreshed.", "success");
          completedStage = WorkflowStage.RETRIEVAL;
        } else if (currentStage === WorkflowStage.RETRIEVAL) {
          setRefreshStatus("Refreshing validation step...");
          onReplayUpdate?.({ phase: "stage-start", stage: WorkflowStage.VALIDATION });
          const validationResponse = await validateEvidence(requestId);
          showToast("Validation refreshed.", "success");
          completedStage = WorkflowStage.VALIDATION;
          completedValidation = validationResponse.validation;
        } else if (currentStage === WorkflowStage.VALIDATION) {
          setRefreshStatus("Refreshing conclusion step...");
          onReplayUpdate?.({ phase: "stage-start", stage: WorkflowStage.CONCLUSION });
          const conclusionResponse = await generateConclusion(requestId);
          showToast("Conclusion refreshed.", "success");
          completedStage = WorkflowStage.CONCLUSION;
          completedConclusion = conclusionResponse.conclusion;
          completedBedrockSummary = conclusionResponse.bedrock_summary;
        } else {
          break;
        }

        latestLogs = await getStepLogs(requestId);
        const hasLogChanges =
          latestLogs.length !== previousStepIds.size ||
          latestLogs.some((step) => !previousStepIds.has(step.step_id));

        if (hasLogChanges) {
          setSteps(latestLogs);
        }

        previousStepIds = new Set(latestLogs.map((step) => step.step_id));
        details = await getRequestDetails(requestId);
        currentStage = details.current_stage;

        if (completedStage) {
          onReplayUpdate?.({
            phase: "stage-complete",
            stage: completedStage,
            details,
            validation: completedValidation,
            conclusion: completedConclusion,
            bedrockSummary: completedBedrockSummary,
          });
        }

        if (currentStage === stageBefore && completedStage) {
          // Backend status reads can be briefly stale right after a successful
          // stage call. Infer next stage so replay can continue to completion.
          if (completedStage === WorkflowStage.INTERPRETATION) {
            currentStage = WorkflowStage.RETRIEVAL;
          } else if (completedStage === WorkflowStage.RETRIEVAL) {
            currentStage = WorkflowStage.VALIDATION;
          } else if (completedStage === WorkflowStage.VALIDATION) {
            currentStage = WorkflowStage.CONCLUSION;
          }
        }

        if (currentStage === stageBefore) {
          // No transition observed even after inference; stop replay.
          break;
        }
      }

      if (currentStage === WorkflowStage.CONCLUSION || currentStage === WorkflowStage.APPROVAL || currentStage === WorkflowStage.EXPORTED) {
        setRefreshStatus("Step logs are up to date to the end of the workflow.");
        showToast("Step logs refreshed through the final workflow stage.", "success");
      } else {
        setRefreshStatus("Refresh completed. No further step changes detected.");
        showToast("Refresh completed. No further step changes detected.", "info");
      }
      onReplayUpdate?.({ phase: "done", details });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh and replay workflow");
      setRefreshStatus(null);
      showToast("Step log refresh failed.", "error");
      onReplayUpdate?.({ phase: "error" });
    } finally {
      setRefreshing(false);
    }
  }, [requestId, showToast, onReplayUpdate]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  if (loading && steps.length === 0) {
    return (
      <div
        style={{
          padding: "24px",
          border: "2px solid var(--border-color)",
          borderRadius: "12px",
          background: "var(--card-bg)",
          color: "var(--text-muted)",
        }}
      >
        Loading step logs...
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          padding: "16px",
          border: "1px solid var(--color-danger-border)",
          borderRadius: "12px",
          background: "var(--color-danger-bg)",
          color: "var(--color-danger-text)",
        }}
      >
        <FontAwesomeIcon icon={faTriangleExclamation} style={{ marginRight: "8px" }} />
        {error}
      </div>
    );
  }

  return (
    <div
      style={{
        border: "2px solid var(--evidex-green)",
        borderRadius: "12px",
        padding: "24px",
        background: "var(--card-bg)",
        color: "var(--text-color)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "24px",
        }}
      >
        <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>
          Process Traceability — Step Logs
        </h3>
        <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              fontSize: "10px",
              fontWeight: 700,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
              border: "1px solid var(--border-color)",
              borderRadius: "999px",
              padding: "3px 8px",
              lineHeight: 1,
            }}
            title={`Times shown in ${timeZoneName}`}
          >
            {timeZoneLabel}
          </span>
          <button
            type="button"
            onClick={() => void runRefreshReplay()}
            disabled={refreshing}
            title="Refresh and replay workflow step logs"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 12px",
              border: "1px solid var(--border-color)",
              borderRadius: "6px",
              background: "transparent",
              color: "var(--text-color)",
              cursor: refreshing ? "not-allowed" : "pointer",
              fontSize: "13px",
              opacity: refreshing ? 0.6 : 1,
            }}
          >
            <FontAwesomeIcon
              icon={faArrowsRotate}
              style={{
                animation: refreshing ? "evidex-spin 0.8s linear infinite" : "none",
              }}
            />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {refreshStatus && (
        <div
          style={{
            marginBottom: "12px",
            color: "var(--text-muted)",
            fontSize: "12px",
          }}
        >
          {refreshStatus}
        </div>
      )}

      <style>{`
        @keyframes evidex-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>

      {steps.length === 0 ? (
        <p style={{ color: "var(--text-muted)" }}>No steps logged yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {stepGroups.map((group, idx) => {
            const latestAttempt = group.attempts[group.attempts.length - 1];
            const agentColor = agentColors[group.agentName] || "var(--evidex-green)";
            const isExpanded = expandedStepGroups.has(group.groupKey);
            const sc = statusColors(latestAttempt.status);
            const isLast = idx === stepGroups.length - 1;

            return (
              <div key={group.groupKey} style={{ display: "flex", gap: "0" }}>
                {/* Flow spine */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    width: "36px",
                    flexShrink: 0,
                  }}
                >
                  {/* Circle node */}
                  <div
                    style={{
                      width: "14px",
                      height: "14px",
                      borderRadius: "50%",
                      background: agentColor,
                      border: "2px solid var(--card-bg)",
                      boxShadow: `0 0 0 2px ${agentColor}`,
                      flexShrink: 0,
                      marginTop: "18px",
                      zIndex: 1,
                    }}
                  />
                  {/* Connector line */}
                  {!isLast && (
                    <div
                      style={{
                        width: "2px",
                        flex: 1,
                        background: "var(--border-color)",
                        marginTop: "4px",
                        marginBottom: "4px",
                      }}
                    />
                  )}
                </div>

                {/* Card */}
                <div
                  style={{
                    flex: 1,
                    marginBottom: isLast ? 0 : "12px",
                    border: `1px solid ${isExpanded ? agentColor : "var(--border-color)"}`,
                    borderRadius: "10px",
                    overflow: "hidden",
                    background: "var(--bg-color)",
                    transition: "border-color 0.15s",
                  }}
                >
                  {/* Card header — click to expand */}
                  <button
                    type="button"
                    onClick={() => toggleExpandedGroup(group.groupKey)}
                    style={{
                      width: "100%",
                      padding: "14px 16px",
                      border: "none",
                      background: isExpanded
                        ? "var(--card-bg)"
                        : "transparent",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      textAlign: "left",
                      color: "var(--text-color)",
                    }}
                  >
                    {/* Step number */}
                    <div
                      style={{
                        width: "24px",
                        height: "24px",
                        borderRadius: "6px",
                        background: agentColor,
                        color: "#fff",
                        fontSize: "11px",
                        fontWeight: 700,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {idx + 1}
                    </div>

                    {/* Name + meta */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: "14px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {group.stepName}
                      </div>
                      <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                        {group.agentName}
                        {" · "}
                        {group.attempts.length} run(s)
                        {" · "}
                        Last run {formatTimeHM(latestAttempt.timestamp)}
                      </div>
                    </div>

                    {/* Status badge + confidence */}
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
                      <div style={{ textAlign: "right" }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "3px 8px",
                            borderRadius: "20px",
                            fontSize: "11px",
                            fontWeight: 600,
                            background: sc.bg,
                            border: `1px solid ${sc.border}`,
                            color: sc.text,
                          }}
                        >
                          {latestAttempt.status}
                        </span>
                        <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "3px" }}>
                          {(latestAttempt.confidence_score * 100).toFixed(0)}% conf.
                        </div>
                      </div>
                      <span
                        style={{
                          fontSize: "12px",
                          color: "var(--text-muted)",
                          transition: "transform 0.2s",
                          display: "inline-block",
                          transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                        }}
                      >
                        ▼
                      </span>
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div
                      style={{
                        borderTop: "1px solid var(--border-color)",
                        padding: "16px",
                        background: "var(--card-bg)",
                        display: "flex",
                        flexDirection: "column",
                        gap: "14px",
                      }}
                    >
                      <div style={sectionLabelStyle}>Attempts ({group.attempts.length})</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        {group.attempts.map((attempt, attemptIdx) => (
                          <div
                            key={attempt.step_id}
                            style={{
                              border: "1px solid var(--border-color)",
                              borderRadius: "8px",
                              background: "var(--bg-color)",
                              padding: "12px",
                              display: "flex",
                              flexDirection: "column",
                              gap: "12px",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "10px",
                                flexWrap: "wrap",
                              }}
                            >
                              <div style={{ fontSize: "12px", fontWeight: 600 }}>
                                Attempt {attemptIdx + 1}
                              </div>
                              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                                {formatDateTimeDMY(attempt.timestamp)} · {attempt.execution_time_ms} ms
                              </div>
                            </div>

                            <div>
                              <div style={sectionLabelStyle}>Action</div>
                              <div style={{ ...detailBoxStyle, background: "var(--card-bg)" }}>
                                {attempt.action_taken}
                              </div>
                            </div>

                            {attempt.inputs && attempt.inputs.length > 0 && (
                              <div>
                                <div style={sectionLabelStyle}>Inputs ({attempt.inputs.length})</div>
                                <div style={kvGridStyle}>
                                  {attempt.inputs.map((input, inputIdx) => (
                                    <div key={inputIdx} style={{ ...detailBoxStyle, background: "var(--card-bg)" }}>
                                      <div style={{ fontWeight: 600, fontSize: "11px", color: "var(--text-muted)" }}>{input.key}</div>
                                      <div style={{ fontFamily: "monospace", fontSize: "11px", wordBreak: "break-all", marginTop: "3px", whiteSpace: "pre-wrap" }}>
                                        {formatOutputValue(input.value)}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {attempt.outputs && attempt.outputs.length > 0 && (
                              <div>
                                <div style={sectionLabelStyle}>Outputs ({attempt.outputs.length})</div>
                                <div style={kvGridStyle}>
                                  {attempt.outputs.map((output, outputIdx) => (
                                    <div key={outputIdx} style={{ ...detailBoxStyle, background: "var(--card-bg)" }}>
                                      <div style={{ fontWeight: 600, fontSize: "11px", color: "var(--evidex-green)" }}>{output.key}</div>
                                      <div style={{ fontFamily: "monospace", fontSize: "11px", wordBreak: "break-all", marginTop: "3px", whiteSpace: "pre-wrap" }}>
                                        {formatOutputValue(output.value)}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {attempt.error_message && (
                              <div
                                style={{
                                  padding: "10px 12px",
                                  borderRadius: "6px",
                                  background: "var(--color-danger-bg)",
                                  border: "1px solid var(--color-danger-border)",
                                  color: "var(--color-danger-text)",
                                  fontSize: "12px",
                                }}
                              >
                                <div style={{ fontWeight: 600 }}>Error</div>
                                <div style={{ marginTop: "4px" }}>{attempt.error_message}</div>
                              </div>
                            )}

                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: "1fr 1fr",
                                gap: "8px",
                                padding: "10px 12px",
                                borderRadius: "6px",
                                border: "1px solid var(--border-color)",
                                background: "var(--card-bg)",
                                fontSize: "11px",
                                color: "var(--text-muted)",
                              }}
                            >
                              <span><strong>Step ID:</strong> {attempt.step_id}</span>
                              <span><strong>Status:</strong> {attempt.status}</span>
                              <span><strong>Timestamp:</strong> {formatDateTimeDMY(attempt.timestamp)}</span>
                              <span><strong>Execution Time:</strong> {attempt.execution_time_ms} ms</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const sectionLabelStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  color: "var(--text-muted)",
  marginBottom: "6px",
};

const detailBoxStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: "6px",
  border: "1px solid var(--border-color)",
  fontSize: "13px",
  lineHeight: 1.45,
};

const kvGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "8px",
};
