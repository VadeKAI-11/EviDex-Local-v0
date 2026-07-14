/**
 * Backend API client for EviDex workflow endpoints
 * Integrates with FastAPI backend at http://localhost:8000
 */

import type {
  WorkflowStepLog,
  WorkflowStatus,
  RequestDetails,
  EvidenceLinkItem,
  WorkflowInteraction,
  CreateRequestResponse,
  InterpretResponse,
  RetrieveResponse,
  ValidateResponse,
  ConcludeResponse,
  WorkflowOutputsResponse,
  ApprovalResponse,
  WorkflowInteractionResponse,
  MessageResponse,
  WorkflowInteractionHealthResponse,
  RequestSummariesResponse,
  UploadEvidenceResponse,
  UploadEvidenceWorkflowResult,
} from "./types";
import { recordAuditEvent } from "../utils/auditLog";

const API_BASE = "http://localhost:8000";

async function extractErrorMessage(res: Response): Promise<string> {
  const rawText = await res.text();

  if (!rawText) {
    return `${res.status} ${res.statusText}`.trim();
  }

  try {
    const parsed = JSON.parse(rawText) as { detail?: unknown; message?: unknown; error?: unknown };
    if (typeof parsed.detail === "string" && parsed.detail.trim()) {
      return parsed.detail;
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message;
    }
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error;
    }
  } catch {
    // Raw text is not JSON. Fall back to text payload.
  }

  return rawText;
}

function normalizeWorkflowInteractionFetchError(err: unknown, action: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const lowered = message.toLowerCase();

  if (lowered.includes("failed to fetch") || lowered.includes("networkerror") || lowered.includes("load failed")) {
    return new Error(
      `Cannot reach the EviDex backend at ${API_BASE} while trying to ${action}. Start the backend server and verify AWS Bedrock credentials/model access if the issue persists.`
    );
  }

  return err instanceof Error ? err : new Error(message);
}

/* ============================================================================ */
/* WORKFLOW INITIALIZATION */
/* ============================================================================ */
// Creates a new audit request and initializes the workflow execution context.
// This is the entry point for all audit evidence collection workflows.

