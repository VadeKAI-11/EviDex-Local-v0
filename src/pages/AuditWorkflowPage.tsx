import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { jsPDF } from "jspdf";
import {
  faBullseye,
  faChartLine,
  faChevronDown,
  faChevronUp,
  faCircleCheck,
  faCopy,
  faDownload,
  faPenToSquare,
  faShieldHalved,
  faRotateRight,
  faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";
import WorkflowStatusPanel from "../components/WorkflowStatusPanel";
import StepLogViewer from "../components/StepLogViewer";
import ApprovalWorkflow from "../components/ApprovalWorkflow";
import WorkflowInterface from "../components/WorkflowInterface";
import EvidenceUploadModal from "../components/EvidenceUploadModal";
import ArchiveConfirmationModal from "../components/ArchiveConfirmationModal";
import RichTextBlock from "../components/RichTextBlock";
import RequestActions from "../components/RequestActions";
import {
  ensureEvidencePreviewAvailable,
  getRequestDetails,
  getWorkflowOutputs,
  getEvidenceItems,
  getEvidencePreviewUrl,
  getEvidenceDownloadUrl,
  interpretRequest,
  retrieveEvidence,
  validateEvidence,
  generateConclusion,
} from "../api/backend-api";
import {
  ApprovalStatus,
  WorkflowStage,
  type EvidenceLinkItem,
  type RequestDetails,
} from "../api/types";
import { getStoredRequests, moveRequestToArchive, updateStoredRequest } from "../utils/recycleBin";
import { formatDateDMY, formatDateTimeDMY } from "../utils/dateTime";
import { useToast } from "../context/ToastContext";
import { recordAuditEvent } from "../utils/auditLog";

type UploadValidationSummary = {
  sufficient?: boolean;
  status?: string;
  sufficiency_conclusion?: string;
  overall_sufficiency_score?: number;
  overall_sufficiency?: number;
  confidence?: number;
  gap_recommendations?: unknown[];
};

type UploadConclusionSummary = {
  overall_assessment?: string;
  confidence?: number;
  coverage?: number;
  recommendations?: unknown[];
  report_sections?: {
    engagement_context?: string;
    review_procedures?: string;
    review_highlights?: string;
    conclusion?: string;
  };
};

type BedrockSummary = {
  enabled?: boolean;
  provider?: string;
  status?: string;
  model_id?: string;
  summary?: string;
  message?: string;
  parsed_summary?: {
    executive_summary?: string;
    key_findings?: unknown[];
    sufficiency_assessment?: string;
    risks?: unknown[];
    recommended_next_steps?: unknown[];
  };
};

type ParsedBedrockSummary = {
  executive_summary?: string;
  key_findings?: unknown[];
  sufficiency_assessment?: string;
  risks?: unknown[];
  recommended_next_steps?: unknown[];
  calculated_validation_score?: number;
  validation_status?: "sufficient" | "insufficient";
};

type WorkflowFailureBanner = {
  stage: WorkflowStage | "auto";
  reason: string;
};

type ObservabilityCategory =
  | "interpretation"
  | "retrieval"
  | "validation"
  | "conclusion"
  | "error"
  | "info";

type ObservabilityEvent = {
  id: number;
  timestamp: string;
  category: ObservabilityCategory;
  message: string;
};

const MAX_PROCESS_RETRIES = 1;
const MAX_REPORT_DRAFT_VERSIONS = 5;
const MAX_EMAIL_TEMPLATE_VARIANTS = 7;
const MAX_OBSERVABILITY_EVENTS = 30;

function inferObservabilityCategory(message: string): ObservabilityCategory {
  const text = String(message || "").toLowerCase();
  if (
    text.includes("error") ||
    text.includes("failed") ||
    text.includes("stopped") ||
    text.includes("no evidence found")
  ) {
    return "error";
  }
  if (text.includes("interpretation")) {
    return "interpretation";
  }
  if (text.includes("retrieval") || text.includes("evidence")) {
    return "retrieval";
  }
  if (text.includes("validation")) {
    return "validation";
  }
  if (text.includes("conclusion") || text.includes("summarization") || text.includes("bedrock")) {
    return "conclusion";
  }
  return "info";
}

function categoryTagStyles(category: ObservabilityCategory): { bg: string; border: string; text: string } {
  switch (category) {
    case "interpretation":
      return { bg: "#eef2ff", border: "#c7d2fe", text: "#3730a3" };
    case "retrieval":
      return { bg: "#ecfeff", border: "#a5f3fc", text: "#0e7490" };
    case "validation":
      return { bg: "#fffbeb", border: "#fde68a", text: "#92400e" };
    case "conclusion":
      return { bg: "#ecfdf5", border: "#86efac", text: "#166534" };
    case "error":
      return { bg: "#fef2f2", border: "#fca5a5", text: "#b91c1c" };
    default:
      return { bg: "#f8fafc", border: "#cbd5e1", text: "#334155" };
  }
}

function normalizeValidationSummary(raw: unknown): UploadValidationSummary | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const source = raw as Record<string, unknown>;
  const scoreCandidate =
    source.overall_sufficiency_score ?? source.overall_sufficiency;

  const toNumber = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  };

  const normalizedScore = toNumber(scoreCandidate);
  const normalizedConfidence = toNumber(source.confidence);

  return {
    sufficient:
      typeof source.sufficient === "boolean"
        ? source.sufficient
        : undefined,
    status: typeof source.status === "string" ? source.status : undefined,
    sufficiency_conclusion:
      typeof source.sufficiency_conclusion === "string"
        ? source.sufficiency_conclusion
        : undefined,
    overall_sufficiency_score: normalizedScore,
    overall_sufficiency: normalizedScore,
    confidence: normalizedConfidence,
    gap_recommendations: Array.isArray(source.gap_recommendations)
      ? source.gap_recommendations
      : [],
  };
}

function formatWorkflowStage(stage: WorkflowStage | "auto"): string {
  if (stage === "auto") {
    return "Automatic Progression";
  }

  switch (stage) {
    case WorkflowStage.INITIALIZATION:
      return "Initialization";
    case WorkflowStage.INTERPRETATION:
      return "Interpretation";
    case WorkflowStage.RETRIEVAL:
      return "Retrieval";
    case WorkflowStage.VALIDATION:
      return "Validation";
    case WorkflowStage.CONCLUSION:
      return "Conclusion";
    case WorkflowStage.APPROVAL:
      return "Approval";
    case WorkflowStage.EXPORTED:
      return "Export";
    default:
      return String(stage);
  }
}

function resolveLastSuccessfulStageFromCurrent(currentStage: WorkflowStage): WorkflowStage | null {
  switch (currentStage) {
    case WorkflowStage.INTERPRETATION:
      return WorkflowStage.INTERPRETATION;
    case WorkflowStage.RETRIEVAL:
      return WorkflowStage.RETRIEVAL;
    case WorkflowStage.VALIDATION:
      return WorkflowStage.VALIDATION;
    case WorkflowStage.CONCLUSION:
    case WorkflowStage.APPROVAL:
    case WorkflowStage.EXPORTED:
      return WorkflowStage.CONCLUSION;
    case WorkflowStage.INITIALIZATION:
    default:
      return null;
  }
}

function toTwoSentenceSummary(text?: string, fallback = ""): string {
  const source = String(text || "").trim();
  if (!source) {
    return fallback;
  }

  const sanitized = source
    .replace(/\s+/g, " ")
    .replace(/Sufficient:\s*overall\s*sufficiency\s*is[^.]*\.?/i, "")
    .replace(/based\s+on\s+the\s+strongest[^.]*\.?/gi, "")
    .replace(/including\s+[^.]*\.?/gi, "")
    .trim();

  const sentences = sanitized
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return fallback;
  }

  return sentences.slice(0, 2).join(" ");
}

function toProfessionalParagraph(items: string[], fallback: string): string {
  const normalized = items
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 6);

  if (normalized.length === 0) {
    return fallback;
  }

  const body = normalized.join(" ");
  return toTwoSentenceSummary(body, fallback);
}

function formatModelSection(text?: string): string {
  const source = String(text || "").trim();
  if (!source) {
    return "";
  }

  return toTwoSentenceSummary(source, source);
}

