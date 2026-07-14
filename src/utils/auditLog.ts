export const AUDIT_LOG_STORAGE_KEY = "evidex-audit-logs";
const RETENTION_YEARS = 7;
const RETENTION_MS = RETENTION_YEARS * 365 * 24 * 60 * 60 * 1000;
const MAX_AUDIT_LOG_ENTRIES = 1500;
const TRIM_BATCH_SIZE = 50;

export type AuditCategory =
  | "authentication"
  | "authorization"
  | "evidence"
  | "workflow"
  | "file_access"
  | "configuration"
  | "administration"
  | "system";

export type AuditSeverity = "info" | "warning" | "critical";

export type AuditActor = {
  email: string;
  role: string;
  userId: string;
};

export type AuditTarget = {
  entityType: string;
  entityId?: string;
  requestId?: string;
  evidenceId?: string;
  linkedRecordIds?: string[];
};

export type AuditChangeSet = {
  before?: unknown;
  after?: unknown;
};

export type AuditLogEntry = {
  id: string;
  sequence: number;
  timestamp: string;
  retentionUntil: string;
  eventName: string;
  action: string;
  category: AuditCategory;
  severity: AuditSeverity;
  actor: AuditActor;
  module: string;
  feature: string;
  route: string;
  source: "ui" | "api" | "storage" | "system";
  target?: AuditTarget;
  change?: AuditChangeSet;
  metadata?: Record<string, unknown>;
  prevHash: string;
  hash: string;
};

export type AuditQueryFilters = {
  userEmail?: string;
  actionIncludes?: string;
  eventNameIncludes?: string;
  category?: AuditCategory | "all";
  requestId?: string;
  evidenceId?: string;
  startDate?: string;
  endDate?: string;
};

export type RecordAuditEventInput = {
  eventName: string;
  action: string;
  category: AuditCategory;
  module: string;
  feature: string;
  route?: string;
  severity?: AuditSeverity;
  actor?: Partial<AuditActor>;
  source?: "ui" | "api" | "storage" | "system";
  target?: AuditTarget;
  change?: AuditChangeSet;
  metadata?: Record<string, unknown>;
};

function safeJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function getNowIso(): string {
  return new Date().toISOString();
}

function addRetention(dateIso: string): string {
  const base = Date.parse(dateIso);
  if (!Number.isFinite(base)) {
    return new Date(Date.now() + RETENTION_MS).toISOString();
  }
  return new Date(base + RETENTION_MS).toISOString();
}

function parseLogs(): AuditLogEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(AUDIT_LOG_STORAGE_KEY) || "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as AuditLogEntry[]) : [];
  } catch {
    return [];
  }
}

function isQuotaExceededError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  return /quota|exceeded|storage/i.test(err.message);
}

function compactEntry(entry: AuditLogEntry): AuditLogEntry {
  const metadata = entry.metadata
    ? {
        summary: "Metadata truncated due to storage limits",
      }
    : undefined;

  const change = entry.change
    ? {
        before: entry.change.before ? "[truncated]" : undefined,
        after: entry.change.after ? "[truncated]" : undefined,
      }
    : undefined;

  return {
    ...entry,
    metadata,
    change,
  };
}

function rechainLogs(logs: AuditLogEntry[]): AuditLogEntry[] {
  const chained: AuditLogEntry[] = [];

  for (let index = 0; index < logs.length; index += 1) {
    const original = logs[index];
    const prevHash = index === 0 ? "GENESIS" : chained[index - 1].hash;

    const entryWithoutHash: Omit<AuditLogEntry, "hash"> = {
      id: original.id,
      sequence: original.sequence,
      timestamp: original.timestamp,
      retentionUntil: original.retentionUntil,
      eventName: original.eventName,
      action: original.action,
      category: original.category,
      severity: original.severity,
      actor: original.actor,
      module: original.module,
      feature: original.feature,
      route: original.route,
      source: original.source,
      target: original.target,
      change: original.change,
      metadata: original.metadata,
      prevHash,
    };

    chained.push({
      ...entryWithoutHash,
      hash: buildEntryHash(entryWithoutHash),
    });
  }

  return chained;
}

