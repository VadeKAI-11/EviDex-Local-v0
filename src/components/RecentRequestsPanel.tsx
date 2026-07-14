import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faUpload } from "@fortawesome/free-solid-svg-icons";
import EvidenceUploadModal from "./EvidenceUploadModal";
import DeleteConfirmationModal from "./DeleteConfirmationModal";
import ArchiveConfirmationModal from "./ArchiveConfirmationModal";
import RequestActions from "./RequestActions";
import { iconSize } from "../styles/tokens";
import {
  getStoredRequests,
  moveRequestToArchive,
  moveRequestToRecycleBin,
} from "../utils/recycleBin";

type UploadItem = {
  id: string;
  name: string;
  uploadedAt: string;
};

type RequestItem = {
  id: string;
  requestText: string;
  createdAt: string;
  createdBy?: string;
  organization?: string;
  project_name?: string;
  isDeleted?: boolean;
  isArchived?: boolean;
  uploads?: UploadItem[];
};

export default function RecentRequestsPanel() {

  const navigate = useNavigate();
  const [recent, setRecent] = useState<RequestItem[]>([]);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const [confirmArchiveFor, setConfirmArchiveFor] = useState<string | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<string | null>(null);

  // Get the selected project from sessionStorage
  function getSelectedProject() {
    return (sessionStorage.getItem("evidex-organization") || "").trim();
  }

  useEffect(() => {
    function loadRequests() {
      const stored = getStoredRequests() as RequestItem[];
      const selectedProject = getSelectedProject();
      setRecent(
        stored.filter(
          (r) =>
            !r.isDeleted &&
            !r.isArchived &&
            selectedProject &&
            (r.organization || r.project_name || "").trim().toLowerCase() === selectedProject.toLowerCase()
        )
      );
    }

    loadRequests();
    window.addEventListener("storage", loadRequests);

    return () => {
      window.removeEventListener("storage", loadRequests);
    };
  }, []);

  function archiveRequest(id: string) {
    const updated = moveRequestToArchive(id, sessionStorage.getItem("userEmail") || "") as RequestItem[];
    setRecent(updated.filter((r) => !r.isDeleted && !r.isArchived));
  }

  function softDelete(id: string) {
    const updated = moveRequestToRecycleBin(id) as RequestItem[];

    setRecent(updated.filter((r) => !r.isDeleted && !r.isArchived));
  }

  function getPreview(text: string) {
    const firstLine = text.split("\n")[0].trim();
    return firstLine.length > 50
      ? firstLine.slice(0, 50) + "…"
      : firstLine;
  }

  return (
    <>
      <div
        style={{
          border: "2px solid var(--evidex-green)",
          borderRadius: "12px",
          padding: "16px",
          background: "var(--card-bg)",
        }}
      >
        <h2 style={{ fontSize: "16px", marginBottom: "12px" }}>
          Recent Requests
        </h2>

        {recent.length === 0 ? (
          <p style={{ color: "var(--text-muted)", margin: 0 }}>No recent requests</p>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              maxHeight: recent.length > 3 ? "262px" : undefined,
              overflowY: recent.length > 3 ? "auto" : undefined,
              paddingRight: recent.length > 3 ? "4px" : 0,
            }}
          >
            {recent.map((req) => {
              return (
                <li
                  key={req.id}
                  style={{
                    padding: "12px",
                    borderRadius: "8px",
                    border: "1px solid var(--border-color)",
                    background: "var(--card-bg-subtle)",
                    cursor: "pointer",
                    marginBottom: "10px",
                  }}
                  onClick={() => navigate(`/interaction/${req.id}`)}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: "14px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {getPreview(req.requestText)}
                      </div>
                      <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "3px" }}>
                        {req.id}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: "6px", flexShrink: 0, alignItems: "center" }}>
                      <button
                        title="Upload evidence"
                        onClick={(e) => { e.stopPropagation(); setUploadFor(req.id); }}
                        aria-label="Upload evidence"
                        style={iconButton}
                      >
                        <FontAwesomeIcon icon={faUpload} size={iconSize.base} />
                      </button>

                      <RequestActions
                        onArchive={() => setConfirmArchiveFor(req.id)}
                        onDelete={() => setConfirmDeleteFor(req.id)}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {uploadFor && (
        <EvidenceUploadModal
          requestId={uploadFor}
          onClose={() => {
            console.log("EvidenceUploadModal onClose called, setting uploadFor to null");
            setUploadFor(null);
          }}
        />
      )}

      {confirmDeleteFor && (
        <DeleteConfirmationModal
          onCancel={() => setConfirmDeleteFor(null)}
          onConfirm={() => { softDelete(confirmDeleteFor); setConfirmDeleteFor(null); }}
        />
      )}

      {confirmArchiveFor && (
        <ArchiveConfirmationModal
          onCancel={() => setConfirmArchiveFor(null)}
          onConfirm={() => {
            archiveRequest(confirmArchiveFor);
            setConfirmArchiveFor(null);
          }}
        />
      )}
    </>
  );
}

const iconButton: React.CSSProperties = {
  padding: "6px 8px",
  borderRadius: "6px",
  border: "1px solid var(--border-color)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "opacity 0.15s ease",
};