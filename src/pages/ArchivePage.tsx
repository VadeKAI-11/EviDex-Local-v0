import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { getStoredRequests, unarchiveRequest } from "../utils/recycleBin";
import { useToast } from "../context/ToastContext";
import { formatDateTimeDMY } from "../utils/dateTime";
import { REQUEST_TILE_HEIGHT_PX, REQUEST_TILE_WIDTH_PX } from "../styles/requestTiles";

type RequestItem = {
  id: string;
  requestText: string;
  organization?: string;
  project_name?: string;
  createdAt: string;
  createdBy?: string;
  status?: string;
  approval_status?: string;
  isDeleted?: boolean;
  isArchived?: boolean;
  archivedAt?: string;
  archivedBy?: string;
};

function formatWcastDate(value?: string): string {
  if (!value) {
    return "N/A";
  }

  return formatDateTimeDMY(value);
}

function getPreview(text: string): string {
  const firstLine = text.split("\n")[0].trim();
  return firstLine.length > 50 ? `${firstLine.slice(0, 50)}...` : firstLine;
}

export default function ArchivePage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [requests, setRequests] = useState<RequestItem[]>([]);

  useEffect(() => {
    function loadRequests() {
      setRequests(getStoredRequests() as RequestItem[]);
    }

    loadRequests();
    window.addEventListener("storage", loadRequests);

    return () => {
      window.removeEventListener("storage", loadRequests);
    };
  }, []);

  // Get the selected project from sessionStorage
  function getSelectedProject() {
    return (sessionStorage.getItem("evidex-organization") || "").trim();
  }

  const archivedRequests = useMemo(() => {
    const selectedProject = getSelectedProject();
    return requests
      .filter(
        (request) =>
          request.isArchived &&
          !request.isDeleted &&
          selectedProject &&
          (request.organization || request.project_name || "").trim().toLowerCase() === selectedProject.toLowerCase()
      )
      .sort((left, right) => {
        const leftTs = Date.parse(left.archivedAt || left.createdAt || "") || 0;
        const rightTs = Date.parse(right.archivedAt || right.createdAt || "") || 0;
        return rightTs - leftTs;
      });
  }, [requests]);

  function handleUnarchive(requestId: string) {
    const updated = unarchiveRequest(requestId) as RequestItem[];
    setRequests(updated);
    showToast("Request unarchived successfully.", "success");
  }

  return (
    <div
      style={{
        maxWidth: "980px",
        height: "calc(100vh - 64px)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <h1 style={{ marginTop: 0, marginBottom: "8px" }}>Archive</h1>
      <p style={{ color: "var(--text-muted)", marginTop: 0, marginBottom: "12px", lineHeight: 1.5 }}>
        Archived requests are retained here for audit logging and review (7 year Retention Policy). Content is read-only.
      </p>

      <section
        style={{
          border: "1px solid var(--border-color)",
          borderRadius: "12px",
          padding: "16px",
          background: "var(--card-bg)",
          display: "grid",
          gap: "10px",
          flex: 1,
          minHeight: 0,
        }}
      >
        {archivedRequests.length === 0 ? (
          <p style={{ margin: 0, color: "var(--text-muted)" }}>No archived requests found.</p>
        ) : (
          <div
            style={{
              overflowY: "auto",
              minHeight: 0,
              display: "grid",
              gridTemplateColumns: `repeat(auto-fill, minmax(${REQUEST_TILE_WIDTH_PX}px, ${REQUEST_TILE_WIDTH_PX}px))`,
              gridAutoRows: `${REQUEST_TILE_HEIGHT_PX}px`,
              justifyContent: "start",
              alignContent: "start",
              gap: "10px",
              paddingRight: "4px",
            }}
          >
            {archivedRequests.map((request) => (
              <article
                key={request.id}
                onClick={() => navigate(`/audit/${request.id}?mode=readonly&tab=status`)}
                style={{
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  background: "var(--card-bg-subtle)",
                  padding: "12px",
                  width: `${REQUEST_TILE_WIDTH_PX}px`,
                  height: `${REQUEST_TILE_HEIGHT_PX}px`,
                  boxSizing: "border-box",
                  position: "relative",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "flex-start",
                  gap: "8px",
                  paddingBottom: "32px",
                  overflow: "hidden",
                  cursor: "pointer",
                }}
                title={`Open workflow status for ${request.id} in read-only mode`}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: "14px",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {getPreview(request.requestText || "No request description available.")}
                  </div>
                  <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "3px" }}>
                    {request.id} | Archived: {formatWcastDate(request.archivedAt)}
                  </div>
                </div>

                <div style={{ position: "absolute", right: "10px", bottom: "10px", display: "flex", alignItems: "center" }}>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleUnarchive(request.id);
                    }}
                    style={unarchiveButton}
                    title="Unarchive request"
                  >
                    Unarchive
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const unarchiveButton: CSSProperties = {
  border: "1px solid var(--evidex-green)",
  background: "transparent",
  color: "var(--evidex-green)",
  borderRadius: "6px",
  padding: "3px 6px",
  fontSize: "10px",
  lineHeight: 1,
  fontWeight: 600,
  whiteSpace: "nowrap",
  cursor: "pointer",
};
