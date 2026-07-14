import { permanentlyDeleteRequestFromBackend } from "../api/backend-api";
import { listRequestSummaries } from "../api/backend-api";
import { recordAuditEvent } from "./auditLog";

export const REQUESTS_STORAGE_KEY = "evidex-requests";

const RETENTION_DAYS = 90;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const ARCHIVE_RETENTION_YEARS = 7;
const ARCHIVE_RETENTION_MS = ARCHIVE_RETENTION_YEARS * 365 * 24 * 60 * 60 * 1000;

export type StoredRequest = {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  approval_status?: string;
  approvedAt?: string;
  isDeleted?: boolean;
  deletedAt?: string;
  isArchived?: boolean;
  archivedAt?: string;
  archivedBy?: string;
  [key: string]: unknown;
};

function parseStoredRequests(): StoredRequest[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(REQUESTS_STORAGE_KEY) || "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as StoredRequest[]) : [];
  } catch {
    return [];
  }
}

function writeStoredRequests(requests: StoredRequest[]) {
  localStorage.setItem(REQUESTS_STORAGE_KEY, JSON.stringify(requests));
}

function clearRequestArtifacts(requestId: string) {
  localStorage.removeItem(`evidex-agent-result-${requestId}`);
  localStorage.removeItem(`evidex-interaction-${requestId}`);
  localStorage.removeItem(`evidex-interaction-sessions-${requestId}`);
  localStorage.removeItem(`evidex-agent-logs-${requestId}`);
  localStorage.removeItem(`evidex-agent-conclusion-${requestId}`);
  localStorage.removeItem(`evidex-bedrock-summary-${requestId}`);

  if (sessionStorage.getItem("evidex-current-request-id") === requestId) {
    sessionStorage.removeItem("evidex-current-request-id");
  }

  if (sessionStorage.getItem("evidex-post-upload-summary-request") === requestId) {
    sessionStorage.removeItem("evidex-post-upload-summary-request");
  }
}

export function getStoredRequests() {
  purgeExpiredArchiveItems();
  purgeExpiredRecycleBinItems();
  return parseStoredRequests();
}

export function updateStoredRequest(requestId: string, updates: Partial<StoredRequest>) {
  const previousRequests = parseStoredRequests();
  const before = previousRequests.find((request) => request.id === requestId);

  const updated = previousRequests.map((request) => {
    if (request.id !== requestId) {
      return request;
    }
    return {
      ...request,
      ...updates,
    };
  });

  writeStoredRequests(updated);

  const after = updated.find((request) => request.id === requestId);
  if (before || after) {
    recordAuditEvent({
      eventName: "evidence.request.updated",
      action: "Updated request metadata",
      category: "evidence",
      module: "request-storage",
      feature: "update-request",
      source: "storage",
      target: {
        entityType: "request",
        entityId: requestId,
        requestId,
      },
      change: {
        before,
        after,
      },
      metadata: {
        updatedKeys: Object.keys(updates),
      },
    });
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("storage"));
  }

  return updated;
}

function inferOrganizationFromRequestId(requestId: string): string {
  const match = /^([A-Za-z0-9]+)-REQ-\d{3}$/i.exec(String(requestId || "").trim());
  return match ? match[1].toUpperCase() : "default";
}

export async function syncStoredRequestsFromBackend(): Promise<StoredRequest[]> {
  const backend = await listRequestSummaries();
  const existing = parseStoredRequests();
  const existingById = new Map(existing.map((item) => [item.id, item]));

  const mergedFromBackend: StoredRequest[] = (backend.requests || []).map((summary) => {
    const current = existingById.get(summary.request_id);
    const approvalStatus = String(summary.approval_status || current?.approval_status || "pending").trim().toLowerCase();
    return {
      ...current,
      id: summary.request_id,
      requestText:
        String(current?.requestText || "").trim() ||
        String(summary.request_text || "").trim() ||
        "Audit request",
      organization:
        String(current?.organization || "").trim() ||
        String(summary.project_name || "").trim() ||
        inferOrganizationFromRequestId(summary.request_id),
      createdAt:
        String(current?.createdAt || "").trim() ||
        String(summary.created_at || "").trim() ||
        new Date().toISOString(),
      updatedAt:
        String(current?.updatedAt || "").trim() ||
        String(summary.updated_at || "").trim() ||
        String(summary.created_at || "").trim() ||
        new Date().toISOString(),
      createdBy:
        String(current?.createdBy || "").trim() ||
        String(summary.auditor_email || "").trim() ||
        "",
      approval_status: approvalStatus,
      approvedAt:
        approvalStatus === "approved"
          ? String(current?.approvedAt || "").trim() ||
            String(summary.updated_at || "").trim() ||
            String(summary.created_at || "").trim() ||
            new Date().toISOString()
          : String(current?.approvedAt || "").trim(),
      status:
        String(current?.status || "").trim() ||
        String(summary.current_stage || "").trim() ||
        "initialization",
    };
  });

  const mergedById = new Map(mergedFromBackend.map((item) => [item.id, item]));
  for (const item of existing) {
    if (!mergedById.has(item.id)) {
      mergedById.set(item.id, item);
    }
  }

  const merged = Array.from(mergedById.values()).sort((left, right) => {
    const leftTs = Date.parse(String(left.createdAt || ""));
    const rightTs = Date.parse(String(right.createdAt || ""));
    return (Number.isFinite(rightTs) ? rightTs : 0) - (Number.isFinite(leftTs) ? leftTs : 0);
  });

  writeStoredRequests(merged);
  return merged;
}

