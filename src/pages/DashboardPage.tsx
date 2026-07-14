import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { getStepLogs } from "../api/backend-api";
import {
  faCheckCircle,
  faChartLine,
  faClipboardList,
  faClock,
  faListCheck,
  faPlus,
} from "@fortawesome/free-solid-svg-icons";
import {
  cardStyle,
  inputStyle,
  primaryButtonStyle,
  iconSize,
} from "../styles/tokens";
import { getStoredRequests } from "../utils/recycleBin";

const RECENT_ACTIVITY_LIMIT = 7;

type RequestItem = {
  id: string;
  createdAt: string;
  updatedAt?: string;
  approvedAt?: string;
  deletedAt?: string;
  archivedAt?: string;
  approval_status?: string;
  status: string;
  organization?: string;
  isDeleted?: boolean;
  isArchived?: boolean;
};

type ActivityItem = {
  message: string;
  timestamp: number;
};

function readJsonFromStorage<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") as T | null;
  } catch {
    return null;
  }
}

type ProjectRequestFilter = "all" | "approved" | "pending";

export default function DashboardPage() {
  const navigate = useNavigate();

  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [avgConfidence, setAvgConfidence] = useState<number | null>(null);
  const [avgProcessingTime, setAvgProcessingTime] = useState<number | null>(null);
  // Initialize project filter to current active project, fallback to ALL
  function getActiveProject() {
    const proj = (sessionStorage.getItem("evidex-organization") || "").trim();
    if (!proj || proj.toLowerCase() === "unassigned") return "ALL";
    return proj;
  }
  const [selectedProject, setSelectedProject] = useState<string>(getActiveProject());
  const [metricsUpdatedAt, setMetricsUpdatedAt] = useState<number>(0);

  function isApprovedRequest(request: RequestItem): boolean {
    const approvalStatus = String(request.approval_status || "").trim().toLowerCase();
    return approvalStatus === "approved" || Boolean(request.approvedAt);
  }

  /* ✅ Load requests & auto‑refresh on changes */
  useEffect(() => {
    function loadRequests() {
      const stored = getStoredRequests() as RequestItem[];
      setRequests(stored);
      // Trigger a metrics refresh whenever storage changes
      setMetricsUpdatedAt(Date.now());
    }

    loadRequests();
    window.addEventListener("storage", loadRequests);

    return () =>
      window.removeEventListener("storage", loadRequests);
  }, []);

  const projects = useMemo(() => {
    const unique = new Set<string>();
    requests.forEach((r) => {
      const organization = (r.organization || "").trim();
      if (organization) {
        unique.add(organization);
      }
    });
    return Array.from(unique);
  }, [requests]);

  const filteredRequests = useMemo(() => {
    if (selectedProject === "ALL") return requests;
    return requests.filter(
      (r) => (r.organization || "").trim() === selectedProject
    );
  }, [requests, selectedProject]);

  // Include both active and archived (exclude deleted)
  const filteredNonDeletedRequests = useMemo(
    () => filteredRequests.filter((request) => !request.isDeleted),
    [filteredRequests]
  );

  /* ✅ Recent Activity — limited to 7 most recent */
  useEffect(() => {
    const feed: ActivityItem[] = [];

    filteredRequests.forEach((req) => {
      const createdTs = new Date(req.createdAt).getTime();
      if (Number.isFinite(createdTs)) {
        feed.push({
          message: `Request ${req.id} created`,
          timestamp: createdTs,
        });
      }

      if (isApprovedRequest(req)) {
        const approvedTs = new Date(req.approvedAt || req.updatedAt || req.createdAt).getTime();
        if (Number.isFinite(approvedTs)) {
          feed.push({
            message: `Request ${req.id} approved`,
            timestamp: approvedTs,
          });
        }
      }

      const deletedTs = new Date(req.deletedAt || "").getTime();
      if (req.isDeleted && Number.isFinite(deletedTs)) {
        feed.push({
          message: `Request ${req.id} deleted`,
          timestamp: deletedTs,
        });
      }

      const archivedTs = new Date(req.archivedAt || "").getTime();
      if (req.isArchived && Number.isFinite(archivedTs)) {
        feed.push({
          message: `Request ${req.id} archived`,
          timestamp: archivedTs,
        });
      }
    });

    const latestSeven = feed
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, RECENT_ACTIVITY_LIMIT);

    setActivities(latestSeven);
  }, [filteredRequests]);

  const METRICS_POLL_INTERVAL_MS = 5_000;

  /* ✅ AI Confidence + Average Collection & Validation Time — live polling */
  useEffect(() => {
    let cancelled = false;

    const AI_CONFIDENCE_STEPS = new Set([
      "Request Interpretation",
      "Evidence Validation",
      "Conclusion Generation",
    ]);

    async function loadDashboardMetrics() {
      const confidences: number[] = [];
      const processingTimes: number[] = [];

      const confidenceFromStorageIds = new Set<string>();
      const processingFromStorageIds = new Set<string>();

      filteredNonDeletedRequests.forEach((req) => {
        const validationResult = readJsonFromStorage<any>(
          `evidex-agent-result-${req.id}`
        );
        const conclusionResult = readJsonFromStorage<any>(
          `evidex-agent-conclusion-${req.id}`
        );
        const workflowLogs = readJsonFromStorage<any[]>(
          `evidex-agent-logs-${req.id}`
        );

        const storageLogs = [
          ...(Array.isArray(validationResult?.step_logs)
            ? validationResult.step_logs
            : []),
          ...(Array.isArray(workflowLogs) ? workflowLogs : []),
        ];

        // Confidence: only from AI agent steps
        const aiStepConfidences = storageLogs
          .filter((log: any) => AI_CONFIDENCE_STEPS.has(log?.step_name) && typeof log?.confidence_score === "number")
          .map((log: any) => Number(log.confidence_score));

        if (aiStepConfidences.length > 0) {
          const avg = aiStepConfidences.reduce((a, b) => a + b, 0) / aiStepConfidences.length;
          confidences.push(avg);
          confidenceFromStorageIds.add(req.id);
        } else {
          // Fallback to top-level fields if no step logs available yet
          const fallbackCandidates = [
            validationResult?.confidence,
            validationResult?.average_confidence_score,
            conclusionResult?.confidence,
          ];
          const resolved = fallbackCandidates.find((v) => typeof v === "number");
          if (typeof resolved === "number") {
            confidences.push(resolved);
            confidenceFromStorageIds.add(req.id);
          }
        }

        storageLogs.forEach((log: any) => {
          if (typeof log?.execution_time_ms === "number" && log.execution_time_ms > 0) {
            processingTimes.push(log.execution_time_ms);
            processingFromStorageIds.add(req.id);
          }
        });
      });

      const missingConfidenceIds = filteredNonDeletedRequests
        .map((r) => r.id)
        .filter((id, idx, arr) => arr.indexOf(id) === idx)
        .filter((id) => !confidenceFromStorageIds.has(id));

      const missingProcessingIds = filteredNonDeletedRequests
        .map((r) => r.id)
        .filter((id, idx, arr) => arr.indexOf(id) === idx)
        .filter((id) => !processingFromStorageIds.has(id));

      const fallbackIds = Array.from(new Set([...missingConfidenceIds, ...missingProcessingIds]));

      if (fallbackIds.length > 0) {
        const stepLogResults = await Promise.all(
          fallbackIds.map(async (id) => {
            try {
              const logs = await getStepLogs(id);
              return { id, logs };
            } catch {
              return { id, logs: [] as any[] };
            }
          })
        );

        stepLogResults.forEach(({ logs }) => {
          const aiStepConfidences = logs
            .filter((log: any) => AI_CONFIDENCE_STEPS.has(log?.step_name) && typeof log?.confidence_score === "number")
            .map((log: any) => Number(log.confidence_score));

          if (aiStepConfidences.length > 0) {
            const avg = aiStepConfidences.reduce((a, b) => a + b, 0) / aiStepConfidences.length;
            confidences.push(avg);
          }

          logs.forEach((log: any) => {
            if (typeof log?.execution_time_ms === "number" && log.execution_time_ms > 0) {
              processingTimes.push(log.execution_time_ms);
            }
          });
        });
      }

      if (cancelled) return;

      setAvgConfidence(
        confidences.length === 0
          ? null
          : Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(2))
      );

      setAvgProcessingTime(
        processingTimes.length === 0
          ? null
          : Math.round(processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length)
      );
    }

    loadDashboardMetrics();

    const intervalId = setInterval(loadDashboardMetrics, METRICS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  // metricsUpdatedAt forces an immediate re-run when storage events fire
  }, [filteredNonDeletedRequests, metricsUpdatedAt]);

  const total = filteredNonDeletedRequests.length;
  const approved = filteredNonDeletedRequests.filter(
    (r) => isApprovedRequest(r)
  ).length;
  const pending = total - approved;

  function openProjectsView(filter: ProjectRequestFilter) {
    const params = new URLSearchParams();

    if (selectedProject !== "ALL") {
      params.set("project", selectedProject);
    }

    if (filter !== "all") {
      params.set("requestFilter", filter);
    }

    const query = params.toString();
    navigate(query ? `/projects?${query}` : "/projects");
  }

  return (
    <div style={{ maxWidth: "1200px" }}>
      <h1 style={{ marginBottom: "8px" }}>Dashboard</h1>

      {/* Project Filter */}
      <div style={{ maxWidth: "320px", marginBottom: "24px" }}>
        <label style={{ display: "block", fontWeight: 600, fontSize: "14px" }}>
          Project Filter
        </label>
        <select
          value={selectedProject}
          onChange={(e) => setSelectedProject(e.target.value)}
          style={inputStyle}
        >
          <option value="ALL">All Projects</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <section style={grid4}>
        <Metric label="Total Requests" value={total} icon={faClipboardList} onClick={() => openProjectsView("all")} />
        <Metric label="Approved" value={approved} icon={faCheckCircle} onClick={() => openProjectsView("approved")} />
        <Metric label="Pending" value={pending} icon={faClock} onClick={() => openProjectsView("pending")} />
        <Metric 
          label="Avg AI Confidence" 
          value={
            avgConfidence !== null
              ? `${(avgConfidence * 100).toFixed(0)}%`
              : "—"
          } 
          icon={faChartLine}
          subtext={avgProcessingTime !== null ? `Avg Time: ${(avgProcessingTime / 1000).toFixed(2)}s` : "Updating…"}
        />
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "2fr 1fr",
          gap: "24px",
          marginTop: "32px",
        }}
      >
        <div style={cardStyle}>
          <h3 style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
            <FontAwesomeIcon icon={faListCheck} size={iconSize.base} />
            <span>Recent Activity</span>
          </h3>
          <ul style={{ paddingLeft: "16px", margin: 0 }}>
            {activities.length === 0 ? (
              <li style={{ color: "var(--text-muted)" }}>No recent activity</li>
            ) : (
              activities.map((a, i) => (
                <li key={i} style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px" }}>
                  <FontAwesomeIcon icon={faClock} size={iconSize.base} style={{ color: "var(--text-muted)" }} />
                  <span>{a.message}</span>
                </li>
              ))
            )}
          </ul>
        </div>

        <div style={cardStyle}>
          <h3 style={{ marginBottom: "12px" }}>Quick Actions</h3>
          <button
            onClick={() => navigate("/new-request")}
            style={{ ...primaryButtonStyle, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}
          >
            <FontAwesomeIcon icon={faPlus} size={iconSize.base} />
            New Evidence Request
          </button>
        </div>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  icon,
  subtext,
  onClick,
}: {
  label: string;
  value: string | number;
  icon: Parameters<typeof FontAwesomeIcon>[0]["icon"];
  subtext?: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      } : undefined}
      style={{
        ...cardStyle,
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <div style={{ color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px", fontSize: "13px" }}>
        <FontAwesomeIcon icon={icon} size={iconSize.base} />
        <span>{label}</span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px" }}>
        <div style={{ fontSize: "28px", fontWeight: 700 }}>
          {value}
        </div>
        {subtext && (
          <div style={{ fontSize: "12px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
            {subtext}
          </div>
        )}
      </div>
    </div>
  );
}

const grid4: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: "16px",
};

