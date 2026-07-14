import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { jsPDF } from "jspdf";
import {
  type AuditCategory,
  type AuditLogEntry,
  downloadAuditCsv,
  queryAuditLogs,
  recordAuditEvent,
  verifyAuditLogIntegrity,
} from "../utils/auditLog";
import { formatDateReport, formatDateTimeDMY } from "../utils/dateTime";
import { cardSubtleStyle, primaryButtonStyle, secondaryButtonStyle, inputStyle as themedInputStyle } from "../styles/tokens";

type FiltersState = {
  userEmail: string;
  actionIncludes: string;
  category: AuditCategory | "all";
  requestId: string;
  evidenceId: string;
  startDate: string;
  endDate: string;
};

const INITIAL_FILTERS: FiltersState = {
  userEmail: "",
  actionIncludes: "",
  category: "all",
  requestId: "",
  evidenceId: "",
  startDate: "",
  endDate: "",
};

export default function AuditLogPage() {
  const [filters, setFilters] = useState<FiltersState>(INITIAL_FILTERS);
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [logsShown, setLogsShown] = useState(100);

  useEffect(() => {
    function refresh() {
      const next = queryAuditLogs(filters);
      setLogs(next);
      setLogsShown(100); // Reset pagination on filter change
      if (next.length > 0 && !selectedLogId) {
        setSelectedLogId(next[0].id);
      }
      if (selectedLogId && !next.some((entry) => entry.id === selectedLogId)) {
        setSelectedLogId(next[0]?.id || null);
      }
    }

    refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener("audit-log-updated", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("audit-log-updated", refresh);
    };
  }, [filters, selectedLogId]);

  const selectedLog = useMemo(
    () => logs.find((entry) => entry.id === selectedLogId) || null,
    [logs, selectedLogId]
  );

  const integrity = useMemo(() => verifyAuditLogIntegrity(logs), [logs]);

  function updateFilter<Key extends keyof FiltersState>(key: Key, value: FiltersState[Key]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function resetFilters() {
    setFilters(INITIAL_FILTERS);
  }

  function handleExportCsv() {
    downloadAuditCsv(logs);
    recordAuditEvent({
      eventName: "audit.log.export.csv",
      action: "Exported filtered audit logs as CSV",
      category: "file_access",
      module: "audit",
      feature: "audit-log-dashboard",
      source: "ui",
      metadata: {
        count: logs.length,
        filters,
      },
    });
  }

  function handleExportPdf() {
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const margin = 42;
    const lineHeight = 14;
    const maxWidth = doc.internal.pageSize.getWidth() - margin * 2;
    let y = margin;

    const writeLine = (line: string, bold = false) => {
      doc.setFont("helvetica", bold ? "bold" : "normal");
      const wrapped = doc.splitTextToSize(line, maxWidth) as string[];
      wrapped.forEach((segment) => {
        if (y > doc.internal.pageSize.getHeight() - margin) {
          doc.addPage();
          y = margin;
        }
        doc.text(segment, margin, y);
        y += lineHeight;
      });
    };

    writeLine("EviDex Audit Log Export", true);
    writeLine(`Generated: ${formatDateReport(new Date())}`);
    writeLine(`Record Count: ${logs.length}`);
    writeLine(`Filters: ${JSON.stringify(filters)}`);
    y += 4;

    logs.forEach((entry, index) => {
      writeLine(`${index + 1}. ${formatDateReport(entry.timestamp)} | ${entry.eventName}`, true);
      writeLine(`Action: ${entry.action}`);
      writeLine(`Actor: ${entry.actor.email} (${entry.actor.role})`);
      writeLine(`Module/Feature: ${entry.module} / ${entry.feature}`);
      writeLine(`Target: ${entry.target?.entityType || "N/A"} ${entry.target?.entityId || ""}`);
      writeLine(`Request/Evidence: ${entry.target?.requestId || "-"} / ${entry.target?.evidenceId || "-"}`);
      if (entry.change?.before || entry.change?.after) {
        writeLine(`Before: ${JSON.stringify(entry.change?.before || null)}`);
        writeLine(`After: ${JSON.stringify(entry.change?.after || null)}`);
      }
      if (entry.metadata) {
        writeLine(`Metadata: ${JSON.stringify(entry.metadata)}`);
      }
      writeLine(`Hash: ${entry.hash}`);
      y += 4;
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    doc.save(`audit-log-${timestamp}.pdf`);

    recordAuditEvent({
      eventName: "audit.log.export.pdf",
      action: "Exported filtered audit logs as PDF",
      category: "file_access",
      module: "audit",
      feature: "audit-log-dashboard",
      source: "ui",
      metadata: {
        count: logs.length,
        filters,
      },
    });
  }

  function renderJson(value: unknown) {
    if (value === undefined) {
      return "N/A";
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  return (
    <div
      style={{
        maxWidth: "1200px",
        height: "calc(100vh - 64px)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <h1 style={{ marginTop: 0, marginBottom: "8px" }}>Audit Log</h1>
      <p style={{ marginTop: 0, marginBottom: "14px", color: "var(--text-muted)" }}>
        Compliance-grade, append-only event history with actor, action, timestamp, module, and state-change traceability. Retention Policy: Delete logs older than 7 years.
      </p>

      <section
        style={{
          ...cardSubtleStyle,
          padding: "14px",
          marginBottom: "12px",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: "10px",
          }}
        >
          <label style={labelStyle}>
            User
            <input value={filters.userEmail} onChange={(event) => updateFilter("userEmail", event.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Action
            <input value={filters.actionIncludes} onChange={(event) => updateFilter("actionIncludes", event.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Category
            <select value={filters.category} onChange={(event) => updateFilter("category", event.target.value as FiltersState["category"])} style={themedInputStyle}>
              <option value="all">All</option>
              <option value="authentication">Authentication</option>
              <option value="authorization">Authorization</option>
              <option value="evidence">Evidence</option>
              <option value="workflow">Workflow</option>
              <option value="file_access">File Access</option>
              <option value="configuration">Configuration</option>
              <option value="administration">Administration</option>
              <option value="system">System</option>
            </select>
          </label>
          <label style={labelStyle}>
            Request ID
            <input value={filters.requestId} onChange={(event) => updateFilter("requestId", event.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Evidence ID
            <input value={filters.evidenceId} onChange={(event) => updateFilter("evidenceId", event.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Start Date
            <input type="date" value={filters.startDate} onChange={(event) => updateFilter("startDate", event.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            End Date
            <input type="date" value={filters.endDate} onChange={(event) => updateFilter("endDate", event.target.value)} style={inputStyle} />
          </label>
          <div style={{ display: "flex", alignItems: "end", gap: "8px" }}>
            <button onClick={resetFilters} style={secondaryButtonStyle}>Reset</button>
            <button onClick={handleExportCsv} style={secondaryButtonStyle}>Export CSV</button>
            <button onClick={handleExportPdf} style={primaryButtonStyle}>Export PDF</button>
          </div>
        </div>

        <div style={{ marginTop: "10px", fontSize: "12px", color: integrity.ok ? "var(--color-success-text)" : "var(--color-danger-text)" }}>
          Integrity: {integrity.message}
        </div>
      </section>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: "12px",
          flex: 1,
          minHeight: 0,
        }}
      >
        <section style={{ ...cardSubtleStyle, padding: "10px", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <h2 style={{ margin: "0 0 8px 0", fontSize: "16px" }}>Timeline</h2>
          <div style={{ overflowY: "auto", minHeight: 0, display: "grid", gap: "8px", paddingRight: "4px" }}>
            {logs.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: "13px" }}>No audit events match the current filters.</div>
            ) : (
              <>
                {logs.slice(0, logsShown).map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setSelectedLogId(entry.id)}
                    style={{
                      border: selectedLogId === entry.id ? "1px solid var(--evidex-green)" : "1px solid var(--border-color)",
                      borderRadius: "8px",
                      background: selectedLogId === entry.id ? "var(--evidex-green-tint)" : "var(--card-bg-subtle)",
                      color: "inherit",
                      textAlign: "left",
                      cursor: "pointer",
                      padding: "10px",
                      display: "grid",
                      gap: "4px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "center" }}>
                      <strong style={{ fontSize: "13px" }}>{entry.eventName}</strong>
                      <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{formatDateTimeDMY(entry.timestamp)}</span>
                    </div>
                    <div style={{ fontSize: "12px" }}>{entry.action}</div>
                    <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                      {entry.actor.email} • {entry.module}/{entry.feature}
                    </div>
                  </button>
                ))}
                {logsShown < logs.length && (
                  <button
                    type="button"
                    onClick={() => setLogsShown((prev) => prev + 100)}
                    style={{
                      margin: "12px auto 0 auto",
                      display: "block",
                      background: "var(--color-infoBg, #dbeafe)",
                      color: "var(--color-infoText, #1e3a8a)",
                      border: "1px solid var(--color-infoBorder, #93c5fd)",
                      borderRadius: "6px",
                      padding: "8px 18px",
                      fontWeight: 600,
                      fontSize: "14px",
                      cursor: "pointer",
                    }}
                  >
                    Load More
                  </button>
                )}
              </>
            )}
          </div>
        </section>

        <section style={{ ...cardSubtleStyle, padding: "12px", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <h2 style={{ margin: "0 0 8px 0", fontSize: "16px" }}>Drill-Down</h2>
          {!selectedLog ? (
            <div style={{ color: "var(--text-muted)", fontSize: "13px" }}>Select an event to inspect full details.</div>
          ) : (
            <div style={{ overflowY: "auto", minHeight: 0, display: "grid", gap: "10px", paddingRight: "4px" }}>
              <div style={detailBlockStyle}>
                <strong>{selectedLog.eventName}</strong>
                <div>{selectedLog.action}</div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                  {formatDateTimeDMY(selectedLog.timestamp)} • {selectedLog.actor.email} ({selectedLog.actor.role})
                </div>
              </div>

              <div style={detailBlockStyle}>
                <div><strong>Module:</strong> {selectedLog.module}</div>
                <div><strong>Feature:</strong> {selectedLog.feature}</div>
                <div><strong>Route:</strong> {selectedLog.route}</div>
                <div><strong>Category:</strong> {selectedLog.category}</div>
                <div><strong>Severity:</strong> {selectedLog.severity}</div>
              </div>

              <div style={detailBlockStyle}>
                <div><strong>Linked Records</strong></div>
                <div>Entity Type: {selectedLog.target?.entityType || "N/A"}</div>
                <div>Entity ID: {selectedLog.target?.entityId || "N/A"}</div>
                <div>Request ID: {selectedLog.target?.requestId || "N/A"}</div>
                <div>Evidence ID: {selectedLog.target?.evidenceId || "N/A"}</div>
              </div>

              <div style={detailBlockStyle}>
                <div><strong>Before</strong></div>
                <pre style={jsonStyle}>{renderJson(selectedLog.change?.before)}</pre>
              </div>

              <div style={detailBlockStyle}>
                <div><strong>After</strong></div>
                <pre style={jsonStyle}>{renderJson(selectedLog.change?.after)}</pre>
              </div>

              <div style={detailBlockStyle}>
                <div><strong>Metadata</strong></div>
                <pre style={jsonStyle}>{renderJson(selectedLog.metadata)}</pre>
              </div>

              <div style={detailBlockStyle}>
                <div style={{ fontSize: "12px", wordBreak: "break-all" }}><strong>Prev Hash:</strong> {selectedLog.prevHash}</div>
                <div style={{ fontSize: "12px", wordBreak: "break-all" }}><strong>Hash:</strong> {selectedLog.hash}</div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "4px",
  fontSize: "12px",
  fontWeight: 600,
};

const inputStyle: CSSProperties = {
  width: "100%",
  border: "1px solid var(--border-color)",
  borderRadius: "6px",
  padding: "7px 10px",
  background: "var(--card-bg)",
  color: "inherit",
  boxSizing: "border-box",
};

const detailBlockStyle: CSSProperties = {
  border: "1px solid var(--border-color)",
  borderRadius: "8px",
  padding: "10px",
  background: "var(--card-bg-subtle)",
  display: "grid",
  gap: "4px",
};

const jsonStyle: CSSProperties = {
  margin: 0,
  fontSize: "12px",
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};