export function moveRequestToRecycleBin(requestId: string) {
  const previousRequests = parseStoredRequests();
  const before = previousRequests.find((request) => request.id === requestId);
  const nowIso = new Date().toISOString();
  const updated = previousRequests.map((request) => {
    if (request.id !== requestId) return request;
    return {
      ...request,
      isDeleted: true,
      deletedAt: request.deletedAt || nowIso,
      isArchived: false,
    };
  });

  writeStoredRequests(updated);
  const after = updated.find((request) => request.id === requestId);
  recordAuditEvent({
    eventName: "evidence.request.deleted.soft",
    action: "Moved request to recycle bin",
    category: "evidence",
    module: "recycle-bin",
    feature: "soft-delete",
    source: "storage",
    severity: "warning",
    target: {
      entityType: "request",
      entityId: requestId,
      requestId,
    },
    change: {
      before,
      after,
    },
  });

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("storage"));
  }

  return updated;
}

export function restoreRequestFromRecycleBin(requestId: string) {
  const previousRequests = parseStoredRequests();
  const before = previousRequests.find((request) => request.id === requestId);

  const updated = previousRequests.map((request) => {
    if (request.id !== requestId) return request;

    const next: StoredRequest = {
      ...request,
      isDeleted: false,
    };

    delete next.deletedAt;
    return next;
  });

  writeStoredRequests(updated);
  const after = updated.find((request) => request.id === requestId);
  recordAuditEvent({
    eventName: "evidence.request.restored",
    action: "Restored request from recycle bin",
    category: "evidence",
    module: "recycle-bin",
    feature: "restore-request",
    source: "storage",
    target: {
      entityType: "request",
      entityId: requestId,
      requestId,
    },
    change: {
      before,
      after,
    },
  });

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("storage"));
  }

  return updated;
}

export function moveRequestToArchive(requestId: string, archivedBy?: string) {
  const previousRequests = parseStoredRequests();
  const before = previousRequests.find((request) => request.id === requestId);
  const nowIso = new Date().toISOString();
  const actor = String(archivedBy || "").trim();

  const updated = previousRequests.map((request) => {
    if (request.id !== requestId) return request;

    return {
      ...request,
      isArchived: true,
      archivedAt: request.archivedAt || nowIso,
      archivedBy: request.archivedBy || actor,
      isDeleted: false,
    };
  });

  writeStoredRequests(updated);
  const after = updated.find((request) => request.id === requestId);
  recordAuditEvent({
    eventName: "workflow.request.archived",
    action: "Archived request",
    category: "workflow",
    module: "archive",
    feature: "archive-request",
    source: "storage",
    target: {
      entityType: "request",
      entityId: requestId,
      requestId,
    },
    change: {
      before,
      after,
    },
    metadata: {
      archivedBy: actor || undefined,
    },
  });

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("storage"));
  }

  return updated;
}