function writeLogs(logs: AuditLogEntry[]) {
  const bounded = logs.length > MAX_AUDIT_LOG_ENTRIES ? logs.slice(-MAX_AUDIT_LOG_ENTRIES) : logs;
  let candidate = rechainLogs(bounded);

  try {
    localStorage.setItem(AUDIT_LOG_STORAGE_KEY, JSON.stringify(candidate));
  } catch (err) {
    if (!isQuotaExceededError(err)) {
      throw err;
    }

    // If storage is full, trim oldest logs in batches and retry.
    let writeSucceeded = false;
    while (candidate.length > 1) {
      candidate = rechainLogs(candidate.slice(TRIM_BATCH_SIZE));
      try {
        localStorage.setItem(AUDIT_LOG_STORAGE_KEY, JSON.stringify(candidate));
        writeSucceeded = true;
        break;
      } catch (retryErr) {
        if (!isQuotaExceededError(retryErr)) {
          throw retryErr;
        }
      }
    }

    if (!writeSucceeded) {
      // Last resort: keep only a compacted tail to preserve recent auditability.
      const compactedTail = rechainLogs(candidate.slice(-200).map((entry) => compactEntry(entry)));
      try {
        localStorage.setItem(AUDIT_LOG_STORAGE_KEY, JSON.stringify(compactedTail));
      } catch (lastErr) {
        if (!isQuotaExceededError(lastErr)) {
          throw lastErr;
        }

        // Never let logging crash the app; retain only the latest event slot if possible.
        try {
          const minimalTail = rechainLogs(compactedTail.slice(-1));
          localStorage.setItem(AUDIT_LOG_STORAGE_KEY, JSON.stringify(minimalTail));
        } catch {
          // Ignore final storage failure to keep app flow functional.
        }
      }
    }
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("audit-log-updated"));
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",");
  return `{${body}}`;
}