export async function initializeRequest(
  requestText: string,
  category: string,
  auditorEmail: string,
  auditorId?: string,
  priority: string = "normal",
  projectName: string = "default"
): Promise<CreateRequestResponse> {
  const resolvedAuditorId =
    auditorId || auditorEmail.split("@")[0] || "auditor-local";

  const res = await fetch(`${API_BASE}/api/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      auditor_id: resolvedAuditorId,
      auditor_email: auditorEmail,
      request_text: requestText,
      request_category: category,
      priority,
      project_name: projectName,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    recordAuditEvent({
      eventName: "workflow.request.create.failed",
      action: "Failed to create evidence request",
      category: "workflow",
      module: "workflow",
      feature: "initialize-request",
      source: "api",
      severity: "warning",
      metadata: {
        projectName,
        category,
        error,
      },
    });
    throw new Error(`Failed to initialize request: ${error}`);
  }
  const payload = (await res.json()) as CreateRequestResponse;
  recordAuditEvent({
    eventName: "workflow.request.created",
    action: "Created evidence request",
    category: "workflow",
    module: "workflow",
    feature: "initialize-request",
    source: "api",
    target: {
      entityType: "request",
      entityId: payload.request_id,
      requestId: payload.request_id,
    },
    metadata: {
      category,
      priority,
      projectName,
    },
  });
  return payload;
}

/**
 * DANGER: Resets all backend state to 'scratch'.
 */
export async function resetBackendData(): Promise<{ success: boolean; message: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/debug/reset-all`, {
      method: "POST",
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to reset backend: ${error}`);
    }

    return res.json();
  } catch (err) {
    throw normalizeWorkflowInteractionFetchError(err, "reset backend data");
  }
}

/* ============================================================================ */
/* WORKFLOW STAGES */
/* ============================================================================ */
// These functions trigger each stage of the audit workflow: interpretation,
// evidence retrieval, validation, and conclusion generation. Each stage moves
// the request forward and generates step logs for traceability.

export async function interpretRequest(
  requestId: string
): Promise<InterpretResponse> {
  const res = await fetch(`${API_BASE}/api/requests/${requestId}/interpret`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const error = await res.text();
    recordAuditEvent({
      eventName: "workflow.interpretation.failed",
      action: "Interpretation step failed",
      category: "workflow",
      module: "workflow",
      feature: "interpret",
      source: "api",
      severity: "warning",
      target: {
        entityType: "request",
        entityId: requestId,
        requestId,
      },
      metadata: { error },
    });
    throw new Error(`Interpretation failed: ${error}`);
  }
  const payload = (await res.json()) as InterpretResponse;
  recordAuditEvent({
    eventName: "workflow.interpretation.completed",
    action: "Completed interpretation step",
    category: "workflow",
    module: "workflow",
    feature: "interpret",
    source: "api",
    target: {
      entityType: "request",
      entityId: requestId,
      requestId,
    },
  });
  return payload;
}

export async function retrieveEvidence(
  requestId: string,
  dataSources: string[],
  keywords?: string[]
): Promise<RetrieveResponse> {
  const res = await fetch(`${API_BASE}/api/requests/${requestId}/retrieve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      data_sources: dataSources,
      keywords: keywords || [],
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    recordAuditEvent({
      eventName: "workflow.retrieval.failed",
      action: "Evidence retrieval failed",
      category: "workflow",
      module: "workflow",
      feature: "retrieve-evidence",
      source: "api",
      severity: "warning",
      target: {
        entityType: "request",
        entityId: requestId,
        requestId,
      },
      metadata: { error },
    });
    throw new Error(`Evidence retrieval failed: ${error}`);
  }
  const payload = (await res.json()) as RetrieveResponse;
  recordAuditEvent({
    eventName: "workflow.retrieval.completed",
    action: "Retrieved evidence",
    category: "workflow",
    module: "workflow",
    feature: "retrieve-evidence",
    source: "api",
    target: {
      entityType: "request",
      entityId: requestId,
      requestId,
    },
    metadata: {
      dataSources,
      keywords,
    },
  });
  return payload;
}

export async function validateEvidence(
  requestId: string
): Promise<ValidateResponse> {
  const res = await fetch(`${API_BASE}/api/requests/${requestId}/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const error = await res.text();
    recordAuditEvent({
      eventName: "workflow.validation.failed",
      action: "Evidence validation failed",
      category: "workflow",
      module: "workflow",
      feature: "validate-evidence",
      source: "api",
      severity: "warning",
      target: {
        entityType: "request",
        entityId: requestId,
        requestId,
      },
      metadata: { error },
    });
    throw new Error(`Validation failed: ${error}`);
  }
  const payload = (await res.json()) as ValidateResponse;
  recordAuditEvent({
    eventName: "workflow.validation.completed",
    action: "Validated evidence",
    category: "workflow",
    module: "workflow",
    feature: "validate-evidence",
    source: "api",
    target: {
      entityType: "request",
      entityId: requestId,
      requestId,
    },
    metadata: {
      status: payload.validation?.status,
      confidence: payload.validation?.confidence,
    },
  });
  return payload;
}

export async function generateConclusion(
  requestId: string
): Promise<ConcludeResponse> {
  const res = await fetch(`${API_BASE}/api/requests/${requestId}/conclude`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const error = await res.text();
    recordAuditEvent({
      eventName: "workflow.conclusion.failed",
      action: "Conclusion generation failed",
      category: "workflow",
      module: "workflow",
      feature: "generate-conclusion",
      source: "api",
      severity: "warning",
      target: {
        entityType: "request",
        entityId: requestId,
        requestId,
      },
      metadata: { error },
    });
    throw new Error(`Conclusion generation failed: ${error}`);
  }
  const payload = (await res.json()) as ConcludeResponse;
  recordAuditEvent({
    eventName: "workflow.conclusion.completed",
    action: "Generated conclusion",
    category: "workflow",
    module: "workflow",
    feature: "generate-conclusion",
    source: "api",
    target: {
      entityType: "request",
      entityId: requestId,
      requestId,
    },
  });
  return payload;
}

/* ============================================================================ */
/* APPROVAL WORKFLOW */
/* ============================================================================ */

export async function submitForApproval(
  requestId: string
): Promise<ApprovalResponse> {
  const res = await fetch(
    `${API_BASE}/api/requests/${requestId}/submit-for-approval`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }
  );

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to submit for approval: ${error}`);
  }
  const payload = (await res.json()) as ApprovalResponse;
  recordAuditEvent({
    eventName: "workflow.approval.submitted",
    action: "Submitted request for approval",
    category: "workflow",
    module: "approval",
    feature: "submit-for-approval",
    source: "api",
    target: {
      entityType: "request",
      entityId: requestId,
      requestId,
    },
    metadata: {
      stage: payload.stage,
    },
  });
  return payload;
}

