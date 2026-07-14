import { useEffect, useState } from "react";
import {
  ensureEvidencePreviewAvailable,
  getEvidenceDownloadUrl,
  getEvidenceItems,
  getEvidencePreviewUrl,
} from "../api/backend-api";
import type { EvidenceLinkItem } from "../api/types";
import { useToast } from "../context/ToastContext";
import { secondaryButtonStyle } from "../styles/tokens";
import { getStoredRequests } from "../utils/recycleBin";
import { recordAuditEvent } from "../utils/auditLog";

export default function EvidenceTable() {
  const { showToast } = useToast();
  const [requestId, setRequestId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<EvidenceLinkItem[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadEvidence() {
      try {
        setLoading(true);
        setError(null);

        const storedRequestId = sessionStorage.getItem("evidex-current-request-id") || "";
        const latestRequestId = getStoredRequests().find((request) => !request.isDeleted && !request.isArchived)?.id || "";
        const resolvedRequestId = storedRequestId || latestRequestId;

        if (!resolvedRequestId) {
          if (!cancelled) {
            setItems([]);
            setError("No active request found. Start a workflow request to view evidence.");
          }
          return;
        }

        const evidence = await getEvidenceItems(resolvedRequestId);
        if (!cancelled) {
          setRequestId(resolvedRequestId);
          setItems(evidence);
        }
      } catch (err) {
        if (!cancelled) {
          setItems([]);
          setError(err instanceof Error ? err.message : "Failed to load evidence items");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadEvidence();

    return () => {
      cancelled = true;
    };
  }, []);

  function canPreviewInBrowser(item: EvidenceLinkItem): boolean {
    const fileType = String(item.file_type || "").toLowerCase();
    const filename = String(item.filename || "").toLowerCase();
    return (
      ["pdf", "txt", "csv", "json", "msg", "png", "jpg", "jpeg", "gif", "webp", "doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(fileType) ||
      /\.(pdf|txt|csv|json|msg|png|jpe?g|gif|webp|docx?|xlsx?|pptx?)$/i.test(filename)
    );
  }

  function isOfficeConvertible(item: EvidenceLinkItem): boolean {
    const fileType = String(item.file_type || "").toLowerCase();
    const filename = String(item.filename || "").toLowerCase();
    return ["doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(fileType) || /\.(docx?|xlsx?|pptx?)$/i.test(filename);
  }

  async function openEvidenceInBrowser(item: EvidenceLinkItem): Promise<void> {
    if (!requestId) {
      return;
    }

    if (!canPreviewInBrowser(item)) {
      showToast(
        "This file type cannot be rendered inline in the browser. Open is limited to browser-previewable formats.",
        "warning"
      );
      return;
    }

    if (isOfficeConvertible(item)) {
      try {
        await ensureEvidencePreviewAvailable(requestId, item.evidence_id);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Office preview is unavailable";
        showToast(message, "warning");
        return;
      }
    }

    const opened = window.open(
      getEvidencePreviewUrl(requestId, item.evidence_id),
      "_blank",
      "noopener,noreferrer"
    );

    if (!opened) {
      showToast("Could not open evidence in a new tab. Please allow pop-ups and try again.", "warning");
      recordAuditEvent({
        eventName: "file.evidence.view.blocked",
        action: "Evidence preview blocked by browser",
        category: "file_access",
        module: "evidence",
        feature: "preview-evidence",
        source: "ui",
        severity: "warning",
        target: {
          entityType: "evidence",
          entityId: item.evidence_id,
          requestId,
          evidenceId: item.evidence_id,
        },
      });
      return;
    }

    recordAuditEvent({
      eventName: "file.evidence.viewed",
      action: "Viewed evidence in browser preview",
      category: "file_access",
      module: "evidence",
      feature: "preview-evidence",
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
  }

  if (loading) {
    return (
      <div style={{ border: "1px solid var(--border-color)", borderRadius: "12px", padding: "16px" }}>
        Loading evidence items...
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          border: "1px solid var(--color-danger-border)",
          borderRadius: "12px",
          padding: "16px",
          color: "var(--color-danger-text)",
        }}
      >
        {error}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div style={{ border: "1px solid var(--border-color)", borderRadius: "12px", padding: "16px", color: "var(--text-muted)" }}>
        No evidence items found for this request.
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid var(--border-color)", borderRadius: "12px", overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "var(--card-bg-subtle)" }}>
            <th style={thStyle}>Evidence Item</th>
            <th style={thStyle}>Open Mode</th>
            <th style={thStyle}>Action</th>
          </tr>
        </thead>

        <tbody>
          {items.map((item) => (
            <tr key={item.evidence_id}>
              <td style={tdStyle}>
                {canPreviewInBrowser(item) ? (
                  <button
                    type="button"
                    onClick={() => {
                      void openEvidenceInBrowser(item);
                    }}
                    style={{
                      border: "none",
                      background: "transparent",
                      padding: 0,
                      color: "var(--evidex-green)",
                      textDecoration: "underline",
                      cursor: "pointer",
                      font: "inherit",
                      textAlign: "left",
                    }}
                    title={item.filename}
                  >
                    {item.filename}
                  </button>
                ) : (
                  <span title={`${item.filename} (not inline browser-previewable)`}>{item.filename}</span>
                )}
              </td>
              <td style={tdStyle}>{canPreviewInBrowser(item) ? "Inline Preview" : "Not Inline-Previewable"}</td>
              <td style={tdStyle}>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <button
                    type="button"
                    onClick={() => {
                      void openEvidenceInBrowser(item);
                    }}
                    disabled={!canPreviewInBrowser(item)}
                    style={{ ...secondaryButtonStyle, padding: "6px 12px", fontSize: "13px" }}
                    title={
                      canPreviewInBrowser(item)
                        ? "Open in browser"
                        : "This file type cannot be rendered inline in browser"
                    }
                  >
                    Open
                  </button>
                  <a
                    href={getEvidenceDownloadUrl(requestId, item.evidence_id)}
                    onClick={() => {
                      recordAuditEvent({
                        eventName: "file.evidence.downloaded",
                        action: "Downloaded evidence file",
                        category: "file_access",
                        module: "evidence",
                        feature: "download-evidence",
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
                      padding: "6px 12px",
                      textDecoration: "none",
                      fontSize: "13px",
                      fontWeight: 600,
                    }}
                  >
                    Download
                  </a>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "12px",
  textAlign: "left",
  fontSize: "12px",
  fontWeight: 600,
  borderBottom: "1px solid var(--border-color)",
  color: "inherit",
};

const tdStyle: React.CSSProperties = {
  padding: "12px",
  fontSize: "14px",
  borderBottom: "1px solid var(--border-color)",
  verticalAlign: "middle",
};