function hashString(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function buildEntryHash(entryWithoutHash: Omit<AuditLogEntry, "hash">): string {
  return hashString(stableStringify(entryWithoutHash));
}

function getCurrentActor(): AuditActor {
  const email = String(sessionStorage.getItem("userEmail") || "system@local").trim() || "system@local";
  const role = String(sessionStorage.getItem("userRole") || "system").trim() || "system";
  const userId = email.includes("@") ? email.split("@")[0] : email;
  return { email, role, userId };
}

export function purgeExpiredAuditLogs(nowMs = Date.now()): { purgedCount: number } {
  const logs = parseLogs();
  const kept = logs.filter((entry) => {
    const retentionMs = Date.parse(entry.retentionUntil || "");
    if (!Number.isFinite(retentionMs)) {
      return true;
    }
    return retentionMs > nowMs;
  });

  const purgedCount = logs.length - kept.length;
  if (purgedCount > 0) {
    writeLogs(kept);
  }

  return { purgedCount };
}

export function recordAuditEvent(input: RecordAuditEventInput): AuditLogEntry {
  purgeExpiredAuditLogs();

  const logs = parseLogs();
  const previous = logs[logs.length - 1];
  const now = getNowIso();
  const actor = {
    ...getCurrentActor(),
    ...safeJson(input.actor || {}),
  };

  const sequence = (previous?.sequence || 0) + 1;
  const id = `AUD-${String(sequence).padStart(8, "0")}`;

  const entryWithoutHash: Omit<AuditLogEntry, "hash"> = {
    id,
    sequence,
    timestamp: now,
    retentionUntil: addRetention(now),
    eventName: input.eventName,
    action: input.action,
    category: input.category,
    severity: input.severity || "info",
    actor,
    module: input.module,
    feature: input.feature,
    route:
      input.route ||
      (typeof window !== "undefined" ? window.location.pathname : "unknown"),
    source: input.source || "ui",
    target: safeJson(input.target),
    change: safeJson(input.change),
    metadata: safeJson(input.metadata),
    prevHash: previous?.hash || "GENESIS",
  };

  const entry: AuditLogEntry = {
    ...entryWithoutHash,
    hash: buildEntryHash(entryWithoutHash),
  };

  logs.push(entry);
  writeLogs(logs);
  return entry;
}

export function getAuditLogs(): AuditLogEntry[] {
  purgeExpiredAuditLogs();
  return parseLogs().sort(
    (left, right) =>
      Date.parse(right.timestamp || "") - Date.parse(left.timestamp || "")
  );
}

export function queryAuditLogs(filters: AuditQueryFilters): AuditLogEntry[] {
  const all = getAuditLogs();
  const startMs = filters.startDate ? Date.parse(filters.startDate) : NaN;
  const endMs = filters.endDate ? Date.parse(filters.endDate) : NaN;

  return all.filter((entry) => {
    if (filters.userEmail) {
      const candidate = entry.actor.email.toLowerCase();
      if (!candidate.includes(filters.userEmail.toLowerCase())) {
        return false;
      }
    }

    if (filters.actionIncludes) {
      const candidate = entry.action.toLowerCase();
      if (!candidate.includes(filters.actionIncludes.toLowerCase())) {
        return false;
      }
    }

    if (filters.eventNameIncludes) {
      const candidate = entry.eventName.toLowerCase();
      if (!candidate.includes(filters.eventNameIncludes.toLowerCase())) {
        return false;
      }
    }

    if (filters.category && filters.category !== "all" && entry.category !== filters.category) {
      return false;
    }

    if (filters.requestId && entry.target?.requestId !== filters.requestId) {
      return false;
    }

    if (filters.evidenceId && entry.target?.evidenceId !== filters.evidenceId) {
      return false;
    }

    const eventMs = Date.parse(entry.timestamp || "");
    if (Number.isFinite(startMs) && eventMs < startMs) {
      return false;
    }

    if (Number.isFinite(endMs)) {
      const dayEnd = endMs + 24 * 60 * 60 * 1000 - 1;
      if (eventMs > dayEnd) {
        return false;
      }
    }

    return true;
  });
}

export function verifyAuditLogIntegrity(logs: AuditLogEntry[] = getAuditLogs()): {
  ok: boolean;
  brokenAtId?: string;
  message: string;
} {
  const chronological = [...logs].sort((a, b) => a.sequence - b.sequence);

  for (let index = 0; index < chronological.length; index += 1) {
    const current = chronological[index];
    const previous = chronological[index - 1];

    const { hash, ...withoutHash } = current;
    const recomputed = buildEntryHash(withoutHash);
    if (recomputed !== hash) {
      return {
        ok: false,
        brokenAtId: current.id,
        message: `Hash mismatch at ${current.id}`,
      };
    }

    if (index === 0 && current.prevHash !== "GENESIS") {
      return {
        ok: false,
        brokenAtId: current.id,
        message: `First record does not point to GENESIS`,
      };
    }

    if (index > 0 && current.prevHash !== previous.hash) {
      return {
        ok: false,
        brokenAtId: current.id,
        message: `Chain broken at ${current.id}`,
      };
    }
  }

  return {
    ok: true,
    message: "Audit hash chain verified",
  };
}

function csvEscape(value: unknown): string {
  const normalized = String(value ?? "").replace(/\r?\n/g, " ");
  if (/[",]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

export function buildAuditCsv(logs: AuditLogEntry[]): string {
  const headers = [
    "id",
    "timestamp",
    "eventName",
    "action",
    "category",
    "severity",
    "actorEmail",
    "actorRole",
    "module",
    "feature",
    "route",
    "entityType",
    "entityId",
    "requestId",
    "evidenceId",
    "changeBefore",
    "changeAfter",
    "metadata",
    "prevHash",
    "hash",
  ];

  const rows = logs.map((entry) => [
    entry.id,
    entry.timestamp,
    entry.eventName,
    entry.action,
    entry.category,
    entry.severity,
    entry.actor.email,
    entry.actor.role,
    entry.module,
    entry.feature,
    entry.route,
    entry.target?.entityType || "",
    entry.target?.entityId || "",
    entry.target?.requestId || "",
    entry.target?.evidenceId || "",
    entry.change?.before ? JSON.stringify(entry.change.before) : "",
    entry.change?.after ? JSON.stringify(entry.change.after) : "",
    entry.metadata ? JSON.stringify(entry.metadata) : "",
    entry.prevHash,
    entry.hash,
  ]);

  const csvLines = [headers, ...rows].map((row) => row.map((cell) => csvEscape(cell)).join(","));
  return csvLines.join("\n");
}

export function downloadAuditCsv(logs: AuditLogEntry[]) {
  const csv = buildAuditCsv(logs);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  anchor.href = href;
  anchor.download = `audit-log-${timestamp}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(href);
}