export async function approveRequest(
  requestId: string,
  auditorEmail: string,
  notes?: string
): Promise<ApprovalResponse> {
  const res = await fetch(`${API_BASE}/api/requests/${requestId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      auditor_email: auditorEmail,
      action: "approve",
      notes: notes || "",
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Approval failed: ${error}`);
  }
  const payload = (await res.json()) as ApprovalResponse;
  recordAuditEvent({
    eventName: "workflow.approval.approved",
    action: "Approved request",
    category: "workflow",
    module: "approval",
    feature: "approve-request",
    source: "api",
    target: {
      entityType: "request",
      entityId: requestId,
      requestId,
    },
    metadata: {
      notes,
      actorEmail: auditorEmail,
    },
  });
  return payload;
}

export async function rejectRequest(
  requestId: string,
  auditorEmail: string,
  reason?: string
): Promise<ApprovalResponse> {
  const res = await fetch(`${API_BASE}/api/requests/${requestId}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      auditor_email: auditorEmail,
      action: "reject",
      notes: reason || "Rejection requested",
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Rejection failed: ${error}`);
  }
  const payload = (await res.json()) as ApprovalResponse;
  recordAuditEvent({
    eventName: "workflow.approval.rejected",
    action: "Rejected request",
    category: "workflow",
    module: "approval",
    feature: "reject-request",
    source: "api",
    severity: "warning",
    target: {
      entityType: "request",
      entityId: requestId,
      requestId,
    },
    metadata: {
      reason,
      actorEmail: auditorEmail,
    },
  });
  return payload;
}

export async function requestRevision(
  requestId: string,
  auditorEmail: string,
  notes: string
): Promise<ApprovalResponse> {
  const res = await fetch(
    `${API_BASE}/api/requests/${requestId}/request-revision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        auditor_email: auditorEmail,
        action: "revision_requested",
        notes,
      }),
    }
  );

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Revision request failed: ${error}`);
  }
  const payload = (await res.json()) as ApprovalResponse;
  recordAuditEvent({
    eventName: "workflow.approval.revision-requested",
    action: "Requested revisions",
    category: "workflow",
    module: "approval",
    feature: "request-revision",
    source: "api",
    severity: "warning",
    target: {
      entityType: "request",
      entityId: requestId,
      requestId,
    },
    metadata: {
      notes,
      actorEmail: auditorEmail,
    },
  });
  return payload;
}

/* ============================================================================ */
/* DATA RETRIEVAL */
/* ============================================================================ */

export async function getRequestDetails(
  requestId: string
): Promise<RequestDetails> {
  const res = await fetch(`${API_BASE}/api/requests/${requestId}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to get request details: ${error}`);
  }

  const data = await res.json();
  return data.request;
}

export async function getWorkflowStatus(
  requestId: string
): Promise<WorkflowStatus> {
  const res = await fetch(`${API_BASE}/api/requests/${requestId}/status`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to get workflow status: ${error}`);
  }

  const data = await res.json();
  return data.status;
}

export async function getWorkflowOutputs(
  requestId: string
): Promise<WorkflowOutputsResponse> {
  const res = await fetch(`${API_BASE}/api/requests/${requestId}/workflow-outputs`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to get workflow outputs: ${error}`);
  }

  return res.json();
}

export async function getStepLogs(requestId: string): Promise<WorkflowStepLog[]> {
  const res = await fetch(`${API_BASE}/api/requests/${requestId}/step-logs`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to get step logs: ${error}`);
  }

  const data = await res.json();
  return data.steps;
}

export async function getEvidenceItems(requestId: string): Promise<EvidenceLinkItem[]> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 15000);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/requests/${requestId}/evidence-items`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("abort")) {
      throw new Error("Evidence list request timed out after 15s. Please retry.");
    }
    throw new Error(`Failed to get evidence items: ${message}`);
  } finally {
    window.clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const error = await extractErrorMessage(res);
    throw new Error(`Failed to get evidence items: ${error}`);
  }

  const data = await res.json();
  const candidates =
    (Array.isArray(data?.items) && data.items) ||
    (Array.isArray(data?.evidence_items) && data.evidence_items) ||
    (Array.isArray(data?.evidence) && data.evidence) ||
    [];

  return candidates as EvidenceLinkItem[];
}

export function getEvidencePreviewUrl(requestId: string, evidenceId: string): string {
  return `${API_BASE}/api/requests/${requestId}/evidence/${evidenceId}/preview`;
}

