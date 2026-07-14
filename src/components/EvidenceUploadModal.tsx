import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { uploadEvidence } from "../api/backend-api";
import { useToast } from "../context/ToastContext";
import { recordAuditEvent } from "../utils/auditLog";

const SUPPORTED_UPLOAD_GROUPS = {
  documents: ["PDF", "DOCX", "TXT", "MSG"],
  data: ["CSV", "XLSX", "JSON", "XML"],
  images: ["PNG", "JPG", "JPEG"],
  archives: ["ZIP"],
};

const ACCEPTED_FILE_TYPES = ".pdf,.docx,.txt,.msg,.csv,.xlsx,.json,.xml,.png,.jpg,.jpeg,.zip";

type Props = {
  requestId: string;
  onClose: () => void;
};

export default function EvidenceUploadModal({ requestId, onClose }: Props) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [fileList, setFileList] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const bodyStyle = document.body.style;
    const previousOverflow = bodyStyle.overflow;
    const previousPaddingRight = bodyStyle.paddingRight;
    const previousPosition = bodyStyle.position;
    const previousTop = bodyStyle.top;
    const previousWidth = bodyStyle.width;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const scrollbarCompensation = window.innerWidth - document.documentElement.clientWidth;

    bodyStyle.overflow = "hidden";
    bodyStyle.position = "fixed";
    bodyStyle.top = `-${scrollY}px`;
    bodyStyle.width = "100%";
    if (scrollbarCompensation > 0) {
      bodyStyle.paddingRight = `${scrollbarCompensation}px`;
    }

    return () => {
      bodyStyle.overflow = previousOverflow;
      bodyStyle.paddingRight = previousPaddingRight;
      bodyStyle.position = previousPosition;
      bodyStyle.top = previousTop;
      bodyStyle.width = previousWidth;
      window.scrollTo({ top: scrollY, behavior: "auto" });
    };
  }, []);

  function mergeFiles(incoming: File[]) {
    setFileList((prev) => {
      const existing = new Set(prev.map((f) => f.name + f.size));
      const deduped = incoming.filter((f) => !existing.has(f.name + f.size));
      return [...prev, ...deduped];
    });
  }

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) {
      mergeFiles(dropped);
    }
  }, []);

  async function handleUpload() {
    if (fileList.length === 0) return;

    try {
      setUploading(true);
      setError(null);

      const result = await uploadEvidence(
        requestId,
        fileList
      );

      console.log(`[Upload] uploadEvidence completed, returned stage=${result.stage}, evidence_count=${result.upload?.uploaded_count}`);

      const rejectedFiles = (result.upload?.rejected_files || []).filter(Boolean);
      if (rejectedFiles.length > 0) {
        showToast(
          `Rejected unrelated evidence file${rejectedFiles.length > 1 ? "s" : ""}: ${rejectedFiles.join(", ")}`,
          "warning"
        );
      }

      // ✅ Store validation result
      localStorage.setItem(
        `evidex-agent-result-${requestId}`,
        JSON.stringify(result.validation)
      );

      // ✅ Store full agent reasoning logs
      localStorage.setItem(
        `evidex-agent-logs-${requestId}`,
        JSON.stringify(result.logs || [])
      );

      if (result.conclusion) {
        localStorage.setItem(
          `evidex-agent-conclusion-${requestId}`,
          JSON.stringify(result.conclusion)
        );
      }

      if (result.bedrock_summary) {
        localStorage.setItem(
          `evidex-bedrock-summary-${requestId}`,
          JSON.stringify(result.bedrock_summary)
        );
      }

      const storedRequests = JSON.parse(
        localStorage.getItem("evidex-requests") || "[]"
      );

      const updatedRequests = storedRequests.map((request: { id: string; status?: string }) =>
        request.id === requestId
          ? { ...request, status: result.stage || request.status || "validation" }
          : request
      );

      localStorage.setItem(
        "evidex-requests",
        JSON.stringify(updatedRequests)
      );

      sessionStorage.setItem(
        "evidex-post-upload-summary-request",
        requestId
      );

      // Mark that upload was completed so auto-open effect won't re-trigger modal
      sessionStorage.setItem(`evidex-upload-completed-${requestId}`, "1");

      showToast(
        result.validation.sufficient
          ? "Evidence uploaded and validated successfully."
          : "Evidence uploaded. Additional documentation may be required.",
        result.validation.sufficient ? "success" : "warning"
      );

      setFileList([]);
      onClose(); // Instantly close modal
      
      // Navigate after a short delay to ensure modal closes first
      setTimeout(() => {
        navigate(`/audit/${requestId}?tab=status&summary=1`);
      }, 100);
    } catch (uploadError) {
      const message =
        uploadError instanceof Error
          ? uploadError.message
          : "Evidence upload failed.";
      recordAuditEvent({
        eventName: "evidence.upload.failed",
        action: "Evidence upload attempt failed",
        category: "evidence",
        module: "evidence",
        feature: "upload-modal",
        source: "ui",
        severity: "warning",
        target: {
          entityType: "request",
          entityId: requestId,
          requestId,
        },
        metadata: {
          fileCount: fileList.length,
          filenames: fileList.map((file) => file.name),
          reason: message,
        },
      });
      setError(message);
      showToast(message, "warning");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="evidex-modal-overlay">
      <div
        className="evidex-modal-panel"
        style={{
          width: "400px",
        }}
      >
        <h2 style={{ marginBottom: "16px" }}>
          Upload Evidence
        </h2>

        {/* Drag-and-drop zone */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${isDragOver ? "var(--evidex-green)" : "var(--border-color)"}`,
            borderRadius: "8px",
            padding: "28px 16px",
            textAlign: "center",
            cursor: "pointer",
            background: isDragOver ? "var(--color-success-bg, rgba(153,204,0,0.08))" : "transparent",
            transition: "border-color 0.15s, background 0.15s",
            marginBottom: "12px",
          }}
        >
          <div style={{ fontSize: "28px", marginBottom: "8px", lineHeight: 1 }}>📂</div>
          <div style={{ fontWeight: 600, fontSize: "14px" }}>
            {isDragOver ? "Drop files here" : "Drag & drop files here"}
          </div>
          <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
            or click to browse
          </div>
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_FILE_TYPES}
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) {
              mergeFiles(Array.from(e.target.files));
              e.target.value = "";
            }
          }}
        />

        {/* Selected file list */}
        {fileList.length > 0 && (
          <ul
            style={{
              margin: "0 0 12px 0",
              padding: "0",
              listStyle: "none",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              maxHeight: "140px",
              overflowY: "auto",
            }}
          >
            {fileList.map((file, idx) => (
              <li
                key={`${file.name}-${idx}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  fontSize: "13px",
                  padding: "4px 8px",
                  border: "1px solid var(--border-color)",
                  borderRadius: "6px",
                  background: "var(--card-bg)",
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {file.name}
                </span>
                <span style={{ color: "var(--text-muted)", fontSize: "11px", marginLeft: "8px", flexShrink: 0 }}>
                  {(file.size / 1024).toFixed(1)} KB
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFileList((prev) => prev.filter((_, i) => i !== idx));
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--color-danger-text, #991b1b)",
                    fontWeight: 700,
                    fontSize: "14px",
                    marginLeft: "8px",
                    flexShrink: 0,
                    padding: "0 2px",
                  }}
                  aria-label={`Remove ${file.name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <p
          style={{
            marginTop: "4px",
            marginBottom: 0,
            color: "var(--text-color)",
            opacity: 0.78,
            fontSize: "0.92rem",
            lineHeight: 1.5,
          }}
        >
          Supports: {SUPPORTED_UPLOAD_GROUPS.documents.join(", ")}, {SUPPORTED_UPLOAD_GROUPS.data.join(", ")}, {SUPPORTED_UPLOAD_GROUPS.images.join(", ")}, ZIP
        </p>

        {error ? (
          <p
            style={{
              marginTop: "12px",
              marginBottom: 0,
              color: "var(--color-danger-text)",
              fontSize: "0.92rem",
            }}
          >
            {error}
          </p>
        ) : null}

        <div className="evidex-modal-actions">
          <button
            onClick={onClose}
            disabled={uploading}
          >
            Cancel
          </button>

          <button
            className="evidex-modal-primary"
            onClick={handleUpload}
            disabled={uploading || fileList.length === 0}
            style={{
              padding: "8px 16px",
              cursor: uploading || fileList.length === 0 ? "not-allowed" : "pointer",
              opacity: fileList.length === 0 ? 0.5 : 1,
            }}
          >
            {uploading ? "Uploading…" : `Upload & Validate${fileList.length > 0 ? ` (${fileList.length})` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}