function stripRequestIdReferences(text: string, requestId: string): string {
  const source = String(text || "").trim();
  const normalizedRequestId = String(requestId || "").trim();
  if (!source || !normalizedRequestId) {
    return source;
  }

  const escapedRequestId = normalizedRequestId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return source
    .replace(new RegExp(`audit\\s+request\\s+${escapedRequestId}`, "gi"), "the audit request")
    .replace(new RegExp(`request\\s+${escapedRequestId}`, "gi"), "the request")
    .replace(new RegExp(`\(${escapedRequestId}\)`, "g"), "")
    .replace(new RegExp(escapedRequestId, "g"), "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .trim();
}

function formatWcastDate(value: Date | string | number): string {
  return formatDateDMY(value);
}

function extractClientName(rawOrganization: string, rawCategory: string): string {
  const normalizedOrganization = String(rawOrganization || "").trim();
  const normalizedCategory = String(rawCategory || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let candidate = normalizedOrganization
    .replace(/^deloitte\s*[,\-–—]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (normalizedCategory) {
    const escapedCategory = normalizedCategory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    candidate = candidate.replace(new RegExp(`\\s*[-–—]?\\s*${escapedCategory}$`, "i"), "").trim();
  }

  candidate = candidate.replace(/\s*[-–—]\s*(internal|external|financial|compliance|gitc)\s+audit$/i, "").trim();

  return candidate || "Client";
}

function isControlOwnershipLine(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  return (
    normalized.includes("control owner") ||
    normalized.includes("control ownership") ||
    normalized.includes("ownership")
  );
}

function recommendationRiskPriority(text: string): number {
  const normalized = String(text || "").toLowerCase();

  if (/\bcritical|severe|high risk|material|urgent|immediate\b/.test(normalized)) {
    return 4;
  }

  if (/\bmajor|significant|elevated|important|priority\b/.test(normalized)) {
    return 3;
  }

  if (/\bmoderate|medium|watch|monitor\b/.test(normalized)) {
    return 2;
  }

  if (/\blow|minor|optional\b/.test(normalized)) {
    return 1;
  }

  return 0;
}

function sortRecommendationsByRisk(items: string[]): string[] {
  return [...items].sort((a, b) => {
    const diff = recommendationRiskPriority(b) - recommendationRiskPriority(a);
    if (diff !== 0) {
      return diff;
    }
    return a.localeCompare(b);
  });
}

function isTechnicalSufficiencyLine(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  return (
    normalized.includes("overall sufficiency is") ||
    normalized.includes("based on the strongest") ||
    normalized.includes("selected evidence set for sufficiency assessment") ||
    normalized.includes("excluded from minimum sufficient set")
  );
}

export default function AuditWorkflowPage() {
  const { id: requestId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { showToast } = useToast();
  const forceReadOnly = searchParams.get("mode") === "readonly";
  const archivedRequestSnapshot = requestId
    ? getStoredRequests().find((entry) => entry.id === requestId)
    : null;
  const isArchivedReadOnly = Boolean(forceReadOnly || (archivedRequestSnapshot?.isArchived && !archivedRequestSnapshot?.isDeleted));
  const isMountedRef = useRef(true);
  const failureBannerRef = useRef<HTMLDivElement | null>(null);
  const lastAutoStageRef = useRef<string | null>(null);
  const [request, setRequest] = useState<RequestDetails | null>(() => {
    if (!requestId) {
      return null;
    }

    const storedRequest = getStoredRequests().find((item) => item.id === requestId);
    if (!storedRequest) {
      return null;
    }

    return {
      request_id: storedRequest.id,
      auditor_id: String(storedRequest.createdBy || storedRequest.auditor_id || ""),
      auditor_email: String(storedRequest.createdBy || storedRequest.auditor_email || ""),
      request_text: String(storedRequest.requestText || storedRequest.request_text || ""),
      category: String(storedRequest.category || "general"),
      current_stage: (storedRequest.status as RequestDetails["current_stage"]) || "initialization",
      approval_status: (storedRequest.approval_status as RequestDetails["approval_status"]) || "pending",
      created_at: String(storedRequest.createdAt || new Date().toISOString()),
      updated_at: String(storedRequest.updatedAt || storedRequest.createdAt || new Date().toISOString()),
    };
  });
  const [loading, setLoading] = useState(() =>
    Boolean(requestId) &&
    !getStoredRequests().some((item) => item.id === requestId)
  );
  const [error, setError] = useState<string | null>(null);
  const [workflowFailure, setWorkflowFailure] = useState<WorkflowFailureBanner | null>(null);
  const [notFound, setNotFound] = useState(false);
  const initialTab = "status";
  const [activeTab, setActiveTab] = useState<
    "status" | "logs" | "approval" | "workflow-interaction"
  >(initialTab);
  const [showStepLogs, setShowStepLogs] = useState(false);
  const [showUploadSummary, setShowUploadSummary] = useState(false);
  const [showEvidenceUploadModal, setShowEvidenceUploadModal] = useState(false);
  const [uploadValidation, setUploadValidation] = useState<UploadValidationSummary | null>(null);
  const [uploadConclusion, setUploadConclusion] = useState<UploadConclusionSummary | null>(null);
  const [evidenceItems, setEvidenceItems] = useState<EvidenceLinkItem[]>([]);
  const [showEvidenceListModal, setShowEvidenceListModal] = useState(false);
  const [evidenceListLoading, setEvidenceListLoading] = useState(false);
  const [evidenceListError, setEvidenceListError] = useState<string | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceLinkItem | null>(null);
  const [bedrockSummary, setBedrockSummary] = useState<BedrockSummary | null>(null);
  const [emailTemplateVariant, setEmailTemplateVariant] = useState(0);
  const [showApprovalReport, setShowApprovalReport] = useState(false);
  const [showAnalysisSection, setShowAnalysisSection] = useState(true);
  const [showDraftEmailSection, setShowDraftEmailSection] = useState(false);
  const [showDraftReportSection, setShowDraftReportSection] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const uploadSummaryDismissedRef = useRef(false);
  const uploadSummaryAutoOpenKeyRef = useRef<string | null>(null);

  const handleCloseUploadSummary = useCallback(() => {
    uploadSummaryDismissedRef.current = true;
    setShowUploadSummary(false);
    setShowAnalysisSection(false);
    setShowDraftEmailSection(false);
    setShowDraftReportSection(false);
  }, []);
  const tryAutoOpenUploadSummary = useCallback((sourceKey: string, force = false) => {
    if (!force && uploadSummaryDismissedRef.current) {
      return;
    }
    if (uploadSummaryAutoOpenKeyRef.current === sourceKey) {
      return;
    }
    uploadSummaryAutoOpenKeyRef.current = sourceKey;
    setShowUploadSummary(true);
  }, []);
  const [reportTemplateVariant, setReportTemplateVariant] = useState(0);
  const [emailCopyState, setEmailCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [reportCopyState, setReportCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [showDraftEmailEditor, setShowDraftEmailEditor] = useState(false);
  const [showDraftReportEditor, setShowDraftReportEditor] = useState(false);
  const [draftEmailEditorText, setDraftEmailEditorText] = useState("");
  const [draftReportEditorText, setDraftReportEditorText] = useState("");
  const [savedDraftEmailText, setSavedDraftEmailText] = useState<string | null>(null);
  const [savedDraftReportText, setSavedDraftReportText] = useState<string | null>(null);
  const [workflowObservability, setWorkflowObservability] = useState<ObservabilityEvent[]>([]);
  const [showWorkflowObservability, setShowWorkflowObservability] = useState(false);
  const [uiFreezeActive, setUiFreezeActive] = useState(false);
  const observabilityEventIdRef = useRef(0);
  const uiFreezeActiveRef = useRef(false);
  const pendingRequestRef = useRef<RequestDetails | null | undefined>(undefined);
  const pendingObservabilityRef = useRef<ObservabilityEvent[]>([]);

  const appendObservabilityEvent = useCallback(
    (prev: ObservabilityEvent[], event: ObservabilityEvent): ObservabilityEvent[] => {
      const next = [...prev, event];
      return next.length > MAX_OBSERVABILITY_EVENTS ? next.slice(next.length - MAX_OBSERVABILITY_EVENTS) : next;
    },
    []
  );

  const commitRequestUpdate = useCallback((next: RequestDetails | null) => {
    if (uiFreezeActiveRef.current) {
      pendingRequestRef.current = next;
      return;
    }

    setRequest(next);
  }, []);

  const pushObservability = useCallback((message: string, category?: ObservabilityCategory) => {
    const id = ++observabilityEventIdRef.current;
    const resolvedCategory = category ?? inferObservabilityCategory(message);
    const event: ObservabilityEvent = {
      id,
      timestamp: new Date().toISOString(),
      message,
      category: resolvedCategory,
    };

    if (uiFreezeActiveRef.current) {
      pendingObservabilityRef.current = appendObservabilityEvent(pendingObservabilityRef.current, event);
      return;
    }

    setWorkflowObservability((prev) => appendObservabilityEvent(prev, event));
  }, [appendObservabilityEvent]);

  const [autoWorkflowRunning, setAutoWorkflowRunning] = useState(false);
  const [inFlightStage, setInFlightStage] = useState<WorkflowStage | null>(null);
  const [lastSuccessfulStage, setLastSuccessfulStage] = useState<WorkflowStage | null>(null);
  const stageRetryCountsRef = useRef<Record<string, number>>({});
  const autoWorkflowLockRef = useRef(false);

  useEffect(() => {
    if (showEvidenceUploadModal) {
      setUiFreezeActive(true);
      return;
    }

    const processingStageActive =
      autoWorkflowRunning &&
      (inFlightStage === WorkflowStage.RETRIEVAL ||
        inFlightStage === WorkflowStage.VALIDATION ||
        inFlightStage === WorkflowStage.CONCLUSION);

    if (processingStageActive || (autoWorkflowRunning && uiFreezeActive)) {
      setUiFreezeActive(true);
      return;
    }

    if (!autoWorkflowRunning && !showEvidenceUploadModal) {
      setUiFreezeActive(false);
    }
  }, [autoWorkflowRunning, inFlightStage, showEvidenceUploadModal, uiFreezeActive]);

  useEffect(() => {
    uiFreezeActiveRef.current = uiFreezeActive;

    if (uiFreezeActive) {
      return;
    }

    if (pendingRequestRef.current !== undefined) {
      setRequest(pendingRequestRef.current);
      pendingRequestRef.current = undefined;
    }

    if (pendingObservabilityRef.current.length > 0) {
      setWorkflowObservability((prev) => {
        let next = [...prev];
        for (const event of pendingObservabilityRef.current) {
          next = appendObservabilityEvent(next, event);
        }
        return next;
      });
      pendingObservabilityRef.current = [];
    }
  }, [appendObservabilityEvent, uiFreezeActive]);

  useEffect(() => {
    if (!requestId) {
      return;
    }
    sessionStorage.setItem("evidex-current-request-id", requestId);
  }, [requestId]);
  const outputsHydrationInFlightRef = useRef(false);
  const previousRequestStageRef = useRef<WorkflowStage | null>(null);

  const replayWorkflowOutputs = useCallback(
    (update: {
      phase: "start" | "stage-start" | "stage-complete" | "done" | "error";
      stage?: WorkflowStage;
      validation?: unknown;
      conclusion?: unknown;
      details?: RequestDetails | null;
      bedrockSummary?: BedrockSummary;
    }) => {
      if (!isMountedRef.current) {
        return;
      }

      if (update.phase === "start") {
        setAutoWorkflowRunning(true);
        setWorkflowFailure(null);
        setError(null);
        setInFlightStage(null);
        pushObservability("Step log replay started from Process Traceability refresh.");
        return;
      }

      if (update.phase === "stage-start") {
        if (update.stage) {
          setInFlightStage(update.stage);
          pushObservability(`Refreshing ${formatWorkflowStage(update.stage)} step from Process Traceability...`);
        }
        return;
      }

      if (update.phase === "stage-complete") {
        if (update.stage) {
          setLastSuccessfulStage(update.stage);
          setInFlightStage(null);
          pushObservability(`${formatWorkflowStage(update.stage)} refreshed from Process Traceability.`);
        }

        if (update.validation && requestId) {
          persistValidationSummary(requestId, update.validation as never);
        }

        if (update.conclusion && requestId) {
          persistConclusionSummary(requestId, update.conclusion as never);
          tryAutoOpenUploadSummary(`replay-conclusion:${requestId}`);
        }

        if (update.bedrockSummary && requestId) {
          persistBedrockSummary(requestId, update.bedrockSummary);
          tryAutoOpenUploadSummary(`replay-bedrock:${requestId}`);
          pushObservability("Bedrock analysis refreshed from Process Traceability replay.");
        }

        if (update.details) {
          commitRequestUpdate(update.details);
        }
        return;
      }

      if (update.phase === "done") {
        setAutoWorkflowRunning(false);
        setInFlightStage(null);
        if (update.details) {
          commitRequestUpdate(update.details);
          if (
            update.details.current_stage === WorkflowStage.CONCLUSION ||
            update.details.current_stage === WorkflowStage.APPROVAL ||
            update.details.current_stage === WorkflowStage.EXPORTED
          ) {
            setLastSuccessfulStage(WorkflowStage.CONCLUSION);
            tryAutoOpenUploadSummary(`replay-done:${requestId ?? "unknown"}`);
          }
        }
        pushObservability("Step log replay completed.");
        return;
      }

      if (update.phase === "error") {
        setAutoWorkflowRunning(false);
        setInFlightStage(null);
        pushObservability("Step log replay stopped due to an error.");
      }
    },
    [commitRequestUpdate, pushObservability, requestId, tryAutoOpenUploadSummary]
  );

  const handleStepLogReplayUpdate = replayWorkflowOutputs;

  const reportWorkflowFailure = useCallback(
    (
      stage: WorkflowStage | "auto",
      err: unknown,
      fallback: string
    ) => {
      const reason = err instanceof Error ? err.message : fallback;
      setError(reason);
      setWorkflowFailure({ stage, reason });
    },
    []
  );

  useEffect(() => {
    if (!workflowFailure) {
      return;
    }

    setActiveTab("status");

    const timer = window.setTimeout(() => {
      failureBannerRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [workflowFailure]);

  function persistValidationSummary(requestIdValue: string, validation: {
    status: string;
    overall_sufficiency: number;
    confidence: number;
    recommendations: string[];
  }) {
    const summary: UploadValidationSummary = {
      sufficient: validation.status === "sufficient",
      overall_sufficiency_score: validation.overall_sufficiency,
      confidence: validation.confidence,
      gap_recommendations: validation.recommendations || [],
    };
    if (isMountedRef.current) {
      setUploadValidation(summary);
    }
    localStorage.setItem(
      `evidex-agent-result-${requestIdValue}`,
      JSON.stringify(summary)
    );
  }

  function persistConclusionSummary(requestIdValue: string, conclusion: {
    overall_assessment: string;
    confidence: number;
    coverage: number;
    recommendations: string[];
    report_sections?: {
      engagement_context?: string;
      review_procedures?: string;
      review_highlights?: string;
      conclusion?: string;
    };
  }) {
    const summary: UploadConclusionSummary = {
      overall_assessment: conclusion.overall_assessment,
      confidence: conclusion.confidence,
      coverage: conclusion.coverage,
      recommendations: conclusion.recommendations || [],
      report_sections: conclusion.report_sections || {},
    };
    if (isMountedRef.current) {
      setUploadConclusion(summary);
    }
    localStorage.setItem(
      `evidex-agent-conclusion-${requestIdValue}`,
      JSON.stringify(summary)
    );
  }

  function persistBedrockSummary(requestIdValue: string, summary: BedrockSummary) {
    if (isMountedRef.current) {
      setBedrockSummary(summary);
    }
    localStorage.setItem(
      `evidex-bedrock-summary-${requestIdValue}`,
      JSON.stringify(summary)
    );
  }

  function normalizeItems(items?: unknown[]): string[] {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    return items.map((item) => formatDisplayValue(item));
  }

  function formatDisplayValue(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;

      const preferred = record.description || record.title || record.text || record.message;
      if (typeof preferred === "string" && preferred.trim().length > 0) {
        return preferred;
      }

      const hasStatusScoreRationale =
        "status" in record || "score" in record || "rationale" in record;
      if (hasStatusScoreRationale) {
        const parts: string[] = [];
        if (record.status !== undefined) {
          parts.push(`Status: ${String(record.status)}`);
        }
        if (record.score !== undefined) {
          parts.push(`Score: ${String(record.score)}`);
        }
        if (record.rationale !== undefined) {
          parts.push(`Rationale: ${String(record.rationale)}`);
        }
        if (parts.length > 0) {
          return parts.join(" | ");
        }
      }

      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }

    return String(value ?? "");
  }


  function buildInsufficiencyEmailDraft(args: {
    requestId: string;
    assessment: string;
    missingItems: string[];
    recommendations: string[];
    templateVariant: number;
  }): string {
    const { requestId, assessment, missingItems, recommendations, templateVariant } = args;
    const variant = templateVariant % MAX_EMAIL_TEMPLATE_VARIANTS;
    const topMissing = missingItems.slice(0, 4);
    const topRecommendations = recommendations.slice(0, 5);
    const recommendationLines = topRecommendations
      .map((item, idx) => `${idx + 1}. ${item}`)
      .join("\n");
    const missingLines = topMissing.map((item) => `- ${item}`).join("\n");

    const emailTemplates = [
      [
        "Subject: Additional Evidence Required",
        "",
        "Dear Team,",
        "",
        "Following our review, the current submission is not yet sufficient.",
        "",
        "Key evidence gaps identified:",
        missingLines || "- Additional supporting documentation is still required.",
        "",
        "Please provide the following actions/evidence:",
        recommendationLines || "- No additional recommendations were provided.",
        "",
        `Current assessment: ${assessment}.`,
        "",
        "Kindly share the requested items at your earliest convenience so we can proceed with validation.",
        "",
        "Regards,",
        "Audit Team",
      ],
      [
        "Subject: Evidence Follow-up Needed",
        "",
        "Hello,",
        "",
        "Our review indicates that the current submission remains below the sufficiency threshold.",
        "",
        "What is currently missing:",
        missingLines || "- Outstanding evidence items remain open.",
        "",
        "Required next steps:",
        recommendationLines || "- No additional recommendations were provided.",
        "",
        "Once these items are submitted, we will promptly continue the assessment.",
        "",
        "Thank you,",
        "Audit Evidence Review Team",
      ],
      [
        "Subject: Action Required: Outstanding Audit Evidence",
        "",
        "Dear Stakeholder,",
        "",
        `This is a follow-up on the current audit request. The evidence package is currently assessed as ${assessment}.`,
        "",
        "Outstanding items:",
        missingLines || "- Additional corroborating evidence is required.",
        "",
        "To close the gaps, please complete the following:",
        recommendationLines || "- No additional recommendations were provided.",
        "",
        "Please reply to this email with the required documents or indicate your expected submission date.",
        "",
        "Sincerely,",
        "Audit Compliance Team",
      ],
      [
        "Subject: Audit Evidence Gap Notice",
        "",
        "Hello Team,",
        "",
        `A quality review identified that the current submission remains ${assessment}.`,
        "",
        "Evidence gaps:",
        missingLines || "- Documentation gaps were detected.",
        "",
        "Requested remediation:",
        recommendationLines || "- No additional recommendations were provided.",
        "",
        "Please provide the above so we can complete the review cycle.",
        "",
        "Regards,",
        "Audit Controls Team",
      ],
      [
        "Subject: Follow-up Needed Before Approval",
        "",
        "Dear Colleagues,",
        "",
        `The current submission does not yet satisfy sufficiency requirements (${assessment}).`,
        "",
        "Missing/insufficient evidence:",
        missingLines || "- Pending supporting records remain outstanding.",
        "",
        "Required actions:",
        recommendationLines || "- No additional recommendations were provided.",
        "",
        "We will proceed once the additional evidence has been received and validated.",
        "",
        "Best regards,",
        "Audit Review Office",
      ],
      [
        "Subject: Request for Additional Audit Support",
        "",
        "Dear Process Owner,",
        "",
        `During validation, we observed unresolved gaps and the package is currently rated ${assessment}.`,
        "",
        "Items requiring attention:",
        missingLines || "- Additional traceable evidence is required.",
        "",
        "Please address the following recommendations:",
        recommendationLines || "- No additional recommendations were provided.",
        "",
        "Thank you for your prompt support in closing these items.",
        "",
        "Kind regards,",
        "Assurance Team",
      ],
      [
        "Subject: Outstanding Evidence Items - Immediate Follow-up",
        "",
        "Dear Team,",
        "",
        `The current submission remains in an ${assessment} state pending further supporting material.`,
        "",
        "Current outstanding items:",
        missingLines || "- Supplemental evidence is required to close open checks.",
        "",
        "Recommended next actions:",
        recommendationLines || "- No additional recommendations were provided.",
        "",
        "Please submit the above so we can finalize validation and proceed.",
        "",
        "Sincerely,",
        "Audit Quality Team",
      ],
    ];

    return emailTemplates[variant].map((line) => stripRequestIdReferences(line, requestId)).join("\n");
  }

  function buildSufficiencyReportDraft(args: {
    requestId: string;
    auditorEmail: string;
    clientName: string;
    assessment: string;
    sufficiencyScore?: number;
    conclusionConfidence?: number;
    coverage?: number;
    rationalePoints: string[];
    recommendations?: string[];
    modelReportSections?: {
      engagement_context?: string;
      review_procedures?: string;
      review_highlights?: string;
      conclusion?: string;
    };
    templateVariant?: number;
  }): string {
    const {
      requestId,
      auditorEmail,
      clientName,
      assessment,
      sufficiencyScore,
      conclusionConfidence,
      coverage,
      rationalePoints,
      recommendations,
      modelReportSections,
      templateVariant = 0,
    } = args;
    return buildValidationConclusionProfessionalReport({
      requestId,
      auditorEmail,
      clientName,
      requestSummary: "",
      assessment,
      sufficiencyScore,
      conclusionConfidence,
      coverage,
      rationalePoints,
      modelReportSections,
      gapItems: [],
      recommendations: recommendations || [],
      templateVariant,
    });
  }

  function buildValidationConclusionProfessionalReport(args: {
    requestId: string;
    auditorEmail: string;
    clientName: string;
    requestSummary: string;
    assessment: string;
    sufficiencyScore?: number;
    conclusionConfidence?: number;
    coverage?: number;
    rationalePoints: string[];
    gapItems?: string[];
    recommendations?: string[];
    modelReportSections?: {
      engagement_context?: string;
      review_procedures?: string;
      review_highlights?: string;
      conclusion?: string;
    };
    templateVariant?: number;
  }): string {
    const {
      requestId,
      auditorEmail,
      clientName,
      assessment,
      requestSummary,
      gapItems,
      rationalePoints,
      recommendations,
      modelReportSections,
      templateVariant,
    } = args;
    const modelUnavailable = "Section content is unavailable.";
    const modelContext = formatModelSection(modelReportSections?.engagement_context);
    const modelHighlights = formatModelSection(modelReportSections?.review_highlights);
    const modelConclusion = formatModelSection(modelReportSections?.conclusion);

    const requestContextParagraph = stripRequestIdReferences(modelContext || modelUnavailable, requestId);

    const executiveSummaryText = stripRequestIdReferences(modelHighlights, requestId)
      || toTwoSentenceSummary(
        requestSummary,
        `The assessment indicates ${String(assessment || "current").trim()} evidence sufficiency based strictly on available artifacts.`
      )
      || modelUnavailable;

    const conclusionParagraph = stripRequestIdReferences(modelConclusion || modelUnavailable, requestId);

    const titleOptions = [
      "Final Draft Report - Independent Auditor Assessment",
      "Final Draft Report - Audit Evidence Sufficiency Memorandum",
      "Final Draft Report - Audit Conclusion and Readiness Review",
      "Final Draft Report - Assurance Completion Summary",
      "Final Draft Report - Engagement Closure Assessment",
    ];
    const variant = Math.abs((templateVariant ?? 0) % titleOptions.length);

    const normalizedAssessment = String(assessment || "")
      .trim()
      .toLowerCase();
    const isExplicitlyInsufficientAssessment =
      normalizedAssessment.includes("insufficient") ||
      normalizedAssessment.includes("partial") ||
      normalizedAssessment.includes("contradict");
    const isSufficientAssessment =
      !isExplicitlyInsufficientAssessment &&
      (normalizedAssessment === "sufficient" || normalizedAssessment.includes("sufficient"));

    const riskOrSufficiencyHeading = isSufficientAssessment
      ? "Sufficiency Analysis:"
      : "Gaps and Risks Identified:";

    const riskOrSufficiencyParagraph = isSufficientAssessment
      ? toProfessionalParagraph(
        rationalePoints && rationalePoints.length > 0
          ? rationalePoints.slice(0, 5)
          : ["Available evidence is sufficient to support the requested assertion within current scope."],
        "Evidence coverage and content consistency indicate that the assertion is supportable."
      )
      : toProfessionalParagraph(
        gapItems && gapItems.length > 0
          ? gapItems.slice(0, 5)
          : rationalePoints && rationalePoints.length > 0
            ? rationalePoints.slice(0, 5)
            : ["Critical supporting evidence is incomplete or unavailable."],
        "Current gaps create a residual risk that should be addressed before conclusion finalization."
      );

    const modelRecommendationParagraph = recommendations && recommendations.length > 0
      ? stripRequestIdReferences(toProfessionalParagraph(recommendations.slice(0, 5), ""), requestId)
      : modelUnavailable;

    const leadOptions = [
      "This report presents the assessment narrative, including executive analysis, risk considerations, recommendations, and final conclusion.",
      "This memorandum summarizes the analysis and presents the resulting professional conclusion in narrative form.",
      "This draft captures the evidence review and provides a concise narrative conclusion for auditor review.",
      "This document records the audit assessment, with a narrative summary of analysis, findings, and conclusion.",
      "This report compiles the request output into a narrative assessment suitable for approval review.",
    ];

    const paragraphBlocks = [
      "Executive Summary:",
      executiveSummaryText,
      "",
      riskOrSufficiencyHeading,
      riskOrSufficiencyParagraph,
      "",
      "Actions and Recommendations:",
      modelRecommendationParagraph,
      "",
      "Conclusion:",
      conclusionParagraph,
    ];

    return [
      titleOptions[variant],
      `Client: ${clientName}`,
      `Date: ${formatWcastDate(new Date())}`,
      "",
      leadOptions[variant],
      "",
      requestContextParagraph,
      "",
      ...paragraphBlocks,
      "",
      `Prepared by: ${auditorEmail}`,
      `Prepared on: ${formatWcastDate(new Date())}`,
    ].join("\n");
  }

  function buildInsufficiencyReportDraft(args: {
    requestId: string;
    auditorEmail: string;
    clientName: string;
    requestSummary: string;
    assessment: string;
    sufficiencyScore?: number;
    conclusionConfidence?: number;
    coverage?: number;
    gapItems: string[];
    recommendations: string[];
    modelReportSections?: {
      engagement_context?: string;
      review_procedures?: string;
      review_highlights?: string;
      conclusion?: string;
    };
    templateVariant?: number;
  }): string {
    const {
      requestId,
      auditorEmail,
      clientName,
      requestSummary,
      assessment,
      sufficiencyScore,
      conclusionConfidence,
      coverage,
      gapItems,
      recommendations,
      modelReportSections,
      templateVariant = 0,
    } = args;
    return buildValidationConclusionProfessionalReport({
      requestId,
      auditorEmail,
      clientName,
      requestSummary,
      assessment,
      sufficiencyScore,
      conclusionConfidence,
      coverage,
      rationalePoints: [],
      gapItems,
      recommendations,
      modelReportSections,
      templateVariant,
    });
  }

  function downloadReportPdf(fileName: string, content: string) {
    const doc = new jsPDF({
      orientation: "portrait",
      unit: "pt",
      format: "a4",
    });

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 48;
    const maxWidth = pageWidth - margin * 2;
    const lineHeight = 15;
    let y = margin;

    const setPdfFont = (weight: "normal" | "bold") => {
      try {
        doc.setFont("Aptos", weight);
      } catch {
        doc.setFont("helvetica", weight);
      }
    };

    const normalizedLines = content
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd());

    const compactedLines: string[] = [];
    let previousWasBlank = false;
    normalizedLines.forEach((line) => {
      const isBlank = line.trim().length === 0;
      if (isBlank) {
        if (!previousWasBlank) {
          compactedLines.push("");
        }
        previousWasBlank = true;
        return;
      }
      compactedLines.push(line);
      previousWasBlank = false;
    });

    compactedLines.forEach((line, index) => {
      const trimmed = line.trim();
      const isHeader = (index === 0 && trimmed.length > 0)
        || /^Client:|^Request ID:|^Date:/.test(trimmed);
      const isSubheader = !isHeader && trimmed.endsWith(":");

      if (isHeader) {
        setPdfFont("bold");
        doc.setFontSize(12);
      } else if (isSubheader) {
        setPdfFont("bold");
        doc.setFontSize(12);
      } else {
        setPdfFont("normal");
        doc.setFontSize(11);
      }

      const wrapped = doc.splitTextToSize(line, maxWidth) as string[];
      wrapped.forEach((wrappedLine) => {
      if (y > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }

      doc.text(wrappedLine, margin, y);
      y += lineHeight;
      });
    });

    doc.save(fileName);

    recordAuditEvent({
      eventName: "file.report.exported",
      action: "Exported audit report as PDF",
      category: "file_access",
      module: "workflow",
      feature: "export-report-pdf",
      source: "ui",
      target: {
        entityType: "request",
        entityId: requestId,
        requestId,
      },
      metadata: {
        fileName,
      },
    });
  }

  function buildReportPdfFilename(reportType: "insufficiency-analysis" | "sufficiency-analysis" | "validation-conclusion") {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const timestamp = [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      "-",
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds()),
    ].join("");

    return `${reportType}-report-${timestamp}.pdf`;
  }

  async function handleCopyDraftEmail(emailText: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(emailText);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = emailText;
        textArea.setAttribute("readonly", "true");
        textArea.style.position = "absolute";
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }

      setEmailCopyState("copied");
      window.setTimeout(() => {
        setEmailCopyState("idle");
      }, 2000);
    } catch {
      setEmailCopyState("error");
      window.setTimeout(() => {
        setEmailCopyState("idle");
      }, 2500);
    }
  }

  async function handleCopyDraftReport(reportText: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(reportText);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = reportText;
        textArea.setAttribute("readonly", "true");
        textArea.style.position = "absolute";
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }

      setReportCopyState("copied");
      window.setTimeout(() => {
        setReportCopyState("idle");
      }, 2000);
    } catch {
      setReportCopyState("error");
      window.setTimeout(() => {
        setReportCopyState("idle");
      }, 2500);
    }
  }

  function openDraftEmailEditor() {
    if (isArchivedReadOnly) {
      showToast("Archived workflows are view-only.", "warning");
      return;
    }
    setDraftEmailEditorText(editableDraftEmailText);
    setShowDraftEmailEditor(true);
  }

  function saveDraftEmailEdits() {
    if (isArchivedReadOnly) {
      showToast("Archived workflows are view-only.", "warning");
      return;
    }
    setSavedDraftEmailText(draftEmailEditorText);
    setShowDraftEmailEditor(false);
  }

  function openDraftReportEditor(initialText: string) {
    if (isArchivedReadOnly) {
      showToast("Archived workflows are view-only.", "warning");
      return;
    }
    setDraftReportEditorText(initialText);
    setShowDraftReportEditor(true);
  }

  function saveDraftReportEdits() {
    if (isArchivedReadOnly) {
      showToast("Archived workflows are view-only.", "warning");
      return;
    }
    setSavedDraftReportText(draftReportEditorText);
    setShowDraftReportEditor(false);
  }

  function parseBedrockSummaryFromRaw(raw?: string): ParsedBedrockSummary | null {
    const text = (raw || "").trim();
    if (!text) {
      return null;
    }

    const candidates: string[] = [text];

    const fencedMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/i);
    if (fencedMatch?.[1]) {
      candidates.push(fencedMatch[1]);
    }

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      candidates.push(text.slice(start, end + 1));
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          return {
            executive_summary:
              typeof parsed.executive_summary === "string"
                ? parsed.executive_summary
                : undefined,
            key_findings: Array.isArray(parsed.key_findings)
              ? parsed.key_findings
              : undefined,
            sufficiency_assessment:
              typeof parsed.sufficiency_assessment === "string"
                ? parsed.sufficiency_assessment
                : undefined,
            risks: Array.isArray(parsed.risks) ? parsed.risks : undefined,
            recommended_next_steps: Array.isArray(parsed.recommended_next_steps)
              ? parsed.recommended_next_steps
              : undefined,
              calculated_validation_score:
                typeof parsed.calculated_validation_score === "number"
                  ? parsed.calculated_validation_score
                  : undefined,
              validation_status:
                parsed.validation_status === "sufficient" || parsed.validation_status === "insufficient"
                  ? (parsed.validation_status as "sufficient" | "insufficient")
                  : undefined,
          };
        }
      } catch {
        // Try next candidate.
      }
    }

    return null;
  }

  function getBedrockStatusTone(status?: string) {
    switch ((status || "").toLowerCase()) {
      case "ok":
        return { bg: "var(--color-success-bg)", border: "var(--color-success-border)", text: "var(--color-success-text)", label: "Enabled" };
      case "disabled":
        return { bg: "var(--card-bg-subtle)", border: "var(--border-color)", text: "var(--text-muted)", label: "Disabled" };
      case "error":
      case "unavailable":
        return { bg: "var(--color-danger-bg)", border: "var(--color-danger-border)", text: "var(--color-danger-text)", label: "Unavailable" };
      default:
        return { bg: "var(--color-info-bg)", border: "var(--color-info-border)", text: "var(--color-info-text)", label: "Unknown" };
    }
  }

  function renderList(items?: unknown[]) {
    if (!items || items.length === 0) {
      return <div style={{ color: "var(--text-muted)" }}>None reported.</div>;
    }

    const normalized = normalizeItems(items);

    return (
      <ul style={{ margin: "6px 0 0 18px", padding: 0, lineHeight: 1.5 }}>
        {normalized.map((item, idx) => (
          <li key={`${item}-${idx}`}>
            <RichTextBlock text={item} />
          </li>
        ))}
      </ul>
    );
  }

  function resolveEvidenceRefFromToken(token: string): EvidenceLinkItem | null {
    const documentMatch = token.match(/\b(?:document|evidence)\s+(\d+)\b/i);
    if (documentMatch) {
      const oneBasedIndex = Number(documentMatch[1]);
      if (Number.isFinite(oneBasedIndex) && oneBasedIndex > 0) {
        return evidenceItems[oneBasedIndex - 1] || null;
      }
    }

    const filenameMatch = token.match(/\b([a-z0-9][a-z0-9._\-]+\.(?:pdf|docx?|xlsx?|csv|txt|msg|pptx?|png|jpe?g|gif|webp))\b/i);
    if (filenameMatch) {
      const filename = filenameMatch[1].toLowerCase();
      return (
        evidenceItems.find((item) => item.filename.toLowerCase() === filename) ||
        null
      );
    }

    return null;
  }

  function renderBedrockTextWithLinks(text: string, keyBase: string) {
    const tokenRegex = /\b(?:document|evidence)\s+\d+\b|\b[a-z0-9][a-z0-9._\-]+\.(?:pdf|docx?|xlsx?|csv|txt|msg|pptx?|png|jpe?g|gif|webp)\b/gi;
    const nodes: ReactNode[] = [];
    let lastIndex = 0;
    let hasReplacement = false;
    let match: RegExpExecArray | null;

    while ((match = tokenRegex.exec(text)) !== null) {
      const [token] = match;
      const evidence = resolveEvidenceRefFromToken(token);
      const start = match.index;
      const end = start + token.length;

      if (start > lastIndex) {
        nodes.push(text.slice(lastIndex, start));
      }

      if (evidence) {
        hasReplacement = true;
        nodes.push(
          <button
            key={`${keyBase}-${start}-${evidence.evidence_id}`}
            type="button"
            onClick={() => {
              void handleEvidenceOpen(evidence);
            }}
            style={{
              border: "none",
              background: "transparent",
              color: "var(--evidex-green)",
              textDecoration: "underline",
              cursor: "pointer",
              padding: 0,
              font: "inherit",
              lineHeight: "inherit",
            }}
            title={`Preview ${evidence.filename}`}
          >
            {evidence.filename}
          </button>
        );
      } else {
        nodes.push(token);
      }

      lastIndex = end;
    }

    if (lastIndex < text.length) {
      nodes.push(text.slice(lastIndex));
    }

    if (!hasReplacement) {
      return <RichTextBlock text={text} />;
    }

    return <span style={{ lineHeight: 1.5 }}>{nodes}</span>;
  }

  function renderBedrockList(items?: unknown[]) {
    if (!items || items.length === 0) {
      return <div style={{ color: "var(--text-muted)" }}>None reported.</div>;
    }

    const normalized = normalizeItems(items);

    return (
      <ul style={{ margin: "6px 0 0 18px", padding: 0, lineHeight: 1.5 }}>
        {normalized.map((item, idx) => (
          <li key={`bedrock-${idx}`}>{renderBedrockTextWithLinks(item, `bedrock-${idx}`)}</li>
        ))}
      </ul>
    );
  }

  function canPreviewInBrowser(item: EvidenceLinkItem): boolean {
    const fileType = (item.file_type || "").toLowerCase();
    const filename = item.filename.toLowerCase();
    return (
      ["pdf", "txt", "csv", "json", "msg", "png", "jpg", "jpeg", "gif", "webp", "doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(fileType) ||
      /\.(pdf|txt|csv|json|msg|png|jpe?g|gif|webp|docx?|xlsx?|pptx?)$/i.test(filename)
    );
  }

  function isOfficeConvertible(item: EvidenceLinkItem): boolean {
    const fileType = (item.file_type || "").toLowerCase();
    const filename = item.filename.toLowerCase();
    return ["doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(fileType) || /\.(docx?|xlsx?|pptx?)$/i.test(filename);
  }

  async function handleEvidenceOpen(item: EvidenceLinkItem): Promise<void> {
    if (canPreviewInBrowser(item)) {
      if (requestId && isOfficeConvertible(item)) {
        try {
          await ensureEvidencePreviewAvailable(requestId, item.evidence_id);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Office preview is unavailable";
          showToast(message, "warning");
          return;
        }
      }

      setSelectedEvidence(item);
      return;
    }

    showToast(
      "This file type cannot be rendered inline in the browser. Open is available only for browser-previewable formats.",
      "warning"
    );
  }

  function dedupeEvidenceItems(items: EvidenceLinkItem[]): EvidenceLinkItem[] {
    const seen = new Set<string>();
    const unique: EvidenceLinkItem[] = [];

    for (const item of items) {
      const byId = String(item.evidence_id || "").trim();
      const byPath = String(item.storage_path || "").trim().toLowerCase();
      const byName = String(item.filename || "").trim().toLowerCase();
      const key = byId || byPath || byName;
      if (!key) {
        unique.push(item);
        continue;
      }
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(item);
    }

    return unique;
  }

  async function openEvidenceListModal() {
    if (!requestId) {
      return;
    }

    setShowEvidenceListModal(true);
    setEvidenceListLoading(true);
    setEvidenceListError(null);
    try {
      const items = await Promise.race([
        getEvidenceItems(requestId),
        new Promise<EvidenceLinkItem[]>((_, reject) => {
          window.setTimeout(
            () => reject(new Error("Evidence list is taking too long. Please retry.")),
            18000
          );
        }),
      ]);
      if (isMountedRef.current) {
        setEvidenceItems(dedupeEvidenceItems(items));
      }
    } catch (err) {
      if (isMountedRef.current) {
        setEvidenceListError(err instanceof Error ? err.message : "Failed to load evidence list");
      }
    } finally {
      if (isMountedRef.current) {
        setEvidenceListLoading(false);
      }
    }
  }

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab === "status") {
      setActiveTab("status");
    } else if (tab === "logs") {
      setActiveTab("logs");
    } else if (tab === "approval") {
      setActiveTab("approval");
    } else if (tab === "workflow-interaction") {
      setActiveTab("workflow-interaction");
    }
  }, [searchParams]);

  useEffect(() => {
    if (!requestId) {
      return;
    }

    // Always default the bottom workflow section to Workflow Status when opening a workflow request.
    setActiveTab("status");
  }, [requestId]);

  useEffect(() => {
    if (activeTab !== "status") {
      return;
    }

    // Keep workflow view clean by default whenever the status section is selected.
    uploadSummaryDismissedRef.current = true;
    setShowWorkflowObservability(false);
    setShowUploadSummary(false);
    setShowAnalysisSection(false);
    setShowDraftEmailSection(false);
    setShowDraftReportSection(false);
  }, [activeTab]);

  useEffect(() => {
    if (!requestId) {
      setEvidenceItems([]);
      return;
    }

    let disposed = false;
    void getEvidenceItems(requestId)
      .then((items) => {
        if (!disposed && isMountedRef.current) {
          setEvidenceItems(dedupeEvidenceItems(items));
        }
      })
      .catch(() => {
        // Keep the last known evidence list if background refresh fails.
      });

    return () => {
      disposed = true;
    };
  }, [requestId, request?.evidence_count]);

  useEffect(() => {
    if (!request) {
      return;
    }

    const isCompletedStage =
      request.current_stage === WorkflowStage.CONCLUSION ||
      request.current_stage === WorkflowStage.APPROVAL ||
      request.current_stage === WorkflowStage.EXPORTED;

    if (!isCompletedStage) {
      return;
    }

    const autoOpenKey = `completed:${requestId}:${request.current_stage}`;
    if (uploadSummaryDismissedRef.current || uploadSummaryAutoOpenKeyRef.current === autoOpenKey) {
      return;
    }

    tryAutoOpenUploadSummary(autoOpenKey);
  }, [requestId, request?.current_stage]);

  useEffect(() => {
    if (!requestId) {
      return;
    }

    const pendingSummaryRequestId = sessionStorage.getItem(
      "evidex-post-upload-summary-request"
    );

    const validationRaw = localStorage.getItem(
      `evidex-agent-result-${requestId}`
    );
    const conclusionRaw = localStorage.getItem(
      `evidex-agent-conclusion-${requestId}`
    );
    const bedrockRaw = localStorage.getItem(
      `evidex-bedrock-summary-${requestId}`
    );

    const hasSummary = Boolean(validationRaw || conclusionRaw || bedrockRaw);

    if (!hasSummary) {
      return;
    }

    if (validationRaw) {
      const normalized = normalizeValidationSummary(JSON.parse(validationRaw));
      if (normalized) {
        setUploadValidation(normalized);
      }
    }

    if (conclusionRaw) {
      setUploadConclusion(
        JSON.parse(conclusionRaw) as UploadConclusionSummary
      );
    }

    if (bedrockRaw) {
      setBedrockSummary(JSON.parse(bedrockRaw) as BedrockSummary);
    }

    if (pendingSummaryRequestId === requestId) {
      sessionStorage.removeItem("evidex-post-upload-summary-request");
    }
  }, [requestId, searchParams, tryAutoOpenUploadSummary]);

  useEffect(() => {
    uploadSummaryDismissedRef.current = true;
    uploadSummaryAutoOpenKeyRef.current = null;
    setShowUploadSummary(false);
  }, [requestId]);

  // Hydrate persisted summaries from backend so completed requests still display
  // analysis after refresh or navigation, even when localStorage is empty.
  useEffect(() => {
    if (!requestId || !request || isArchivedReadOnly) {
      return;
    }

    const shouldHydrate =
      request.current_stage === WorkflowStage.VALIDATION ||
      request.current_stage === WorkflowStage.CONCLUSION ||
      request.current_stage === WorkflowStage.APPROVAL ||
      request.current_stage === WorkflowStage.EXPORTED;

    if (!shouldHydrate || outputsHydrationInFlightRef.current) {
      return;
    }

    const hasCompleteConclusionMetrics =
      typeof uploadConclusion?.confidence === "number" &&
      typeof uploadConclusion?.coverage === "number";
    const hasCompleteValidationMetrics =
      typeof uploadValidation?.overall_sufficiency_score === "number";

    // Stop hydration polling once core validation/conclusion outputs are available.
    if (hasCompleteValidationMetrics && hasCompleteConclusionMetrics) {
      return;
    }

    let cancelled = false;
    outputsHydrationInFlightRef.current = true;

    void getWorkflowOutputs(requestId)
      .then((data) => {
        if (cancelled || !isMountedRef.current) {
          return;
        }

        let recoveredAnyMissingOutput = false;

        if (data.validation) {
          if (!hasCompleteValidationMetrics) {
            recoveredAnyMissingOutput = true;
          }
          persistValidationSummary(requestId, {
            status: data.validation.status,
            overall_sufficiency: data.validation.overall_sufficiency,
            confidence: data.validation.confidence,
            recommendations: data.validation.recommendations || [],
          });
        }

        if (data.conclusion) {
          if (!hasCompleteConclusionMetrics) {
            recoveredAnyMissingOutput = true;
          }
          persistConclusionSummary(requestId, {
            overall_assessment: data.conclusion.overall_assessment,
            confidence: data.conclusion.confidence,
            coverage: data.conclusion.coverage,
            recommendations: data.conclusion.recommendations || [],
            report_sections: data.conclusion.report_sections || {},
          });
        }

        if (data.bedrock_summary) {
          if (!bedrockSummary) {
            recoveredAnyMissingOutput = true;
          }
          persistBedrockSummary(requestId, data.bedrock_summary as BedrockSummary);
        }

        if (recoveredAnyMissingOutput) {
          tryAutoOpenUploadSummary(`hydrate:${requestId}`);
          pushObservability("Recovered workflow analysis outputs from backend state.");
        }
      })
      .catch(() => {
        // Hydration errors are non-fatal; the page can still continue polling.
      })
      .finally(() => {
        outputsHydrationInFlightRef.current = false;
      });

    return () => {
      cancelled = true;
    };
  }, [requestId, request, uploadValidation, uploadConclusion, bedrockSummary, pushObservability, tryAutoOpenUploadSummary]);

  // Fetch request details
  useEffect(() => {
    const pauseBackgroundRefresh =
      autoWorkflowRunning ||
      inFlightStage === WorkflowStage.RETRIEVAL ||
      showEvidenceUploadModal;

    if (!requestId || pauseBackgroundRefresh) return;
    const currentRequestId: string = requestId;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let disposed = false;
    let isFirstFetch = true;

    async function fetchRequest(): Promise<boolean> {
      try {
        if (isFirstFetch && !request) {
          setLoading(true);
        }
        const data = await getRequestDetails(currentRequestId);
        if (disposed || !isMountedRef.current) return false;
        console.log(`[Polling] Fetched request ${currentRequestId}, current_stage=${data?.current_stage}, evidence_count=${data?.evidence_count}`);
        commitRequestUpdate(data);
        setError(null);
        setNotFound(false);
        return true;
      } catch (err) {
        if (disposed || !isMountedRef.current) return false;
        const message =
          err instanceof Error ? err.message : "Failed to fetch request";

        if (/not found|404/i.test(message)) {
          setNotFound(true);
          commitRequestUpdate(null);
          setError(null);
          return false;
        }

        if (request) {
          return true;
        }

        setError(message);
        return true;
      } finally {
        isFirstFetch = false;
        if (!disposed && isMountedRef.current) {
          setLoading(false);
        }
      }
    }

    async function startPolling() {
      const found = await fetchRequest();
      if (!found || disposed) {
        return;
      }

      intervalId = setInterval(async () => {
        const shouldContinue = await fetchRequest();
        if (!shouldContinue && intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      }, 5000);
    }

    startPolling();

    return () => {
      disposed = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [requestId, autoWorkflowRunning, inFlightStage, showEvidenceUploadModal, commitRequestUpdate]);

  // Auto-open evidence upload once when workflow reaches RETRIEVAL.
  useEffect(() => {
    if (!requestId || !request) {
      return;
    }

    const promptKey = `evidex-auto-upload-prompted-${requestId}`;
    const uploadCompletedKey = `evidex-upload-completed-${requestId}`;

    console.log(`[AutoOpen] stage=${request.current_stage}, promptKey=${sessionStorage.getItem(promptKey)}, uploadCompletedKey=${sessionStorage.getItem(uploadCompletedKey)}`);

    if (request.current_stage === WorkflowStage.RETRIEVAL) {
      const alreadyPrompted = sessionStorage.getItem(promptKey) === "1";
      const uploadJustCompleted = sessionStorage.getItem(uploadCompletedKey) === "1";
      
      // Don't re-open modal if upload just completed and we're still waiting for state update
      if (uploadJustCompleted) {
        console.log("[AutoOpen] Skipping modal re-open - upload just completed");
        return;
      }
      
      if (!alreadyPrompted) {
        console.log("[AutoOpen] Opening evidence upload modal");
        setShowEvidenceUploadModal(true);
        sessionStorage.setItem(promptKey, "1");
      }
      return;
    }

    // Clean up both keys when moving out of RETRIEVAL stage
    console.log(`[AutoOpen] Moving out of RETRIEVAL, cleaning up flags. stage=${request.current_stage}`);
    sessionStorage.removeItem(promptKey);
    sessionStorage.removeItem(uploadCompletedKey);
  }, [requestId, request, isArchivedReadOnly]);

  // Auto-detect new evidence files uploaded directly to the evidence folder
  useEffect(() => {
    const pauseBackgroundRefresh =
      autoWorkflowRunning ||
      inFlightStage === WorkflowStage.RETRIEVAL ||
      showEvidenceUploadModal;

    if (!requestId || !request || isArchivedReadOnly || pauseBackgroundRefresh) {
      return;
    }

    let lastCheckedCount = request.evidence_count || 0;
    let disposed = false;
    const pollInterval = setInterval(async () => {
      try {
        const updated = await getRequestDetails(requestId);
        if (disposed || !isMountedRef.current) {
          return;
        }
        const currentCount = updated.evidence_count || 0;

        if (currentCount > lastCheckedCount) {
          lastCheckedCount = currentCount;
          pushObservability(`New evidence detected (count ${currentCount}). Synchronizing workflow state...`);

          // Do not force retrieval while the request is already in early stages.
          // Resetting to RETRIEVAL there can regress and appear as "stuck".
          if (
            updated.current_stage === WorkflowStage.INITIALIZATION ||
            updated.current_stage === WorkflowStage.INTERPRETATION ||
            updated.current_stage === WorkflowStage.RETRIEVAL
          ) {
            commitRequestUpdate(updated);
            pushObservability("Evidence count changed while retrieval path is active. Continuing automatic progression.");
            return;
          }

          // For later stages, re-trigger retrieval so backend inventory stays in sync.
          try {
            await retrieveEvidence(requestId, ["/audit/evidence"]);
            lastAutoStageRef.current = null;
            const finalSync = await getRequestDetails(requestId);
            commitRequestUpdate(finalSync);
          } catch (syncErr) {
            pushObservability(`Auto-rerun sync failed: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`);
          }
        }
      } catch {
        // polling errors are intentionally ignored to keep UI responsive
      }
    }, 3000); // Poll every 3 seconds

    return () => {
      disposed = true;
      clearInterval(pollInterval);
    };
  }, [requestId, request, pushObservability, isArchivedReadOnly, autoWorkflowRunning, inFlightStage, showEvidenceUploadModal, commitRequestUpdate]);

  // Automatically progress through executable stages while preserving full traceability in Step Logs.
  useEffect(() => {
    if (!requestId || !request || autoWorkflowRunning || autoWorkflowLockRef.current || isArchivedReadOnly) {
      return;
    }

    const stageSnapshotKey = `${requestId}:${request.current_stage}:${request.evidence_count ?? 0}`;
    if (lastAutoStageRef.current === stageSnapshotKey) {
      console.log(`[AutoWorkflow] Deduped same stage snapshot: ${stageSnapshotKey}`);
      return;
    }
    lastAutoStageRef.current = stageSnapshotKey;

    console.log(`[AutoWorkflow] Starting for stage=${request.current_stage}, evidence_count=${request.evidence_count}`);

    const typedRequestId: string = requestId;
    const initialRequest: RequestDetails = request;
    const terminalStages: WorkflowStage[] = [
      WorkflowStage.APPROVAL,
      WorkflowStage.EXPORTED,
    ];

    if (terminalStages.includes(request.current_stage)) {
      console.log(`[AutoWorkflow] Reached terminal stage: ${request.current_stage}`);
      return;
    }

    // Clean up upload completed flag since we're now progressing
    if (request.current_stage !== WorkflowStage.RETRIEVAL) {
      console.log(`[AutoWorkflow] Cleaning up uploadCompletedKey - no longer in RETRIEVAL`);
      sessionStorage.removeItem(`evidex-upload-completed-${requestId}`);
    }

    let cancelled = false;

    async function runAutoWorkflow() {
      let currentAutoStage: WorkflowStage = initialRequest.current_stage;

      async function runStageWithSingleRetry<T>(stage: WorkflowStage, action: () => Promise<T>): Promise<T> {
        const retryKey = `${typedRequestId}:${stage}`;

        try {
          return await action();
        } catch (firstError) {
          const used = stageRetryCountsRef.current[retryKey] || 0;
          if (used >= MAX_PROCESS_RETRIES) {
            throw firstError;
          }

          stageRetryCountsRef.current[retryKey] = used + 1;
          pushObservability(`${formatWorkflowStage(stage)} failed. Retrying once (${used + 1}/${MAX_PROCESS_RETRIES})...`);
          return await action();
        }
      }

      try {
        setAutoWorkflowRunning(true);
        setError(null);
        setWorkflowFailure(null);

        let currentRequest: RequestDetails = initialRequest;
        let keepRunning = true;

        while (!cancelled && keepRunning) {
          currentAutoStage = currentRequest.current_stage;
          switch (currentRequest.current_stage) {
            case WorkflowStage.INITIALIZATION: {
              setInFlightStage(WorkflowStage.INTERPRETATION);
              await runStageWithSingleRetry(WorkflowStage.INTERPRETATION, async () => {
                pushObservability("Initialization complete. Starting interpretation...");
                await interpretRequest(typedRequestId);
              });
              setLastSuccessfulStage(WorkflowStage.INTERPRETATION);
              pushObservability("Interpretation completed and tasks were extracted.");
              break;
            }
            case WorkflowStage.INTERPRETATION: {
              setInFlightStage(WorkflowStage.RETRIEVAL);
              const retrievalResponse = await runStageWithSingleRetry(WorkflowStage.RETRIEVAL, async () => {
                pushObservability("Starting retrieval to collect candidate evidence sources...");
                return await retrieveEvidence(typedRequestId, ["/audit/evidence"]);
              });

              if (retrievalResponse.pre_retrieval) {
                const prep = retrievalResponse.pre_retrieval;
                pushObservability("Pre-retrieval folder setup is in progress...");
                if (prep.project_already_exists) {
                  pushObservability("Project folder already exists. Proceeding immediately to request ID folder creation.");
                } else {
                  pushObservability("Project folder created for this retrieval run.");
                }
                if (prep.request_folder_already_exists) {
                  pushObservability("Request ID folder already exists and is ready.");
                } else {
                  pushObservability("Request ID folder created and ready for evidence ingestion.");
                }
              }

              if ((retrievalResponse.evidence_items || 0) <= 0) {
                setLastSuccessfulStage(WorkflowStage.RETRIEVAL);
                setShowEvidenceUploadModal(true);
                pushObservability("NO EVIDENCE FOUND. Retrieval returned zero files; waiting for user upload before continuing.");
                
                // Show toast only once per request to prevent duplicate notifications
                const toastKey = `evidex-no-evidence-toast-${typedRequestId}`;
                if (sessionStorage.getItem(toastKey) !== "1") {
                  showToast("No evidence found. Upload files to continue the workflow.", "warning");
                  sessionStorage.setItem(toastKey, "1");
                }
                
                keepRunning = false;
                break;
              }
              setLastSuccessfulStage(WorkflowStage.RETRIEVAL);
              pushObservability("Retrieval completed. Evidence inventory prepared.");
              break;
            }
            case WorkflowStage.RETRIEVAL: {
              setInFlightStage(WorkflowStage.VALIDATION);
              if ((currentRequest.evidence_count || 0) <= 0) {
                pushObservability("NO EVIDENCE FOUND. Running validation with an empty evidence set.");
              }

              const validationResponse = await runStageWithSingleRetry(WorkflowStage.VALIDATION, async () => {
                pushObservability("Starting validation...");
                return await validateEvidence(typedRequestId);
              });

              persistValidationSummary(typedRequestId, validationResponse.validation);
              setLastSuccessfulStage(WorkflowStage.VALIDATION);
              pushObservability("Validation completed. Transitioning to summarization and conclusion...");
              break;
            }
            case WorkflowStage.VALIDATION: {
              setInFlightStage(WorkflowStage.CONCLUSION);
              const conclusionResponse = await runStageWithSingleRetry(WorkflowStage.CONCLUSION, async () => {
                pushObservability("Validation stage reached. Generating summarization and conclusion...");
                return await generateConclusion(typedRequestId);
              });

              persistConclusionSummary(typedRequestId, conclusionResponse.conclusion);
              if (conclusionResponse.bedrock_summary) {
                persistBedrockSummary(typedRequestId, conclusionResponse.bedrock_summary as BedrockSummary);
                pushObservability("Bedrock analysis refreshed from conclusion output.");
              }
              setLastSuccessfulStage(WorkflowStage.CONCLUSION);
              pushObservability("Summarization and conclusion completed.");
              break;
            }
            case WorkflowStage.CONCLUSION: {
              setLastSuccessfulStage(WorkflowStage.CONCLUSION);
              pushObservability("Workflow reached conclusion stage. Ready for approval.");
              tryAutoOpenUploadSummary(`auto-conclusion:${typedRequestId}`);
              keepRunning = false;
              break;
            }
            default: {
              keepRunning = false;
            }
          }

          if (!keepRunning || cancelled) {
            break;
          }

          currentRequest = await getRequestDetails(typedRequestId);
          if (cancelled) {
            return;
          }
          commitRequestUpdate(currentRequest);
        }
      } catch (err) {
        if (!cancelled) {
          pushObservability("Automatic progression paused due to an error.");
          reportWorkflowFailure(currentAutoStage, err, "Auto workflow failed");
          pushObservability("Retrying same stage after previous failure.");
          // Allow the same stage snapshot to re-run on the next poll/render.
          // Without this, a transient failure at RETRIEVAL or VALIDATION can
          // leave the workflow stuck because the dedupe key never changes.
          lastAutoStageRef.current = null;
        }
      } finally {
        if (cancelled) {
          // React StrictMode cleanup fired before the workflow finished.
          // Reset snapshot guard so the re-mounted effect can restart from
          // the current stage without being blocked by the stale snapshot key.
          lastAutoStageRef.current = null;
        } else {
          const latest = await getRequestDetails(typedRequestId).catch(() => null);
          if (isMountedRef.current && latest) {
            commitRequestUpdate(latest);
          }
        }
        // Always reset running flags so no stale `true` can block re-entry.
        autoWorkflowLockRef.current = false;
        if (isMountedRef.current) {
          setInFlightStage(null);
          setAutoWorkflowRunning(false);
        }
      }
    }

    autoWorkflowLockRef.current = true;
    runAutoWorkflow();

    return () => {
      cancelled = true;
      autoWorkflowLockRef.current = false;
      lastAutoStageRef.current = null;
    };
  }, [requestId, request, autoWorkflowRunning, pushObservability, reportWorkflowFailure, showToast, tryAutoOpenUploadSummary, isArchivedReadOnly, commitRequestUpdate]);

  useEffect(() => {
    lastAutoStageRef.current = null;
    setInFlightStage(null);
    setLastSuccessfulStage(null);
    stageRetryCountsRef.current = {};
    autoWorkflowLockRef.current = false;
  }, [requestId]);

  useEffect(() => {
    if (!request) {
      return;
    }

    const currentStage = request.current_stage;
    const stageChanged = previousRequestStageRef.current !== currentStage;
    previousRequestStageRef.current = currentStage;

    const resolvedSuccessfulStage = resolveLastSuccessfulStageFromCurrent(currentStage);
    setLastSuccessfulStage((prev) =>
      prev === resolvedSuccessfulStage ? prev : resolvedSuccessfulStage
    );

    if (stageChanged) {
      setInFlightStage(null);
    }

    if (
      currentStage === WorkflowStage.CONCLUSION ||
      currentStage === WorkflowStage.APPROVAL ||
      currentStage === WorkflowStage.EXPORTED
    ) {
      setAutoWorkflowRunning(false);
    }

    if (stageChanged) {
      pushObservability(`Workflow synchronized to ${formatWorkflowStage(currentStage)} stage.`);
    }
  }, [request, pushObservability]);

  const safeRequestId = requestId ?? "N/A";
  const auditorsEmail = request?.auditor_email ?? "N/A";
  const parsedBedrockSummary: ParsedBedrockSummary | null =
    bedrockSummary?.parsed_summary && Object.keys(bedrockSummary.parsed_summary).length > 0
      ? bedrockSummary.parsed_summary
      : parseBedrockSummaryFromRaw(bedrockSummary?.summary);
  const isCompletedWorkflowStage = Boolean(
    request &&
      (
        request.current_stage === WorkflowStage.CONCLUSION ||
        request.current_stage === WorkflowStage.APPROVAL ||
        request.current_stage === WorkflowStage.EXPORTED
      )
  );
  const hasUploadSummaryData = Boolean(uploadValidation || uploadConclusion || bedrockSummary);
  const hasCompletedValidationAndConclusionSummary = Boolean(uploadValidation && uploadConclusion);
  const isFinalConclusionCompleted = Boolean(
    isCompletedWorkflowStage &&
      hasCompletedValidationAndConclusionSummary &&
      !autoWorkflowRunning &&
      inFlightStage !== WorkflowStage.CONCLUSION
  );
  const insufficiencyNarrativeSignals = [
    "insufficient",
    "partial",
    "partially",
    "lacks",
    "lack",
    "missing",
    "gap",
    "not provided",
    "not available",
    "no evidence",
    "requires additional evidence",
  ];

  const normalizedValidationStatus = String(uploadValidation?.status || "")
    .trim()
    .toLowerCase();
  const validationScore =
    typeof (uploadValidation?.overall_sufficiency_score ?? uploadValidation?.overall_sufficiency) === "number"
      ? Number(uploadValidation?.overall_sufficiency_score ?? uploadValidation?.overall_sufficiency)
      : undefined;
  const hasModelSufficientStatus = normalizedValidationStatus === "sufficient";
  const hasScoreSufficientStatus = typeof validationScore === "number" && validationScore >= 0.85;
  const hasExplicitInsufficientStatus =
    normalizedValidationStatus === "insufficient" || normalizedValidationStatus === "partial";

  const hasSufficientOutcome =
    hasModelSufficientStatus ||
    hasScoreSufficientStatus ||
    (uploadValidation?.sufficient === true && !hasExplicitInsufficientStatus);

    // Bedrock's calculated status takes precedence: >= 0.85 is Sufficient, < 0.85 is Insufficient
    const bedrockScore = parsedBedrockSummary?.calculated_validation_score;
    const bedrockStatus = parsedBedrockSummary?.validation_status;
    const hasBedrockSufficientStatus = bedrockStatus === "sufficient" || (typeof bedrockScore === "number" && bedrockScore >= 0.85);
  
    const finalHasSufficientOutcome =
      !hasExplicitInsufficientStatus && (
        typeof bedrockScore === "number" ? hasBedrockSufficientStatus : hasSufficientOutcome
      );

    const hasInsufficientOutcome = !finalHasSufficientOutcome;
  const missingEvidenceItems = useMemo(() => {
    if (!hasInsufficientOutcome) {
      return [];
    }

    const missingSignals = ["missing", "gap", "insufficient", "not provided", "not available", "lack"];
    const fromRisks = normalizeItems(parsedBedrockSummary?.risks);
    const fromFindings = normalizeItems(parsedBedrockSummary?.key_findings).filter((entry) => {
      const normalized = entry.toLowerCase();
      return missingSignals.some((signal) => normalized.includes(signal));
    });

    const combined = Array.from(new Set([...fromRisks, ...fromFindings])).filter(
      (entry) => !isControlOwnershipLine(entry)
    );

    if (combined.length > 0) {
      return combined;
    }

    return [
      "Supporting evidence is incomplete for one or more requested audit assertions.",
    ];
  }, [hasInsufficientOutcome, parsedBedrockSummary]);

  const insufficiencyRecommendations = useMemo(() => {
    if (!hasInsufficientOutcome) {
      return [];
    }

    const fromValidation = normalizeItems(uploadValidation?.gap_recommendations);
    const fromConclusion = normalizeItems(uploadConclusion?.recommendations);
    const fromBedrock = normalizeItems(parsedBedrockSummary?.recommended_next_steps);
    const merged = Array.from(new Set([...fromValidation, ...fromConclusion, ...fromBedrock])).filter(
      (entry) => {
        const normalized = entry.toLowerCase();
        return (
          !normalized.includes("minimum suggested evidence items") &&
          !normalized.includes("at least 3-5") &&
          !normalized.includes("3-5 supporting") &&
          !isTechnicalSufficiencyLine(entry) &&
          !isControlOwnershipLine(entry)
        );
      }
    );

    if (merged.length > 0) {
      return sortRecommendationsByRisk(merged);
    }

    return [];
  }, [hasInsufficientOutcome, uploadValidation, uploadConclusion, parsedBedrockSummary]);

  const insufficiencyAssessment =
    uploadConclusion?.overall_assessment ||
    parsedBedrockSummary?.sufficiency_assessment ||
    "Insufficient";

  const sufficiencyAssessment =
    uploadConclusion?.overall_assessment ||
    parsedBedrockSummary?.sufficiency_assessment ||
    "Sufficient";

  const reportClientName = useMemo(() => {
    const storedRequests = getStoredRequests();
    const activeRequest = storedRequests.find((entry) => entry.id === safeRequestId);
    const organization = String(
      activeRequest?.organization
      || sessionStorage.getItem("evidex-organization")
      || ""
    );
    return extractClientName(organization, String(request?.category || ""));
  }, [safeRequestId, request?.category]);

  const sufficiencyRationale = useMemo(() => {
    if (!finalHasSufficientOutcome) {
      return [];
    }

    const fromFindings = normalizeItems(parsedBedrockSummary?.key_findings).filter((entry) => {
      const normalized = entry.toLowerCase();
      return (
        !insufficiencyNarrativeSignals.some((signal) => normalized.includes(signal)) &&
        (
          normalized.includes("covered") ||
          normalized.includes("evidence") ||
          normalized.includes("supported") ||
          normalized.includes("validated") ||
          normalized.includes("complete")
        )
      );
    });
    const fromSummary = parsedBedrockSummary?.executive_summary
      ? [parsedBedrockSummary.executive_summary]
      : [];
    const fromAssessment = parsedBedrockSummary?.sufficiency_assessment
      ? [parsedBedrockSummary.sufficiency_assessment]
      : [];
    const fromConclusion = uploadConclusion?.overall_assessment
      ? [uploadConclusion.overall_assessment]
      : [];
    const combined = Array.from(
      new Set([...fromFindings, ...fromSummary, ...fromAssessment, ...fromConclusion])
    ).filter(
      (entry) =>
        !isControlOwnershipLine(entry) &&
        !/overall\s*sufficiency\s*is|based on the strongest|including\s+.+\.(?:\s*|$)|collectively provide enough relevance|>=\s*\d+%/i.test(entry)
    );
    if (combined.length > 0) {
      return combined;
    }

    return [
      "Required evidence checkpoints are covered by the submitted materials and validation outputs.",
    ];
  }, [finalHasSufficientOutcome, parsedBedrockSummary, uploadConclusion]);

  const sufficiencyImprovementRecommendations = useMemo(() => {
    if (!finalHasSufficientOutcome) {
      return [];
    }

    const fromBedrockNextSteps = normalizeItems(parsedBedrockSummary?.recommended_next_steps);
    const filtered = fromBedrockNextSteps.filter((entry) => {
      const normalized = entry.toLowerCase();
      return (
        !normalized.includes("minimum suggested evidence items") &&
        !normalized.includes("at least 3-5") &&
        !normalized.includes("3-5 supporting") &&
        !isTechnicalSufficiencyLine(entry) &&
        !isControlOwnershipLine(entry)
      );
    });

    if (filtered.length > 0) {
      return sortRecommendationsByRisk(Array.from(new Set(filtered)));
    }

    return [];
  }, [finalHasSufficientOutcome, parsedBedrockSummary]);

  const draftSufficiencyReport = useMemo(
    () =>
      buildSufficiencyReportDraft({
        requestId: safeRequestId,
        auditorEmail: auditorsEmail || "N/A",
        clientName: reportClientName,
        assessment: sufficiencyAssessment,
        sufficiencyScore: uploadValidation?.overall_sufficiency_score,
        conclusionConfidence: uploadConclusion?.confidence,
        coverage: uploadConclusion?.coverage,
        rationalePoints: sufficiencyRationale,
        recommendations: sufficiencyImprovementRecommendations,
        modelReportSections: uploadConclusion?.report_sections,
        templateVariant: reportTemplateVariant,
      }),
    [
      safeRequestId,
      auditorsEmail,
      reportClientName,
      sufficiencyAssessment,
      uploadValidation,
      uploadConclusion,
      sufficiencyRationale,
      sufficiencyImprovementRecommendations,
      reportTemplateVariant,
    ]
  );

  const approvalRecommendations = useMemo(() => {
    if (!finalHasSufficientOutcome) {
      return [];
    }

    const fromValidation = normalizeItems(uploadValidation?.gap_recommendations);
    const fromConclusion = normalizeItems(uploadConclusion?.recommendations);
    const fromBedrock = normalizeItems(parsedBedrockSummary?.recommended_next_steps);
    const merged = Array.from(new Set([...fromValidation, ...fromConclusion, ...fromBedrock])).filter(
      (entry) => {
        const normalized = entry.toLowerCase();
        return (
          !normalized.includes("minimum suggested evidence items") &&
          !normalized.includes("at least 3-5") &&
          !normalized.includes("3-5 supporting") &&
          !isTechnicalSufficiencyLine(entry) &&
          !isControlOwnershipLine(entry)
        );
      }
    );

    if (merged.length > 0) {
      return sortRecommendationsByRisk(merged);
    }

    return [];
  }, [finalHasSufficientOutcome, uploadValidation, uploadConclusion, parsedBedrockSummary]);

  const approvalAssessment =
    uploadConclusion?.overall_assessment ||
      (finalHasSufficientOutcome ? "Sufficient" : "Insufficient");
  const analysisRecommendations = finalHasSufficientOutcome
    ? approvalRecommendations
    : insufficiencyRecommendations;

  const validationConclusionProfessionalReport = useMemo(
    () =>
      buildValidationConclusionProfessionalReport({
        requestId: safeRequestId,
        auditorEmail: auditorsEmail,
        clientName: reportClientName,
        requestSummary: request?.request_text || "",
        assessment: approvalAssessment,
        sufficiencyScore: uploadValidation?.overall_sufficiency_score,
        conclusionConfidence: uploadConclusion?.confidence,
        coverage: uploadConclusion?.coverage,
        rationalePoints: sufficiencyRationale,
        gapItems: finalHasSufficientOutcome ? [] : missingEvidenceItems,
        recommendations: finalHasSufficientOutcome
          ? sufficiencyImprovementRecommendations
          : insufficiencyRecommendations,
        modelReportSections: uploadConclusion?.report_sections,
        templateVariant: reportTemplateVariant,
      }),
    [
      safeRequestId,
      auditorsEmail,
      reportClientName,
      request?.request_text,
      finalHasSufficientOutcome,
      uploadValidation,
      uploadConclusion,
      sufficiencyRationale,
      sufficiencyImprovementRecommendations,
      missingEvidenceItems,
      insufficiencyRecommendations,
      reportTemplateVariant,
    ]
  );

  const draftInsufficiencyReport = useMemo(
    () =>
      buildInsufficiencyReportDraft({
        requestId: safeRequestId,
        auditorEmail: auditorsEmail,
        clientName: reportClientName,
        requestSummary: request?.request_text || "",
        assessment: insufficiencyAssessment,
        sufficiencyScore: uploadValidation?.overall_sufficiency_score,
        conclusionConfidence: uploadConclusion?.confidence,
        coverage: uploadConclusion?.coverage,
        gapItems: missingEvidenceItems,
        recommendations: insufficiencyRecommendations,
        modelReportSections: uploadConclusion?.report_sections,
        templateVariant: reportTemplateVariant,
      }),
    [
      safeRequestId,
      auditorsEmail,
      reportClientName,
      request?.request_text,
      insufficiencyAssessment,
      uploadValidation,
      uploadConclusion,
      missingEvidenceItems,
      insufficiencyRecommendations,
      reportTemplateVariant,
    ]
  );

  const draftFollowUpEmail = useMemo(
    () =>
      buildInsufficiencyEmailDraft({
        requestId: safeRequestId,
        assessment: insufficiencyAssessment,
        missingItems: missingEvidenceItems,
        recommendations: insufficiencyRecommendations,
        templateVariant: emailTemplateVariant,
      }),
    [
      safeRequestId,
      insufficiencyAssessment,
      missingEvidenceItems,
      insufficiencyRecommendations,
      emailTemplateVariant,
    ]
  );

  const editableDraftEmailText = savedDraftEmailText ?? draftFollowUpEmail;
  const visibleDraftReportText = finalHasSufficientOutcome
    ? draftSufficiencyReport
    : draftInsufficiencyReport;
  const editableDraftReportText = savedDraftReportText ?? visibleDraftReportText;
  const editableApprovalReportText = savedDraftReportText ?? validationConclusionProfessionalReport;

  useEffect(() => {
    setSavedDraftEmailText(null);
    setDraftEmailEditorText("");
    setShowDraftEmailEditor(false);
  }, [draftFollowUpEmail]);

  useEffect(() => {
    setSavedDraftReportText(null);
    setDraftReportEditorText("");
    setShowDraftReportEditor(false);
  }, [visibleDraftReportText, validationConclusionProfessionalReport]);

  const executiveSummaryText = useMemo(() => {
    const modelExecutive = formatModelSection(parsedBedrockSummary?.executive_summary);
    const modelContext = formatModelSection(uploadConclusion?.report_sections?.engagement_context);
    const modelHighlights = formatModelSection(uploadConclusion?.report_sections?.review_highlights);
    const modelImplication =
      formatModelSection(parsedBedrockSummary?.sufficiency_assessment) ||
      formatModelSection(uploadConclusion?.report_sections?.conclusion);

    return toTwoSentenceSummary(
      [modelExecutive, modelContext || modelHighlights, modelImplication].filter(Boolean).join(" "),
      "Executive summary is not yet available for this request."
    );
  }, [parsedBedrockSummary, uploadConclusion]);

  const quickSummaryText = useMemo(() => {
    const modelSnapshotCandidates = Array.from(
      new Set(
        [
          formatModelSection(uploadConclusion?.overall_assessment),
          formatModelSection(uploadConclusion?.report_sections?.review_highlights),
          ...normalizeItems(parsedBedrockSummary?.key_findings),
          formatModelSection(parsedBedrockSummary?.sufficiency_assessment),
        ]
          .filter(Boolean)
          .map((entry) => String(entry).replace(/\s+/g, " ").trim())
          .filter((entry) => !isTechnicalSufficiencyLine(entry) && !isControlOwnershipLine(entry))
      )
    );

    const normalizeForCompare = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
    const executiveNormalized = normalizeForCompare(executiveSummaryText);

    const filteredForDistinctness = modelSnapshotCandidates.filter(
      (entry) => normalizeForCompare(entry) !== executiveNormalized
    );

    const chosen = (filteredForDistinctness.length > 0 ? filteredForDistinctness : modelSnapshotCandidates)
      .slice(0, 5);

    if (chosen.length > 0) {
      return toTwoSentenceSummary(chosen.join(" "), chosen[0]);
    }

    return "Quick summary is not yet available for this request.";
  }, [parsedBedrockSummary, uploadConclusion, executiveSummaryText]);

  const workflowObservabilityTile =
    workflowObservability.length > 0 || autoWorkflowRunning ? (
      <div
        style={{
          padding: "10px 12px",
          border: "1px dashed var(--border-color)",
          borderRadius: "10px",
          background: "var(--card-bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: showWorkflowObservability ? "6px" : 0,
          }}
        >
          <div style={{ fontSize: "10px", color: "var(--text-muted)", fontWeight: 600 }}>
            Workflow Observability
          </div>
          <button
            type="button"
            onClick={() => setShowWorkflowObservability((prev) => !prev)}
            style={{
              border: "1px solid var(--border-color)",
              background: "transparent",
              color: "inherit",
              borderRadius: "6px",
              padding: "3px 5px",
              cursor: "pointer",
              fontSize: "10px",
              display: "inline-flex",
              alignItems: "center",
            }}
            aria-label={showWorkflowObservability ? "Hide workflow observability" : "Show workflow observability"}
            title={showWorkflowObservability ? "Hide workflow observability" : "Show workflow observability"}
          >
            <FontAwesomeIcon icon={showWorkflowObservability ? faChevronUp : faChevronDown} />
          </button>
        </div>

        {showWorkflowObservability && (
          <div
            style={{
              display: "grid",
              gap: "4px",
              maxHeight: "130px",
              overflowY: "auto",
              paddingRight: "2px",
            }}
          >
            {[...workflowObservability].slice(-12).reverse().map((event) => {
              const tone = categoryTagStyles(event.category);
              return (
                <div
                  key={event.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "72px 1fr",
                    gap: "8px",
                    alignItems: "start",
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                    padding: "4px 6px",
                    background: "var(--bg-color)",
                  }}
                >
                  <div
                    style={{
                      margin: 0,
                      color: "var(--text-muted)",
                      fontSize: "9px",
                      lineHeight: "1.3",
                      fontWeight: 600,
                    }}
                  >
                    {formatDateTimeDMY(event.timestamp)}
                  </div>
                  <div
                    style={{
                      margin: 0,
                      color: "var(--text-muted)",
                      fontSize: "10px",
                      lineHeight: "1.35",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        borderRadius: "999px",
                        fontSize: "9px",
                        fontWeight: 700,
                        padding: "1px 6px",
                        marginRight: "6px",
                        background: tone.bg,
                        border: `1px solid ${tone.border}`,
                        color: tone.text,
                        textTransform: "uppercase",
                        letterSpacing: "0.02em",
                      }}
                    >
                      {event.category}
                    </span>
                    {event.message}
                  </div>
                </div>
              );
            })}

            {autoWorkflowRunning && !uiFreezeActive && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "72px 1fr",
                  gap: "8px",
                  alignItems: "start",
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  padding: "4px 6px",
                  background: "var(--bg-color)",
                }}
              >
                <div
                  style={{
                    margin: 0,
                    color: "var(--text-muted)",
                    fontSize: "9px",
                    lineHeight: "1.3",
                    fontWeight: 600,
                  }}
                >
                  LIVE
                </div>
                <div
                  style={{
                    margin: 0,
                    color: "var(--text-muted)",
                    fontSize: "10px",
                    lineHeight: "1.35",
                  }}
                >
                  {inFlightStage
                    ? `Executing ${formatWorkflowStage(inFlightStage)} stage...`
                    : "Processing next workflow transition..."}
                </div>
              </div>
            )}

            {uiFreezeActive && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "72px 1fr",
                  gap: "8px",
                  alignItems: "start",
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  padding: "4px 6px",
                  background: "var(--bg-color)",
                }}
              >
                <div
                  style={{
                    margin: 0,
                    color: "var(--text-muted)",
                    fontSize: "9px",
                    lineHeight: "1.3",
                    fontWeight: 600,
                  }}
                >
                  HOLD
                </div>
                <div
                  style={{
                    margin: 0,
                    color: "var(--text-muted)",
                    fontSize: "10px",
                    lineHeight: "1.35",
                  }}
                >
                  Processing in background. UI updates will resume after workflow completion.
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    ) : null;

  function handleArchiveCurrentRequest() {
    if (isArchivedReadOnly) {
      showToast("This request is already archived and read-only.", "warning");
      return;
    }

    if (!requestId) {
      showToast("No request selected to archive.", "error");
      return;
    }

    const requestExists = getStoredRequests().some((entry) => entry.id === requestId);
    if (!requestExists) {
      showToast("Request is not available in local history to archive.", "error");
      return;
    }

    moveRequestToArchive(requestId, sessionStorage.getItem("userEmail") || "");
    showToast("Request archived.", "success");
    navigate("/archive");
  }

  if (requestId && loading && !request && !notFound) {
    return (
      <div style={{ maxWidth: "1400px", margin: "48px auto", padding: "0 24px" }}>
        <p>Loading audit request...</p>
      </div>
    );
  }

  if (!requestId) {
    return (
      <div style={{ maxWidth: "1400px", margin: "48px auto", padding: "0 24px" }}>
        <div style={{ marginBottom: "32px" }}>
          <h1 style={{ margin: "0 0 8px 0" }}>Workflow</h1>
          <p style={{ margin: 0, color: "var(--text-muted)" }}>
            Select or create an audit request to populate workflow data.
          </p>
        </div>

        <div
          style={{
            display: "flex",
            gap: "8px",
            marginBottom: "24px",
            borderBottom: "2px solid var(--border-color)",
          }}
        >
          {[
            { id: "status", label: "Workflow Status" },
            { id: "approval", label: "Review & Approval" },
            { id: "logs", label: "Process Traceability" },
            { id: "workflow-interaction", label: "Interact" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              style={{
                padding: "12px 16px",
                background: "transparent",
                border: "none",
                borderBottom:
                  activeTab === tab.id ? "3px solid var(--evidex-green)" : "3px solid transparent",
                fontWeight: activeTab === tab.id ? 600 : 400,
                color: "inherit",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "status" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
            <div
              style={{
                border: "2px solid var(--evidex-green)",
                borderRadius: "12px",
                padding: "24px",
                background: "var(--card-bg)",
              }}
            >
              <h3 style={{ marginTop: 0, marginBottom: "12px", fontSize: "18px", fontWeight: 600 }}>
                Workflow Status
              </h3>
              <p style={{ margin: 0, color: "var(--text-muted)" }}>No request selected.</p>
            </div>

            <div
              style={{
                border: "2px solid var(--evidex-green)",
                borderRadius: "12px",
                padding: "24px",
                background: "var(--card-bg)",
              }}
            >
              <h3 style={{ marginTop: 0, marginBottom: "12px", fontSize: "18px", fontWeight: 600 }}>
                Request Information
              </h3>
              <p style={{ margin: 0, color: "var(--text-muted)" }}>No request selected.</p>
            </div>
          </div>
        )}

        {activeTab === "logs" && (
          <div
            style={{
              border: "1px solid var(--border-color)",
              borderRadius: "10px",
              background: "var(--card-bg)",
              padding: "12px",
            }}
          >
            <div style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: 600, marginBottom: "10px" }}>
              Process Traceability
            </div>
            <p style={{ margin: 0, color: "var(--text-muted)" }}>No step logs available.</p>
          </div>
        )}

        {activeTab === "approval" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
            <div
              style={{
                border: "2px solid var(--evidex-green)",
                borderRadius: "12px",
                padding: "24px",
                background: "var(--card-bg)",
              }}
            >
              <h3 style={{ marginTop: 0, marginBottom: "12px", fontSize: "18px", fontWeight: 600 }}>
                Review & Approval
              </h3>
              <p style={{ margin: 0, color: "var(--text-muted)" }}>No request selected.</p>
            </div>

            <div
              style={{
                border: "2px solid var(--evidex-green)",
                borderRadius: "12px",
                padding: "24px",
                background: "var(--card-bg)",
              }}
            >
              <h3 style={{ marginTop: 0, marginBottom: "12px", fontSize: "18px", fontWeight: 600 }}>
                Approval Status
              </h3>
              <p style={{ margin: 0, color: "var(--text-muted)" }}>No request selected.</p>
            </div>
          </div>
        )}

        {activeTab === "workflow-interaction" && (
          <div
            style={{
              border: "2px solid var(--evidex-green)",
              borderRadius: "12px",
              padding: "24px",
              background: "var(--card-bg)",
            }}
          >
            <h3 style={{ marginTop: 0, marginBottom: "12px", fontSize: "18px", fontWeight: 600 }}>
              Interact
            </h3>
            <p style={{ margin: 0, color: "var(--text-muted)" }}>No request selected.</p>
          </div>
        )}
      </div>
    );
  }

  if (notFound || !request || !requestId) {
    return (
      <div style={{ maxWidth: "1400px", margin: "48px auto", padding: "0 24px" }}>
        <p>Request Not Found</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "1400px", margin: "48px auto", padding: "0 24px" }}>
      {/* Header */}
      <div style={{ marginBottom: "32px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
          <h1 style={{ margin: "0 0 8px 0" }}>Audit Request: {requestId}</h1>
          {!isArchivedReadOnly && (
            <RequestActions
              onArchive={() => setShowArchiveConfirm(true)}
              archiveTitle="Archive this request"
            />
          )}
        </div>
        {isArchivedReadOnly && (
          <p style={{ margin: "0 0 10px 0", color: "var(--text-muted)", fontSize: "13px" }}>
            Archived workflow: view-only mode is enabled for this request.
          </p>
        )}
        <p style={{ margin: 0, color: "var(--text-muted)" }}>
          {formatDisplayValue(request.request_text)}
        </p>
        <p style={{ margin: "8px 0 0 0", fontSize: "13px", color: "var(--text-muted)" }}>
          Category: <strong>{request.category}</strong> • Auditor:{" "}
          <strong>{request.auditor_email}</strong> • Stage:{" "}
          <strong>{request.current_stage.toUpperCase()}</strong>
        </p>
      </div>

      {!showUploadSummary && hasUploadSummaryData && (
        <div
          style={{
            marginBottom: "16px",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            disabled={!isFinalConclusionCompleted}
            title={
              isFinalConclusionCompleted
                ? "View the final validation and conclusion summary"
                : "Validation and conclusion summary is still being finalized"
            }
            onClick={() => {
              uploadSummaryDismissedRef.current = false;
              setShowUploadSummary(true);
            }}
            style={{
              border: "1px solid var(--border-color)",
              background: "var(--summary-panel-bg)",
              color: "inherit",
              borderRadius: "8px",
              padding: "8px 12px",
              fontWeight: 600,
              cursor: isFinalConclusionCompleted ? "pointer" : "not-allowed",
              opacity: isFinalConclusionCompleted ? 1 : 0.55,
            }}
          >
            View Validation & Conclusion Summary
          </button>
        </div>
      )}

      {showUploadSummary && isFinalConclusionCompleted && (
        <div
          style={{
            marginBottom: "28px",
            padding: "22px",
            border: "2px solid var(--evidex-green)",
            borderRadius: "16px",
            background: "var(--summary-panel-bg)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "12px",
            }}
          >
            <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 700, letterSpacing: "-0.02em" }}>
              Validation & Conclusion Summary
            </h2>

            <button
              type="button"
              onClick={handleCloseUploadSummary}
              style={{
                border: "1px solid var(--border-color)",
                background: "transparent",
                color: "inherit",
                borderRadius: "10px",
                padding: "8px 12px",
                cursor: "pointer",
                fontSize: "12px",
                fontWeight: 600,
              }}
            >
              Close
            </button>
          </div>

          {!uploadValidation && !uploadConclusion && !bedrockSummary && (
            <div
              style={{
                marginTop: "12px",
                marginBottom: "2px",
                padding: "12px 14px",
                borderRadius: "12px",
                border: "1px solid var(--border-color)",
                background: "var(--card-bg)",
                color: "var(--text-muted)",
                fontSize: "13px",
              }}
            >
              Analysis is being finalized. Bedrock output will appear automatically once available.
            </div>
          )}

          {hasCompletedValidationAndConclusionSummary ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                gap: "10px",
                marginTop: "16px",
              }}
            >
              <div style={{ border: "1px solid var(--border-color)", borderRadius: "12px", padding: "12px" }}>
                <div style={{ color: "var(--text-muted)", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "6px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>
                  <FontAwesomeIcon icon={faCircleCheck} style={{ fontSize: "11px" }} />
                  <span>Validation status</span>
                </div>
                <div style={{ marginTop: "6px", fontWeight: 700, fontSize: "16px", letterSpacing: "-0.01em" }}>
                    {finalHasSufficientOutcome ? "Sufficient" : "Insufficient / Partial"}
                </div>
              </div>

              <div style={{ border: "1px solid var(--border-color)", borderRadius: "12px", padding: "12px" }}>
                <div style={{ color: "var(--text-muted)", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "6px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>
                  <FontAwesomeIcon icon={faChartLine} style={{ fontSize: "11px" }} />
                  <span>Sufficiency score</span>
                </div>
                <div style={{ marginTop: "6px", fontWeight: 700, fontSize: "16px", letterSpacing: "-0.01em" }}>
                    {typeof parsedBedrockSummary?.calculated_validation_score === "number"
                      ? `${Math.round(parsedBedrockSummary.calculated_validation_score * 100)}%`
                      : typeof (uploadValidation?.overall_sufficiency_score ?? uploadValidation?.overall_sufficiency) === "number"
                      ? `${Math.round(((uploadValidation?.overall_sufficiency_score ?? uploadValidation?.overall_sufficiency) as number) * 100)}%`
                    : "N/A"}
                </div>
              </div>

              <div style={{ border: "1px solid var(--border-color)", borderRadius: "12px", padding: "12px" }}>
                <div style={{ color: "var(--text-muted)", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "6px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>
                  <FontAwesomeIcon icon={faShieldHalved} style={{ fontSize: "11px" }} />
                  <span>Conclusion confidence</span>
                </div>
                <div style={{ marginTop: "6px", fontWeight: 700, fontSize: "16px", letterSpacing: "-0.01em" }}>
                  {typeof uploadConclusion?.confidence === "number"
                    ? `${Math.round(uploadConclusion.confidence * 100)}%`
                    : typeof uploadValidation?.confidence === "number"
                    ? `${Math.round(uploadValidation.confidence * 100)}%`
                    : "N/A"}
                </div>
              </div>

              <div style={{ border: "1px solid var(--border-color)", borderRadius: "12px", padding: "12px" }}>
                <div style={{ color: "var(--text-muted)", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "6px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>
                  <FontAwesomeIcon icon={faBullseye} style={{ fontSize: "11px" }} />
                  <span>Coverage</span>
                </div>
                <div style={{ marginTop: "6px", fontWeight: 700, fontSize: "16px", letterSpacing: "-0.01em" }}>
                  {typeof uploadConclusion?.coverage === "number"
                    ? `${Math.round(uploadConclusion.coverage)}%`
                    : typeof (uploadValidation?.overall_sufficiency_score ?? uploadValidation?.overall_sufficiency) === "number"
                    ? `${Math.round(((uploadValidation?.overall_sufficiency_score ?? uploadValidation?.overall_sufficiency) as number) * 100)}%`
                    : "N/A"}
                </div>
              </div>
            </div>
          ) : (
            <div
              style={{
                marginTop: "14px",
                marginBottom: "2px",
                padding: "12px 14px",
                borderRadius: "12px",
                border: "1px solid var(--border-color)",
                background: "var(--card-bg)",
                color: "var(--text-muted)",
                fontSize: "13px",
              }}
            >
              Validation and conclusion summary are still in progress. Status and scoring metrics will appear after completion.
            </div>
          )}

          {(uploadValidation || uploadConclusion || bedrockSummary) && (
            <div
              style={{
                marginTop: "14px",
                border: "1px solid var(--border-color)",
                borderRadius: "12px",
                padding: "12px 14px",
                background: "var(--card-bg)",
              }}
            >
              <div style={{ fontWeight: 700, fontSize: "12px", color: "var(--text-muted)", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Quick Summary
              </div>
              <div style={{ margin: 0, lineHeight: 1.5, fontSize: "13px" }}>
                {renderBedrockTextWithLinks(quickSummaryText, "quick-summary")}
              </div>
            </div>
          )}

          {bedrockSummary && (
            <div
              style={{
                marginTop: "16px",
                border: "1px solid var(--evidex-green)",
                borderRadius: "10px",
                padding: "14px",
                background:
                  "linear-gradient(180deg, color-mix(in srgb, var(--evidex-green) 8%, transparent), transparent)",
              }}
            >
              {(() => {
                const tone = getBedrockStatusTone(bedrockSummary.status);
                return (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "4px 10px",
                      borderRadius: "999px",
                      fontSize: "12px",
                      fontWeight: 700,
                      background: tone.bg,
                      border: `1px solid ${tone.border}`,
                      color: tone.text,
                      marginBottom: "10px",
                    }}
                  >
                    Bedrock: {tone.label}
                  </div>
                );
              })()}

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "12px",
                  marginBottom: "12px",
                  alignItems: "center",
                }}
              >
                <strong>Bedrock Analysis</strong>
                <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>
                  {formatDisplayValue(bedrockSummary.status || "unknown")}
                  {bedrockSummary.model_id ? ` • ${bedrockSummary.model_id}` : ""}
                </span>
              </div>

              {bedrockSummary.message && (
                <div
                  style={{
                    marginBottom: "10px",
                    fontSize: "13px",
                    color: "var(--text-muted)",
                  }}
                >
                  {formatDisplayValue(bedrockSummary.message)}
                </div>
              )}

              {executiveSummaryText && (
                <div style={{ marginBottom: "10px" }}>
                  <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-muted)" }}>
                    Executive Summary
                  </div>
                  <div style={{ marginTop: "4px", lineHeight: 1.5 }}>
                    {renderBedrockTextWithLinks(
                      executiveSummaryText,
                      "bedrock-executive-summary"
                    )}
                  </div>
                </div>
              )}

              {parsedBedrockSummary?.sufficiency_assessment && (
                <div style={{ marginBottom: "10px" }}>
                  <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-muted)" }}>
                    Sufficiency Assessment
                  </div>
                  <div style={{ marginTop: "4px", lineHeight: 1.5 }}>
                    {renderBedrockTextWithLinks(
                      formatDisplayValue(parsedBedrockSummary.sufficiency_assessment),
                      "bedrock-sufficiency-assessment"
                    )}
                  </div>
                </div>
              )}

              {parsedBedrockSummary && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: "10px",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-muted)" }}>
                      Key Findings
                    </div>
                    {renderBedrockList(parsedBedrockSummary.key_findings)}
                  </div>

                  <div>
                    <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-muted)" }}>
                      Risks
                    </div>
                    {renderBedrockList(parsedBedrockSummary.risks)}
                  </div>

                  <div>
                    <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-muted)" }}>
                      Recommended Next Steps
                    </div>
                    {renderBedrockList(parsedBedrockSummary.recommended_next_steps)}
                  </div>
                </div>
              )}

              {!parsedBedrockSummary ? (
                <RichTextBlock
                  text={formatDisplayValue(bedrockSummary.summary || bedrockSummary.message || "No Bedrock output available.")}
                  style={{
                    margin: 0,
                    lineHeight: 1.5,
                    color: "var(--text-muted)",
                  }}
                />
              ) : null}
            </div>
          )}

          {(uploadValidation || uploadConclusion || parsedBedrockSummary) && (
            <div
              style={{
                marginTop: "16px",
                border: finalHasSufficientOutcome
                  ? "1px solid var(--color-success-border)"
                  : "1px solid var(--color-warning-border)",
                borderRadius: "8px",
                padding: "12px",
                background: finalHasSufficientOutcome
                  ? "var(--color-success-bg)"
                  : "var(--color-warning-bg)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "10px",
                  marginBottom: "10px",
                }}
              >
                <h3 style={{ margin: 0, fontSize: "16px" }}>Analysis</h3>
                <button
                  type="button"
                  onClick={() => setShowAnalysisSection((prev) => !prev)}
                  style={{
                    border: "1px solid var(--border-color)",
                    background: "transparent",
                    color: "inherit",
                    borderRadius: "6px",
                    padding: "6px 8px",
                    cursor: "pointer",
                    fontSize: "12px",
                    display: "inline-flex",
                    alignItems: "center",
                  }}
                  aria-label={showAnalysisSection ? "Collapse analysis" : "Expand analysis"}
                  title={showAnalysisSection ? "Collapse analysis" : "Expand analysis"}
                >
                  <FontAwesomeIcon icon={showAnalysisSection ? faChevronUp : faChevronDown} />
                </button>
              </div>

              {showAnalysisSection && (
                <>
                  {finalHasSufficientOutcome && (
                    <div style={{ marginBottom: "12px" }}>
                      <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-muted)" }}>
                        Sufficiency Analysis
                      </div>
                      <div style={{ marginTop: "6px", marginBottom: "10px" }}>
                        {renderList(sufficiencyRationale)}
                      </div>
                    </div>
                  )}

                  {!finalHasSufficientOutcome && (
                    <div style={{ marginBottom: "12px" }}>
                      <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-muted)" }}>
                        Gap Analysis
                      </div>
                      {renderList(missingEvidenceItems)}
                    </div>
                  )}

                  <div style={{ marginBottom: "12px" }}>
                    <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-muted)" }}>
                      Recommendations
                    </div>
                    {renderList(analysisRecommendations)}
                  </div>
                </>
              )}

              {hasInsufficientOutcome && (
                <>
                  <div
                    style={{
                      border: "1px solid var(--border-color)",
                      borderRadius: "8px",
                      padding: "10px",
                      background: "var(--card-bg)",
                      marginBottom: "12px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "12px",
                        marginBottom: showDraftEmailSection ? "8px" : 0,
                      }}
                    >
                    <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-muted)" }}>
                      Ready-to-Send Draft Email
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <button
                        type="button"
                        onClick={() => setShowDraftEmailSection((prev) => !prev)}
                        style={{
                          border: "1px solid var(--border-color)",
                          background: "transparent",
                          color: "inherit",
                          borderRadius: "6px",
                          padding: "6px 10px",
                          cursor: "pointer",
                          fontSize: "12px",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                        }}
                      >
                        {showDraftEmailSection ? "Close Draft Email" : "View Draft Email"}
                      </button>
                      <button
                        type="button"
                        onClick={openDraftEmailEditor}
                        title="Edit email draft"
                        aria-label="Edit email draft"
                        style={{
                          border: "1px solid var(--border-color)",
                          background: "transparent",
                          color: "inherit",
                          borderRadius: "6px",
                          padding: "6px 8px",
                          cursor: "pointer",
                          fontSize: "12px",
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <FontAwesomeIcon icon={faPenToSquare} style={{ color: "inherit" }} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCopyDraftEmail(editableDraftEmailText)}
                        title="Copy email draft"
                        aria-label="Copy email draft"
                        style={{
                          border: "1px solid var(--evidex-green)",
                          background: "var(--evidex-green)",
                          color: "white",
                          borderRadius: "6px",
                          padding: "6px 8px",
                          cursor: "pointer",
                          fontSize: "12px",
                          fontWeight: 600,
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <FontAwesomeIcon icon={faCopy} style={{ color: "inherit" }} />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setEmailTemplateVariant(
                            (prev) => (prev + 1) % MAX_EMAIL_TEMPLATE_VARIANTS,
                          )
                        }
                        title={`Refresh email format (${(emailTemplateVariant % MAX_EMAIL_TEMPLATE_VARIANTS) + 1}/${MAX_EMAIL_TEMPLATE_VARIANTS})`}
                        aria-label={`Refresh email format (${(emailTemplateVariant % MAX_EMAIL_TEMPLATE_VARIANTS) + 1}/${MAX_EMAIL_TEMPLATE_VARIANTS})`}
                        style={{
                          border: "1px solid var(--border-color)",
                          background: "transparent",
                          color: "inherit",
                          borderRadius: "6px",
                          padding: "6px 8px",
                          cursor: "pointer",
                          fontSize: "12px",
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <FontAwesomeIcon icon={faRotateRight} style={{ color: "inherit" }} />
                      </button>
                    </div>
                    </div>

                  {emailCopyState !== "idle" && (
                    <div
                      style={{
                        marginBottom: "8px",
                        fontSize: "12px",
                        color:
                          emailCopyState === "copied"
                            ? "var(--color-success-text)"
                            : "var(--color-danger-text)",
                      }}
                    >
                      {emailCopyState === "copied"
                        ? "Email draft copied to clipboard."
                        : "Unable to copy automatically. Please copy the draft manually."}
                    </div>
                  )}

                  {showDraftEmailSection && (
                    <pre
                      style={{
                        margin: 0,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        lineHeight: 1.5,
                        fontFamily: "inherit",
                        background: "var(--card-bg)",
                        border: "1px solid var(--border-color)",
                        borderRadius: "6px",
                        padding: "10px",
                      }}
                    >
                      {editableDraftEmailText}
                    </pre>
                  )}
                  </div>

                  <div
                    style={{
                      border: "1px solid var(--border-color)",
                      borderRadius: "8px",
                      padding: "10px",
                      background: "var(--card-bg)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "12px",
                      marginBottom: "8px",
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-muted)" }}>
                      Ready-to-Export Draft Report
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <button
                        type="button"
                        onClick={() => setShowDraftReportSection((prev) => !prev)}
                        style={{
                          border: "1px solid var(--border-color)",
                          background: "transparent",
                          color: "inherit",
                          borderRadius: "6px",
                          padding: "6px 10px",
                          cursor: "pointer",
                          fontSize: "12px",
                        }}
                      >
                        {showDraftReportSection ? "Close Report" : "View Report"}
                      </button>
                      <button
                        type="button"
                        onClick={() => openDraftReportEditor(editableDraftReportText)}
                        title="Edit report"
                        aria-label="Edit report"
                        style={{
                          border: "1px solid var(--border-color)",
                          background: "transparent",
                          color: "inherit",
                          borderRadius: "6px",
                          padding: "6px 8px",
                          cursor: "pointer",
                          fontSize: "12px",
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <FontAwesomeIcon icon={faPenToSquare} style={{ color: "inherit" }} />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          downloadReportPdf(
                            buildReportPdfFilename("insufficiency-analysis"),
                            editableDraftReportText
                          )
                        }
                        title="Download report"
                        aria-label="Download report"
                        style={{
                          border: "1px solid var(--evidex-green)",
                          background: "var(--evidex-green)",
                          color: "white",
                          borderRadius: "6px",
                          padding: "6px 8px",
                          cursor: "pointer",
                          fontSize: "12px",
                          fontWeight: 600,
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <FontAwesomeIcon icon={faDownload} style={{ color: "inherit" }} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCopyDraftReport(editableDraftReportText)}
                        title="Copy report"
                        aria-label="Copy report"
                        style={{
                          border: "1px solid var(--border-color)",
                          background: "transparent",
                          color: "inherit",
                          borderRadius: "6px",
                          padding: "6px 8px",
                          cursor: "pointer",
                          fontSize: "12px",
                          fontWeight: 600,
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <FontAwesomeIcon icon={faCopy} style={{ color: "inherit" }} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setReportTemplateVariant((prev) => (prev + 1) % MAX_REPORT_DRAFT_VERSIONS)}
                        title={`Switch draft version (${reportTemplateVariant + 1}/${MAX_REPORT_DRAFT_VERSIONS})`}
                        aria-label="Switch draft version"
                        style={{
                          border: "1px solid var(--border-color)",
                          background: "transparent",
                          color: "inherit",
                          borderRadius: "6px",
                          padding: "6px 8px",
                          cursor: "pointer",
                          fontSize: "12px",
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <FontAwesomeIcon icon={faRotateRight} style={{ color: "inherit" }} />
                      </button>
                    </div>
                  </div>

                  {showDraftReportSection && (
                    <div
                      style={{
                        margin: 0,
                        lineHeight: 1.5,
                        background: "var(--card-bg)",
                        border: "1px solid var(--border-color)",
                        borderRadius: "6px",
                        padding: "10px",
                      }}
                    >
                      <RichTextBlock text={editableDraftReportText} />
                    </div>
                  )}
                </>
              )}
            </div>
          )}

            {finalHasSufficientOutcome && (
            <div
              style={{
                marginTop: "16px",
                border: "1px solid var(--color-success-border)",
                borderRadius: "8px",
                padding: "12px",
                background: "var(--color-success-bg)",
              }}
            >
              <div
                style={{
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  padding: "10px",
                  background: "var(--card-bg)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  marginBottom: "8px",
                }}
              >
                <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-muted)" }}>
                  Ready-to-Export Draft Report
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <button
                    type="button"
                    onClick={() => setShowDraftReportSection((prev) => !prev)}
                    style={{
                      border: "1px solid var(--border-color)",
                      background: "transparent",
                      color: "inherit",
                      borderRadius: "6px",
                      padding: "6px 10px",
                      cursor: "pointer",
                      fontSize: "12px",
                    }}
                  >
                    {showDraftReportSection ? "Close Report" : "View Report"}
                  </button>
                  <button
                    type="button"
                    onClick={() => openDraftReportEditor(editableDraftReportText)}
                    title="Edit report"
                    aria-label="Edit report"
                    style={{
                      border: "1px solid var(--border-color)",
                      background: "transparent",
                      color: "inherit",
                      borderRadius: "6px",
                      padding: "6px 8px",
                      cursor: "pointer",
                      fontSize: "12px",
                      display: "inline-flex",
                      alignItems: "center",
                    }}
                  >
                    <FontAwesomeIcon icon={faPenToSquare} style={{ color: "inherit" }} />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      downloadReportPdf(
                        buildReportPdfFilename("sufficiency-analysis"),
                        editableDraftReportText
                      )
                    }
                    title="Download report"
                    aria-label="Download report"
                    style={{
                      border: "1px solid var(--evidex-green)",
                      background: "var(--evidex-green)",
                      color: "white",
                      borderRadius: "6px",
                      padding: "6px 8px",
                      cursor: "pointer",
                      fontSize: "12px",
                      fontWeight: 600,
                      display: "inline-flex",
                      alignItems: "center",
                    }}
                  >
                    <FontAwesomeIcon icon={faDownload} style={{ color: "inherit" }} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopyDraftReport(editableDraftReportText)}
                    title="Copy report"
                    aria-label="Copy report"
                    style={{
                      border: "1px solid var(--border-color)",
                      background: "transparent",
                      color: "inherit",
                      borderRadius: "6px",
                      padding: "6px 8px",
                      cursor: "pointer",
                      fontSize: "12px",
                      fontWeight: 600,
                      display: "inline-flex",
                      alignItems: "center",
                    }}
                  >
                    <FontAwesomeIcon icon={faCopy} style={{ color: "inherit" }} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setReportTemplateVariant((prev) => (prev + 1) % MAX_REPORT_DRAFT_VERSIONS)}
                    title={`Switch draft version (${reportTemplateVariant + 1}/${MAX_REPORT_DRAFT_VERSIONS})`}
                    aria-label="Switch draft version"
                    style={{
                      border: "1px solid var(--border-color)",
                      background: "transparent",
                      color: "inherit",
                      borderRadius: "6px",
                      padding: "6px 8px",
                      cursor: "pointer",
                      fontSize: "12px",
                      fontWeight: 600,
                      display: "inline-flex",
                      alignItems: "center",
                    }}
                  >
                    <FontAwesomeIcon icon={faRotateRight} style={{ color: "inherit" }} />
                  </button>
                </div>
              </div>

              {reportCopyState !== "idle" && (
                <div
                  style={{
                    marginBottom: "8px",
                    fontSize: "12px",
                    color:
                      reportCopyState === "copied"
                        ? "var(--color-success-text)"
                        : "var(--color-danger-text)",
                  }}
                >
                  {reportCopyState === "copied"
                    ? "Draft report copied to clipboard."
                    : "Unable to copy automatically. Please copy the draft manually."}
                </div>
              )}

              {showDraftReportSection && (
                <div
                  style={{
                    margin: 0,
                    lineHeight: 1.5,
                    background: "var(--card-bg)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "6px",
                    padding: "10px",
                  }}
                >
                  <RichTextBlock text={editableDraftReportText} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Error Alert */}
      {error && (
        <div
          style={{
            marginBottom: "24px",
            padding: "16px",
            background: "var(--color-danger-bg)",
            border: "1px solid var(--color-danger-border)",
            borderRadius: "8px",
            color: "var(--color-danger-text)",
          }}
        >
          <FontAwesomeIcon icon={faTriangleExclamation} style={{ marginRight: "8px" }} />
          {error}
        </div>
      )}

      {workflowFailure && (
        <div
          ref={failureBannerRef}
          style={{
            marginBottom: "24px",
            padding: "16px",
            background: "var(--color-danger-bg)",
            border: "2px solid var(--color-danger-border)",
            borderRadius: "8px",
            color: "var(--color-danger-text)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: 700, marginBottom: "6px" }}>
            <FontAwesomeIcon icon={faTriangleExclamation} />
            <span>Workflow Stage Failed: {formatWorkflowStage(workflowFailure.stage)}</span>
          </div>
          <div style={{ fontSize: "14px", lineHeight: 1.5 }}>
            {workflowFailure.reason}
          </div>
        </div>
      )}

      {/* Live Stage Ticker */}
      {!uiFreezeActive && (autoWorkflowRunning || inFlightStage !== null || lastSuccessfulStage !== null) && (() => {
        const PIPELINE: { stage: WorkflowStage; label: string }[] = [
          { stage: WorkflowStage.INITIALIZATION, label: "Initialization" },
          { stage: WorkflowStage.INTERPRETATION, label: "Interpretation" },
          { stage: WorkflowStage.RETRIEVAL, label: "Retrieval" },
          { stage: WorkflowStage.VALIDATION, label: "Validation" },
          { stage: WorkflowStage.CONCLUSION, label: "Conclusion" },
        ];
        const successIdx = PIPELINE.findIndex((p) => p.stage === lastSuccessfulStage);
        return (
          <div
            style={{
              marginBottom: "20px",
              padding: "14px 20px",
              border: "1px solid var(--border-color)",
              borderRadius: "10px",
              background: "var(--card-bg)",
            }}
          >
          <div
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--text-muted)",
              marginBottom: "12px",
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            Workflow Progress
          </div>
          <style>{`@keyframes evidex-spin { to { transform: rotate(360deg); } }`}</style>
            <div style={{ display: "flex", alignItems: "center", gap: 0, overflowX: "auto" }}>
              {PIPELINE.map((item, idx) => {
                const isDone     = successIdx >= idx;
                const isInFlight = item.stage === inFlightStage;
                const isPending  = !isDone && !isInFlight;

                const dotColor = isDone
                  ? "var(--evidex-green)"
                  : isInFlight
                  ? "var(--color-info-text, #3b82f6)"
                  : "var(--border-color)";

                return (
                  <div key={item.stage} style={{ display: "flex", alignItems: "center", flex: idx < PIPELINE.length - 1 ? "1 1 0" : "0 0 auto" }}>
                    {/* Node */}
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                      <div
                        style={{
                          width: "28px",
                          height: "28px",
                          borderRadius: "50%",
                          border: `2px solid ${dotColor}`,
                          background: isDone ? dotColor : "transparent",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          position: "relative",
                          transition: "border-color 0.3s, background 0.3s",
                        }}
                      >
                        {isDone && (
                          <span style={{ color: "white", fontSize: "13px", fontWeight: 700, lineHeight: 1 }}>✓</span>
                        )}
                        {isInFlight && (
                          <span
                            style={{
                              display: "block",
                              width: "12px",
                              height: "12px",
                              border: "2px solid var(--color-info-text, #3b82f6)",
                              borderTopColor: "transparent",
                              borderRadius: "50%",
                              animation: "evidex-spin 0.7s linear infinite",
                            }}
                          />
                        )}
                        {isPending && (
                          <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>{idx + 1}</span>
                        )}
                      </div>
                      <span
                        style={{
                          fontSize: "10px",
                          fontWeight: isDone || isInFlight ? 600 : 400,
                          color: isDone
                            ? "var(--evidex-green)"
                            : isInFlight
                            ? "var(--color-info-text, #3b82f6)"
                            : "var(--text-muted)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.label}
                      </span>
                    </div>
                    {/* Connector line */}
                    {idx < PIPELINE.length - 1 && (
                      <div
                        style={{
                          flex: 1,
                          height: "2px",
                          background: isDone ? "var(--evidex-green)" : "var(--border-color)",
                          marginBottom: "20px",
                          transition: "background 0.3s",
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            {inFlightStage && (
              <div style={{ marginTop: "10px", fontSize: "11px", color: "var(--color-info-text, #3b82f6)", fontStyle: "italic" }}>
                Running: {formatWorkflowStage(inFlightStage)}…
              </div>
            )}
            {!inFlightStage && lastSuccessfulStage === WorkflowStage.CONCLUSION && (
              <div style={{ marginTop: "10px", fontSize: "11px", color: "var(--evidex-green)", fontWeight: 600 }}>
                All stages completed successfully.
              </div>
            )}
          </div>
        );
      })()}

      {/* Tab Navigation */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          marginBottom: "24px",
          borderBottom: "2px solid var(--border-color)",
        }}
      >
        {[
          { id: "status", label: "Workflow Status" },
          { id: "approval", label: "Review & Approval" },
          { id: "logs", label: "Process Traceability" },
          { id: "workflow-interaction", label: "Interact" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            style={{
              padding: "12px 16px",
              background: "transparent",
              border: "none",
              borderBottom:
                activeTab === tab.id ? "3px solid var(--evidex-green)" : "3px solid transparent",
              fontWeight: activeTab === tab.id ? 600 : 400,
              color: "inherit",
              cursor: "pointer",
              fontSize: "14px",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div>
        {activeTab === "status" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
            <WorkflowStatusPanel
              requestId={requestId}
              onEvidenceItemsClick={() => {
                void openEvidenceListModal();
              }}
              footerContent={workflowObservabilityTile}
            />
            <div
              style={{
                border: "2px solid var(--evidex-green)",
                borderRadius: "12px",
                padding: "24px",
                background: "var(--card-bg)",
              }}
            >
              <h3
                style={{
                  marginTop: 0,
                  marginBottom: "16px",
                  fontSize: "18px",
                  fontWeight: 600,
                }}
              >
                Request Information
              </h3>
              <div style={{ display: "grid", gap: "12px" }}>
                <div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "12px",
                      color: "var(--text-muted)",
                      fontWeight: 600,
                    }}
                  >
                    Request ID
                  </p>
                  <p style={{ margin: "4px 0 0 0", fontFamily: "monospace" }}>
                    {requestId}
                  </p>
                </div>
                <div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "12px",
                      color: "var(--text-muted)",
                      fontWeight: 600,
                    }}
                  >
                    Auditor
                  </p>
                  <p style={{ margin: "4px 0 0 0" }}>{request.auditor_email}</p>
                </div>
                <div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "12px",
                      color: "var(--text-muted)",
                      fontWeight: 600,
                    }}
                  >
                    Category
                  </p>
                  <p style={{ margin: "4px 0 0 0", textTransform: "capitalize" }}>
                    {request.category}
                  </p>
                </div>
                <div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "12px",
                      color: "var(--text-muted)",
                      fontWeight: 600,
                    }}
                  >
                    Created
                  </p>
                  <p style={{ margin: "4px 0 0 0" }}>
                    {formatDateTimeDMY(request.created_at)}
                  </p>
                </div>
                <div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "12px",
                      color: "var(--text-muted)",
                      fontWeight: 600,
                    }}
                  >
                    Updated
                  </p>
                  <p style={{ margin: "4px 0 0 0" }}>
                    {formatDateTimeDMY(request.updated_at)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "logs" && (
          <div
            style={{
              border: "1px solid var(--border-color)",
              borderRadius: "10px",
              background: "var(--card-bg)",
              padding: "12px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
                marginBottom: showStepLogs ? "10px" : 0,
              }}
            >
              <div style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: 600 }}>
                Process Traceability
              </div>
              <button
                type="button"
                onClick={() => setShowStepLogs((prev) => !prev)}
                style={{
                  border: "1px solid var(--border-color)",
                  background: "transparent",
                  color: "inherit",
                  borderRadius: "6px",
                  padding: "6px 10px",
                  cursor: "pointer",
                  fontSize: "12px",
                }}
              >
                {showStepLogs ? "Hide Process Traceability" : "View Process Traceability"}
              </button>
            </div>

            {showStepLogs && (
              <StepLogViewer
                requestId={requestId}
                onReplayUpdate={handleStepLogReplayUpdate}
              />
            )}
          </div>
        )}

        {activeTab === "approval" && request && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
            <ApprovalWorkflow
              requestId={requestId}
              auditorEmail={auditorsEmail}
              approvalStatus={request?.approval_status as ApprovalStatus}
              readOnly={isArchivedReadOnly}
              onApprovalChange={(newStatus) => {
                getRequestDetails(requestId).then((updatedRequest) => {
                  commitRequestUpdate(updatedRequest);

                  updateStoredRequest(requestId, {
                    approval_status: newStatus,
                    approvedAt:
                      newStatus === ApprovalStatus.APPROVED
                        ? new Date().toISOString()
                        : undefined,
                    updatedAt: new Date().toISOString(),
                    status: updatedRequest.current_stage,
                  });
                });
              }}
              onError={setError}
            />
            <div
              style={{
                border: "2px solid var(--evidex-green)",
                borderRadius: "12px",
                padding: "24px",
                background: "var(--card-bg)",
              }}
            >
              <h3
                style={{
                  marginTop: 0,
                  marginBottom: "16px",
                  fontSize: "18px",
                  fontWeight: 600,
                }}
              >
                Approval Status
              </h3>
              <div
                style={{
                  padding: "16px",
                  background: "var(--card-bg-subtle)",
                  borderRadius: "8px",
                  border: "1px solid var(--border-color)",
                  marginBottom: "14px",
                }}
              >
                <p
                  style={{
                    margin: 0,
                    fontSize: "12px",
                    color: "var(--text-muted)",
                    fontWeight: 600,
                    marginBottom: "8px",
                  }}
                >
                  STATUS
                </p>
                <p
                  style={{
                    margin: 0,
                    fontSize: "24px",
                    fontWeight: 600,
                    textTransform: "capitalize",
                    color:
                      request?.approval_status === ApprovalStatus.APPROVED
                        ? "var(--color-success-text)"
                        : request?.approval_status === ApprovalStatus.REJECTED
                          ? "var(--color-danger-text)"
                          : request?.approval_status === ApprovalStatus.REVISING
                            ? "var(--color-warning-text)"
                            : "var(--color-info)",
                  }}
                >
                  {request?.approval_status}
                </p>
              </div>

              <div
                style={{
                  padding: "16px",
                  background: "var(--card-bg-subtle)",
                  borderRadius: "8px",
                  border: "1px solid var(--border-color)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "8px",
                    marginBottom: "10px",
                  }}
                >
                  <p
                    style={{
                      margin: 0,
                      fontSize: "12px",
                      color: "var(--text-muted)",
                      fontWeight: 600,
                    }}
                  >
                    FINAL DRAFT REPORT
                  </p>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <button
                      type="button"
                      onClick={() => setShowApprovalReport((prev) => !prev)}
                      style={{
                        border: "1px solid var(--border-color)",
                        background: "transparent",
                        color: "inherit",
                        borderRadius: "6px",
                        padding: "6px 10px",
                        cursor: "pointer",
                        fontSize: "12px",
                      }}
                    >
                      {showApprovalReport ? "Close Report" : "View Report"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "workflow-interaction" && (
          isArchivedReadOnly ? (
            <div
              style={{
                border: "1px solid var(--border-color)",
                borderRadius: "10px",
                background: "var(--card-bg)",
                padding: "16px",
                color: "var(--text-muted)",
              }}
            >
              Interact is disabled for archived requests. This workflow remains viewable for audit trail review.
            </div>
          ) : (
            <WorkflowInterface
              requestId={requestId}
              auditorEmail={auditorsEmail}
            />
          )
        )}
      </div>

      {showEvidenceUploadModal && !isArchivedReadOnly && (
        <EvidenceUploadModal
          requestId={requestId}
          onClose={() => setShowEvidenceUploadModal(false)}
        />
      )}

      {showDraftEmailEditor && (
        <div
          onClick={() => setShowDraftEmailEditor(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.55)",
            zIndex: 2095,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "min(900px, 100%)",
              maxHeight: "90vh",
              overflow: "hidden",
              borderRadius: "12px",
              border: "1px solid var(--border-color)",
              background: "var(--card-bg)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--border-color)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
              }}
            >
              <div style={{ fontWeight: 700 }}>Edit Draft Email</div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <button
                  type="button"
                  onClick={() => setShowDraftEmailEditor(false)}
                  style={{
                    border: "1px solid var(--border-color)",
                    background: "transparent",
                    color: "inherit",
                    borderRadius: "6px",
                    padding: "6px 10px",
                    cursor: "pointer",
                    fontSize: "12px",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveDraftEmailEdits}
                  style={{
                    border: "1px solid var(--evidex-green)",
                    background: "var(--evidex-green)",
                    color: "white",
                    borderRadius: "6px",
                    padding: "6px 10px",
                    cursor: "pointer",
                    fontSize: "12px",
                    fontWeight: 600,
                  }}
                >
                  Save
                </button>
              </div>
            </div>
            <div style={{ padding: "12px", overflow: "auto" }}>
              <textarea
                value={draftEmailEditorText}
                onChange={(event) => setDraftEmailEditorText(event.target.value)}
                style={{
                  width: "100%",
                  minHeight: "52vh",
                  resize: "vertical",
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  background: "var(--card-bg)",
                  color: "var(--text-primary)",
                  padding: "10px",
                  lineHeight: 1.5,
                  fontFamily: "inherit",
                  fontSize: "14px",
                }}
              />
            </div>
          </div>
        </div>
      )}

      {showDraftReportEditor && (
        <div
          onClick={() => setShowDraftReportEditor(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.55)",
            zIndex: 2096,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "min(980px, 100%)",
              maxHeight: "90vh",
              overflow: "hidden",
              borderRadius: "12px",
              border: "1px solid var(--border-color)",
              background: "var(--card-bg)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--border-color)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
              }}
            >
              <div style={{ fontWeight: 700 }}>Edit Draft Report</div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <button
                  type="button"
                  onClick={() => setShowDraftReportEditor(false)}
                  style={{
                    border: "1px solid var(--border-color)",
                    background: "transparent",
                    color: "inherit",
                    borderRadius: "6px",
                    padding: "6px 10px",
                    cursor: "pointer",
                    fontSize: "12px",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveDraftReportEdits}
                  style={{
                    border: "1px solid var(--evidex-green)",
                    background: "var(--evidex-green)",
                    color: "white",
                    borderRadius: "6px",
                    padding: "6px 10px",
                    cursor: "pointer",
                    fontSize: "12px",
                    fontWeight: 600,
                  }}
                >
                  Save
                </button>
              </div>
            </div>
            <div style={{ padding: "12px", overflow: "auto" }}>
              <textarea
                value={draftReportEditorText}
                onChange={(event) => setDraftReportEditorText(event.target.value)}
                style={{
                  width: "100%",
                  minHeight: "56vh",
                  resize: "vertical",
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  background: "var(--card-bg)",
                  color: "var(--text-primary)",
                  padding: "10px",
                  lineHeight: 1.5,
                  fontFamily: "inherit",
                  fontSize: "14px",
                }}
              />
            </div>
          </div>
        </div>
      )}

      {showApprovalReport && (
        <div
          onClick={() => setShowApprovalReport(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.55)",
            zIndex: 2085,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "min(980px, 100%)",
              maxHeight: "90vh",
              overflow: "hidden",
              borderRadius: "12px",
              border: "1px solid var(--border-color)",
              background: "var(--card-bg)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--border-color)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>Final Draft Report</div>
                <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>
                  Request {safeRequestId} • Version {reportTemplateVariant + 1}/{MAX_REPORT_DRAFT_VERSIONS}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <button
                  type="button"
                  onClick={() =>
                    downloadReportPdf(
                      buildReportPdfFilename("validation-conclusion"),
                      editableApprovalReportText
                    )
                  }
                  title="Download report"
                  aria-label="Download report"
                  style={{
                    border: "1px solid var(--evidex-green)",
                    background: "var(--evidex-green)",
                    color: "white",
                    borderRadius: "6px",
                    padding: "6px 8px",
                    cursor: "pointer",
                    fontSize: "12px",
                    display: "inline-flex",
                    alignItems: "center",
                    fontWeight: 600,
                  }}
                >
                  <FontAwesomeIcon icon={faDownload} style={{ color: "inherit" }} />
                </button>
                <button
                  type="button"
                  onClick={() => openDraftReportEditor(editableApprovalReportText)}
                  title="Edit report"
                  aria-label="Edit report"
                  style={{
                    border: "1px solid var(--border-color)",
                    background: "transparent",
                    color: "inherit",
                    borderRadius: "6px",
                    padding: "6px 8px",
                    cursor: "pointer",
                    fontSize: "12px",
                    display: "inline-flex",
                    alignItems: "center",
                    fontWeight: 600,
                  }}
                >
                  <FontAwesomeIcon icon={faPenToSquare} style={{ color: "inherit" }} />
                </button>
                <button
                  type="button"
                  onClick={() => void handleCopyDraftReport(editableApprovalReportText)}
                  title="Copy report"
                  aria-label="Copy report"
                  style={{
                    border: "1px solid var(--border-color)",
                    background: "transparent",
                    color: "inherit",
                    borderRadius: "6px",
                    padding: "6px 8px",
                    cursor: "pointer",
                    fontSize: "12px",
                    display: "inline-flex",
                    alignItems: "center",
                    fontWeight: 600,
                  }}
                >
                  <FontAwesomeIcon icon={faCopy} style={{ color: "inherit" }} />
                </button>
                <button
                  type="button"
                  onClick={() => setReportTemplateVariant((prev) => (prev + 1) % MAX_REPORT_DRAFT_VERSIONS)}
                  title={`Switch draft version (${reportTemplateVariant + 1}/${MAX_REPORT_DRAFT_VERSIONS})`}
                  aria-label="Switch draft version"
                  style={{
                    border: "1px solid var(--border-color)",
                    background: "transparent",
                    color: "inherit",
                    borderRadius: "6px",
                    padding: "6px 8px",
                    cursor: "pointer",
                    fontSize: "12px",
                    display: "inline-flex",
                    alignItems: "center",
                    fontWeight: 600,
                  }}
                >
                  <FontAwesomeIcon icon={faRotateRight} style={{ color: "inherit" }} />
                </button>
                <button
                  type="button"
                  onClick={() => setShowApprovalReport(false)}
                  style={{
                    border: "1px solid var(--border-color)",
                    background: "transparent",
                    color: "inherit",
                    borderRadius: "6px",
                    padding: "6px 10px",
                    cursor: "pointer",
                    fontSize: "12px",
                  }}
                >
                  Close
                </button>
              </div>
            </div>

            <div style={{ padding: "12px", overflow: "auto" }}>
              <div
                style={{
                  lineHeight: 1.5,
                  background: "var(--card-bg)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "6px",
                  padding: "10px",
                }}
              >
                <RichTextBlock text={editableApprovalReportText} />
              </div>
            </div>
          </div>
        </div>
      )}

      {showEvidenceListModal && (
        <div
          onClick={() => setShowEvidenceListModal(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.55)",
            zIndex: 2090,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "min(960px, 100%)",
              maxHeight: "90vh",
              overflow: "hidden",
              borderRadius: "12px",
              border: "1px solid var(--border-color)",
              background: "var(--card-bg)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--border-color)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>Collected Evidence</div>
                <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>
                  {evidenceItems.length} item{evidenceItems.length === 1 ? "" : "s"} available
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowEvidenceListModal(false)}
                style={{
                  border: "1px solid var(--border-color)",
                  background: "transparent",
                  color: "inherit",
                  borderRadius: "6px",
                  padding: "6px 10px",
                  cursor: "pointer",
                  fontSize: "12px",
                }}
              >
                Close
              </button>
            </div>

            <div style={{ padding: "12px", overflow: "auto" }}>
              {evidenceListLoading ? (
                <p style={{ margin: 0, color: "var(--text-muted)" }}>Loading evidence list...</p>
              ) : evidenceListError ? (
                <p style={{ margin: 0, color: "var(--color-danger-text)" }}>{evidenceListError}</p>
              ) : evidenceItems.length === 0 ? (
                <p style={{ margin: 0, color: "var(--text-muted)" }}>No collected evidence found for this request.</p>
              ) : (
                <div style={{ display: "grid", gap: "8px" }}>
                  {evidenceItems.map((item) => (
                    <div
                      key={item.evidence_id}
                      style={{
                        border: "1px solid var(--border-color)",
                        borderRadius: "6px",
                        padding: "8px",
                        background: "var(--bg-color)",
                        display: "grid",
                        gridTemplateColumns: "minmax(0, 1fr) auto",
                        gap: "6px 10px",
                        alignItems: "center",
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <button
                          type="button"
                          onClick={() => {
                            void handleEvidenceOpen(item);
                          }}
                          style={{
                            border: "none",
                            background: "transparent",
                            color: "inherit",
                            padding: 0,
                            fontWeight: 600,
                            fontSize: "14px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            textAlign: "left",
                            width: "100%",
                            cursor: "pointer",
                          }}
                          title={item.filename}
                        >
                          {item.filename}
                        </button>
                      </div>

                      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                        <button
                          type="button"
                          onClick={() => {
                            void handleEvidenceOpen(item);
                          }}
                          style={{
                            border: "1px solid var(--border-color)",
                            background: "transparent",
                            color: "inherit",
                            borderRadius: "6px",
                            padding: "5px 8px",
                            cursor: "pointer",
                            fontSize: "11px",
                          }}
                        >
                          {canPreviewInBrowser(item) ? "View" : "Open"}
                        </button>
                        <a
                          href={getEvidenceDownloadUrl(requestId, item.evidence_id)}
                          onClick={() => {
                            recordAuditEvent({
                              eventName: "file.evidence.downloaded",
                              action: "Downloaded evidence file",
                              category: "file_access",
                              module: "workflow",
                              feature: "evidence-list-download",
                              source: "ui",
                              target: {
                                entityType: "evidence",
                                entityId: item.evidence_id,
                                requestId,
                                evidenceId: item.evidence_id,
                              },
                              metadata: {
                                filename: item.filename,
                              },
                            });
                          }}
                          style={{
                            border: "1px solid var(--evidex-green)",
                            background: "var(--evidex-green)",
                            color: "white",
                            borderRadius: "6px",
                            padding: "5px 8px",
                            textDecoration: "none",
                            fontSize: "11px",
                            fontWeight: 600,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                          }}
                        >
                          <FontAwesomeIcon icon={faDownload} />
                          Download
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {selectedEvidence && (
        <div
          onClick={() => setSelectedEvidence(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.55)",
            zIndex: 2100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "min(960px, 100%)",
              maxHeight: "90vh",
              overflow: "hidden",
              borderRadius: "12px",
              border: "1px solid var(--border-color)",
              background: "var(--card-bg)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--border-color)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>Document Preview</div>
                <div style={{ color: "var(--text-muted)", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selectedEvidence.filename}
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <a
                  href={getEvidenceDownloadUrl(requestId, selectedEvidence.evidence_id)}
                  onClick={() => {
                    recordAuditEvent({
                      eventName: "file.evidence.downloaded",
                      action: "Downloaded evidence file from preview modal",
                      category: "file_access",
                      module: "workflow",
                      feature: "evidence-preview-download",
                      source: "ui",
                      target: {
                        entityType: "evidence",
                        entityId: selectedEvidence.evidence_id,
                        requestId,
                        evidenceId: selectedEvidence.evidence_id,
                      },
                      metadata: {
                        filename: selectedEvidence.filename,
                      },
                    });
                  }}
                  style={{
                    border: "1px solid var(--evidex-green)",
                    background: "var(--evidex-green)",
                    color: "white",
                    borderRadius: "6px",
                    padding: "6px 10px",
                    textDecoration: "none",
                    fontSize: "12px",
                    fontWeight: 600,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <FontAwesomeIcon icon={faDownload} />
                  Download
                </a>
                <button
                  type="button"
                  onClick={() => setSelectedEvidence(null)}
                  style={{
                    border: "1px solid var(--border-color)",
                    background: "transparent",
                    color: "inherit",
                    borderRadius: "6px",
                    padding: "6px 10px",
                    cursor: "pointer",
                    fontSize: "12px",
                  }}
                >
                  Close
                </button>
              </div>
            </div>

            <div style={{ padding: "12px", overflow: "auto", minHeight: "420px" }}>
              {canPreviewInBrowser(selectedEvidence) ? (
                <iframe
                  title={`Preview ${selectedEvidence.filename}`}
                  src={getEvidencePreviewUrl(requestId, selectedEvidence.evidence_id)}
                  onLoad={() => {
                    recordAuditEvent({
                      eventName: "file.evidence.viewed",
                      action: "Viewed evidence preview",
                      category: "file_access",
                      module: "workflow",
                      feature: "evidence-preview",
                      source: "ui",
                      target: {
                        entityType: "evidence",
                        entityId: selectedEvidence.evidence_id,
                        requestId,
                        evidenceId: selectedEvidence.evidence_id,
                      },
                      metadata: {
                        filename: selectedEvidence.filename,
                      },
                    });
                  }}
                  style={{
                    width: "100%",
                    height: "70vh",
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                    background: "white",
                  }}
                />
              ) : (
                <div
                  style={{
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                    padding: "12px",
                    background: "var(--bg-color)",
                  }}
                >
                  <p style={{ marginTop: 0 }}>
                    Inline preview is not available for this file type. Browser-only mode does not open non-previewable files.
                  </p>
                  {selectedEvidence.content_preview ? (
                    <RichTextBlock text={selectedEvidence.content_preview} />
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showArchiveConfirm && (
        <ArchiveConfirmationModal
          onCancel={() => setShowArchiveConfirm(false)}
          onConfirm={() => {
            setShowArchiveConfirm(false);
            handleArchiveCurrentRequest();
          }}
        />
      )}
    </div>
  );
}