export function getEvidenceDownloadUrl(requestId: string, evidenceId: string): string {
  return `${API_BASE}/api/requests/${requestId}/evidence/${evidenceId}/download`;
}

export async function ensureEvidencePreviewAvailable(
  requestId: string,
  evidenceId: string
): Promise<void> {
  const res = await fetch(getEvidencePreviewUrl(requestId, evidenceId), {
    method: "HEAD",
  });

  if (res.ok) {
    return;
  }

  const message = await extractErrorMessage(res);
  if (res.status === 503) {
    throw new Error(
      `Office preview requires server conversion support. ${message || "Install and configure LibreOffice on backend."}`
    );
  }

  throw new Error(message || `Preview check failed (${res.status})`);
}

export async function permanentlyDeleteRequestFromBackend(
  requestId: string
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/requests/${requestId}/permanent`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to permanently delete request: ${error}`);
  }
}

/* ============================================================================ */
/* WORKFLOW INTERACTIONS */
/* ============================================================================ */

export async function createWorkflowInteraction(
  requestId: string,
  topic: string = "clarification"
): Promise<WorkflowInteractionResponse> {
  try {
    const res = await fetch(`${API_BASE}/api/conversations/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        topic,
      }),
    });

    if (!res.ok) {
      const error = await extractErrorMessage(res);
      throw new Error(`Failed to create workflow interaction: ${error}`);
    }

    const payload = (await res.json()) as WorkflowInteractionResponse;
    recordAuditEvent({
      eventName: "workflow.interaction.created",
      action: "Created workflow interaction session",
      category: "workflow",
      module: "interaction",
      feature: "create-session",
      source: "api",
      target: {
        entityType: "conversation",
        entityId: payload.conversation_id,
        requestId,
      },
      metadata: {
        topic,
      },
    });
    return payload;
  } catch (err) {
    throw normalizeWorkflowInteractionFetchError(err, "create a workflow interaction");
  }
}

export async function sendWorkflowInteractionMessage(
  interactionId: string,
  requestId: string,
  messageText: string,
  messageType: string = "question",
  referencedStepId?: string,
  referencedEvidenceIds?: string[]
): Promise<MessageResponse> {
  try {
    const res = await fetch(
      `${API_BASE}/api/conversations/${interactionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: requestId,
          message_text: messageText,
          message_type: messageType,
          referenced_step_id: referencedStepId,
          referenced_evidence_ids: referencedEvidenceIds || [],
        }),
      }
    );

    if (!res.ok) {
      const error = await extractErrorMessage(res);
      throw new Error(`Failed to send message: ${error}`);
    }

    const payload = (await res.json()) as MessageResponse;
    recordAuditEvent({
      eventName: "workflow.interaction.message.sent",
      action: "Sent workflow interaction message",
      category: "workflow",
      module: "interaction",
      feature: "send-message",
      source: "api",
      target: {
        entityType: "conversation",
        entityId: interactionId,
        requestId,
        linkedRecordIds: referencedEvidenceIds,
      },
      metadata: {
        messageType,
        referencedStepId,
      },
    });
    return payload;
  } catch (err) {
    throw normalizeWorkflowInteractionFetchError(err, "send a message");
  }
}

export async function getWorkflowInteraction(
  interactionId: string
): Promise<WorkflowInteraction> {
  try {
    const res = await fetch(
      `${API_BASE}/api/conversations/${interactionId}`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }
    );

    if (!res.ok) {
      const error = await extractErrorMessage(res);
      throw new Error(`Failed to get workflow interaction: ${error}`);
    }

    const data = await res.json();
    return data.conversation;
  } catch (err) {
    throw normalizeWorkflowInteractionFetchError(err, "load a workflow interaction");
  }
}

export async function getWorkflowInteractionHealth(
  probe: boolean = true
): Promise<WorkflowInteractionHealthResponse> {
  try {
    const res = await fetch(
      `${API_BASE}/api/conversations/health?probe=${probe ? "true" : "false"}`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }
    );

    if (!res.ok) {
      const error = await extractErrorMessage(res);
      throw new Error(`Workflow interaction health check failed: ${error}`);
    }

    return res.json();
  } catch (err) {
    throw normalizeWorkflowInteractionFetchError(err, "check interaction health");
  }
}

export async function listRequestSummaries(): Promise<RequestSummariesResponse> {
  const res = await fetch(`${API_BASE}/api/requests/list`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const error = await extractErrorMessage(res);
    throw new Error(`Failed to list request summaries: ${error}`);
  }

  return res.json();
}

