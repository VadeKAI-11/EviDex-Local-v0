import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import DeleteConfirmationModal from "../components/DeleteConfirmationModal";
import {
  getRecycleBinCountdownLabel,
  getStoredRequests,
  permanentlyDeleteRequest,
  restoreRequestFromRecycleBin,
} from "../utils/recycleBin";
import { useToast } from "../context/ToastContext";
import { REQUEST_TILE_HEIGHT_PX, REQUEST_TILE_WIDTH_PX } from "../styles/requestTiles";

type RequestItem = {
  id: string;
  requestText: string;
  organization?: string;
  project_name?: string;
  createdAt: string;
  status: string;
  isDeleted?: boolean;
  deletedAt?: string;
};

export default function RequestsHistoryPage() {
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [pendingDeleteFor, setPendingDeleteFor] = useState<string | null>(null);
  const { showToast } = useToast();

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

  const deletedRequests = requests
    .filter((request) => {
      const selectedProject = getSelectedProject();
      return (
        request.isDeleted &&
        selectedProject &&
        (request.organization || request.project_name || "").trim().toLowerCase() === selectedProject.toLowerCase()
      );
    })
    .sort((left, right) => {
      const leftTs = Date.parse(left.deletedAt || left.createdAt || "") || 0;
      const rightTs = Date.parse(right.deletedAt || right.createdAt || "") || 0;
      return rightTs - leftTs;
    });

  function restoreRequest(requestId: string) {
    const updated = restoreRequestFromRecycleBin(requestId) as RequestItem[];
    setRequests(updated);
    showToast("Request restored from recycle bin.", "success");
  }

  async function deleteRequestPermanently(requestId: string) {
    try {
      const updated = (await permanentlyDeleteRequest(requestId)) as RequestItem[];
      setRequests(updated);
      setPendingDeleteFor(null);
      showToast("Request permanently deleted.", "success");
    } catch {
      showToast("Failed to permanently delete request. Please try again.", "error");
    }
  }

  return (
    <div
      style={{
        width: "100%",
        maxWidth: "980px",
        minWidth: 0,
        boxSizing: "border-box",
        overflowX: "hidden",
        height: "calc(100vh - 64px)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <h1 style={{ marginTop: 0, marginBottom: "10px" }}>Recycle Bin</h1>

      <section
        style={{
          width: "100%",
          maxWidth: "100%",
          minWidth: 0,
          boxSizing: "border-box",
          border: "1px solid var(--border-color)",
          borderRadius: "12px",
          padding: "16px",
          background: "var(--card-bg)",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <h2 style={{ marginTop: 0, marginBottom: "8px", fontSize: "18px" }}>Recycle Bin</h2>
        <p style={{ marginTop: 0, marginBottom: "10px", color: "var(--text-muted)", fontSize: "13px" }}>
          Deleted requests stay here for 90 days. After that, EviDex automatically purges the request and its related app content.
        </p>

        {deletedRequests.length === 0 ? (
          <p style={{ marginBottom: 0, color: "var(--text-muted)" }}>Recycle bin is empty.</p>
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gridTemplateColumns: `repeat(auto-fill, minmax(${REQUEST_TILE_WIDTH_PX}px, ${REQUEST_TILE_WIDTH_PX}px))`,
              gridAutoRows: `${REQUEST_TILE_HEIGHT_PX}px`,
              justifyContent: "start",
              alignContent: "start",
              gap: "10px",
              overflowY: "auto",
              minHeight: 0,
              paddingRight: "4px",
            }}
          >
            {deletedRequests.map((request) => (
              <li
                key={request.id}
                style={{
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  padding: "10px",
                  background: "var(--card-bg-subtle)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  minWidth: 0,
                  width: `${REQUEST_TILE_WIDTH_PX}px`,
                  height: `${REQUEST_TILE_HEIGHT_PX}px`,
                  boxSizing: "border-box",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "6px",
                    alignItems: "flex-start",
                    minWidth: 0,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      title={request.requestText}
                      style={{
                        fontWeight: 600,
                        fontSize: "12px",
                        color: "var(--text-color)",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                        cursor: "help",
                        lineHeight: 1.35,
                      }}
                    >
                      {request.requestText || request.id}
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "3px" }}>
                      {request.id}
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-end",
                    gap: "6px",
                    flexWrap: "wrap",
                    marginTop: "auto",
                  }}
                >
                  <div style={{ color: "var(--color-warning-text)", fontSize: "11px", flexShrink: 0 }}>
                    {getRecycleBinCountdownLabel(request.deletedAt)}
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => restoreRequest(request.id)}
                      style={actionButton}
                      title="Restore this request"
                    >
                      ↺ Restore
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDeleteFor(request.id)}
                      style={{
                        ...actionButton,
                        color: "var(--color-danger-text)",
                        borderColor: "var(--color-danger-border)",
                        background: "var(--color-danger-bg)",
                        padding: 6,
                        borderRadius: "50%",
                        width: 32,
                        height: 32,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                      title="Permanently delete this request"
                    >
                      <FontAwesomeIcon icon={faTrash} />
                    </button>
                  </div>
                </div>

                {pendingDeleteFor === request.id && (
                  <DeleteConfirmationModal
                    onCancel={() => setPendingDeleteFor(null)}
                    onConfirm={() => deleteRequestPermanently(request.id)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const actionButton: React.CSSProperties = {
  border: "1px solid var(--border-color)",
  background: "transparent",
  borderRadius: "6px",
  padding: "4px 8px",
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--text-color)",
  cursor: "pointer",
};