export function unarchiveRequest(requestId: string) {
  const previousRequests = parseStoredRequests();
  const before = previousRequests.find((request) => request.id === requestId);

  const updated = previousRequests.map((request) => {
    if (request.id !== requestId) return request;

    const next: StoredRequest = {
      ...request,
      isArchived: false,
    };

    delete next.archivedAt;
    delete next.archivedBy;
    return next;
  });

  writeStoredRequests(updated);
  const after = updated.find((request) => request.id === requestId);
  recordAuditEvent({
    eventName: "workflow.request.unarchived",
    action: "Unarchived request",
    category: "workflow",
    module: "archive",
    feature: "unarchive-request",
    source: "storage",
    target: {
      entityType: "request",
      entityId: requestId,
      requestId,
    },
    change: {
      before,
      after,
    },
  });

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("storage"));
  }

  return updated;
}

export async function permanentlyDeleteRequest(requestId: string) {
  const previousRequests = parseStoredRequests();
  const before = previousRequests.find((request) => request.id === requestId);
  await permanentlyDeleteRequestFromBackend(requestId);
  const updated = previousRequests.filter((request) => request.id !== requestId);
  writeStoredRequests(updated);
  clearRequestArtifacts(requestId);

  recordAuditEvent({
    eventName: "evidence.request.deleted.permanent",
    action: "Permanently deleted request",
    category: "administration",
    module: "recycle-bin",
    feature: "permanent-delete",
    source: "storage",
    severity: "critical",
    target: {
      entityType: "request",
      entityId: requestId,
      requestId,
    },
    change: {
      before,
      after: null,
    },
  });

  return updated;
}

export function purgeExpiredRecycleBinItems(nowMs = Date.now()) {
  const purgedIds: string[] = [];

  const keptRequests = parseStoredRequests().filter((request) => {
    if (!request.isDeleted || !request.id) {
      return true;
    }

    const deletedAtMs = Date.parse(request.deletedAt || request.createdAt || "");
    if (!Number.isFinite(deletedAtMs)) {
      return true;
    }

    const isExpired = nowMs - deletedAtMs >= RETENTION_MS;
    if (isExpired) {
      purgedIds.push(request.id);
      return false;
    }

    return true;
  });

  if (purgedIds.length > 0) {
    writeStoredRequests(keptRequests);
    purgedIds.forEach((requestId) => {
      clearRequestArtifacts(requestId);
      void permanentlyDeleteRequestFromBackend(requestId);
    });

    recordAuditEvent({
      eventName: "system.recycle-bin.purged",
      action: "Purged expired recycle bin items",
      category: "system",
      module: "recycle-bin",
      feature: "retention-purge",
      source: "system",
      severity: "warning",
      metadata: {
        purgedIds,
        retentionDays: RETENTION_DAYS,
      },
    });
  }

  return {
    purgedIds,
    retentionDays: RETENTION_DAYS,
  };
}

export function purgeExpiredArchiveItems(nowMs = Date.now()) {
  const purgedIds: string[] = [];

  const keptRequests = parseStoredRequests().filter((request) => {
    if (!request.isArchived || request.isDeleted || !request.id) {
      return true;
    }

    const archivedAtMs = Date.parse(request.archivedAt || request.createdAt || "");
    if (!Number.isFinite(archivedAtMs)) {
      return true;
    }

    const isExpired = nowMs - archivedAtMs >= ARCHIVE_RETENTION_MS;
    if (isExpired) {
      purgedIds.push(request.id);
      return false;
    }

    return true;
  });

  if (purgedIds.length > 0) {
    writeStoredRequests(keptRequests);
    purgedIds.forEach((requestId) => {
      clearRequestArtifacts(requestId);
      void permanentlyDeleteRequestFromBackend(requestId);
    });

    recordAuditEvent({
      eventName: "system.archive.purged",
      action: "Purged expired archived requests",
      category: "system",
      module: "archive",
      feature: "retention-purge",
      source: "system",
      severity: "warning",
      metadata: {
        purgedIds,
        retentionYears: ARCHIVE_RETENTION_YEARS,
      },
    });
  }

  return {
    purgedIds,
    retentionYears: ARCHIVE_RETENTION_YEARS,
  };
}

export function getRecycleBinCountdownLabel(deletedAt?: string) {
  if (!deletedAt) {
    return `${RETENTION_DAYS} days left`;
  }

  const deletedAtMs = Date.parse(deletedAt);
  if (!Number.isFinite(deletedAtMs)) {
    return `${RETENTION_DAYS} days left`;
  }

  const elapsed = Math.max(0, Date.now() - deletedAtMs);
  const remainingDays = Math.max(0, Math.ceil((RETENTION_MS - elapsed) / (24 * 60 * 60 * 1000)));
  return `${remainingDays} day${remainingDays === 1 ? "" : "s"} left`;
}