export async function uploadEvidenceFiles(
  requestId: string,
  files: File[]
): Promise<UploadEvidenceResponse> {
  const formData = new FormData();

  files.forEach((file) => {
    formData.append("files", file);
  });

  let res: Response;

  try {
    res = await fetch(
      `${API_BASE}/api/requests/${requestId}/evidence/upload`,
      {
        method: "POST",
        body: formData,
      }
    );
  } catch {
    throw new Error(
      "Cannot reach the EviDex backend at http://localhost:8000. Start the FastAPI server and try the upload again."
    );
  }

  if (!res.ok) {
    let errorMessage = "Evidence upload failed";
    try {
      const errorPayload = await res.json();
      if (typeof errorPayload?.detail === "string") {
        errorMessage = errorPayload.detail;
      }
    } catch {
      // Keep fallback message when backend response is not JSON.
    }
    throw new Error(errorMessage);
  }
  const payload = (await res.json()) as UploadEvidenceResponse;
  recordAuditEvent({
    eventName: "evidence.upload.completed",
    action: "Uploaded evidence files",
    category: "evidence",
    module: "evidence",
    feature: "upload-files",
    source: "api",
    target: {
      entityType: "request",
      entityId: requestId,
      requestId,
    },
    metadata: {
      uploadedCount: payload.uploaded_count,
      fileCount: files.length,
      filenames: files.map((file) => file.name),
      rejectedFiles: payload.rejected_files,
    },
  });

  return payload;
}

export async function uploadEvidence(
  requestId: string,
  files: File[]
): Promise<UploadEvidenceWorkflowResult> {
  const upload = await uploadEvidenceFiles(requestId, files);

  if (upload.uploaded_count <= 0) {
    const rejectedNames = (upload.rejected_files || []).filter(Boolean);
    if (rejectedNames.length > 0) {
      throw new Error(
        `No related evidence files were accepted for this request. Rejected files: ${rejectedNames.join(", ")}`
      );
    }

    throw new Error("No related evidence files were accepted for this request.");
  }

  const validationResponse = await validateEvidence(requestId);
  const conclusionResponse = await generateConclusion(requestId);

  const validation = {
    ...validationResponse.validation,
    sufficient: validationResponse.validation.status === "sufficient",
  };

  const logs = [
    ...(upload.collection_logs || []),
    upload.step_log,
    validationResponse.step_log,
    conclusionResponse.step_log,
  ].filter(Boolean);

  recordAuditEvent({
    eventName: "evidence.validation-conclusion.completed",
    action: "Completed validation and conclusion after upload",
    category: "evidence",
    module: "evidence",
    feature: "upload-validate-conclude",
    source: "api",
    target: {
      entityType: "request",
      entityId: requestId,
      requestId,
    },
    metadata: {
      fileCount: files.length,
      uploadedCount: upload.uploaded_count,
      sufficient: validation.sufficient,
      stage: conclusionResponse.stage,
    },
  });

  return {
    requestId,
    stage: conclusionResponse.stage,
    validation,
    conclusion: conclusionResponse.conclusion,
    bedrock_summary: conclusionResponse.bedrock_summary,
    logs,
    upload,
  };
}

export async function login(email: string, password: string) {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new Error(
      "Cannot reach the backend (http://localhost:8000). Start the FastAPI server: cd \"EviDex Code/backend\" then run uvicorn app:app --reload"
    );
  }

  if (!res.ok) {
    let message = "Login failed";
    try {
      const payload = await res.json();
      if (typeof payload?.detail === "string") {
        message = payload.detail;
      }
    } catch {
      // Keep fallback message when backend response is not JSON.
    }
    recordAuditEvent({
      eventName: "auth.login.api-failed",
      action: "Login API rejected credentials",
      category: "authentication",
      module: "auth",
      feature: "login-api",
      source: "api",
      severity: "warning",
      actor: {
        email,
        role: "unknown",
        userId: email.split("@")[0] || "unknown",
      },
      metadata: {
        reason: message,
      },
    });
    throw new Error(message);
  }

  const payload = await res.json();

  if (!payload?.authenticated || !payload?.user?.email) {
    throw new Error(payload?.error || "Invalid login credentials");
  }

  recordAuditEvent({
    eventName: "auth.login.api-success",
    action: "Login API authenticated user",
    category: "authentication",
    module: "auth",
    feature: "login-api",
    source: "api",
    actor: {
      email: payload.user.email,
      role: String(payload.user.role || "auditor"),
      userId: payload.user.email.split("@")[0] || payload.user.email,
    },
  });

  return payload;
}
