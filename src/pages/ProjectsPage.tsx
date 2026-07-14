import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { cardSubtleStyle } from "../styles/tokens";
import { REQUEST_TILE_HEIGHT_PX, REQUEST_TILE_WIDTH_PX } from "../styles/requestTiles";
import { moveRequestToArchive } from "../utils/recycleBin";
import { useToast } from "../context/ToastContext";
import RequestActions from "../components/RequestActions";
import ArchiveConfirmationModal from "../components/ArchiveConfirmationModal";
import { formatDateDMY } from "../utils/dateTime";

const DEFAULT_PROJECTS = [
  "Deloitte – Bank X Internal Audit",
  "Deloitte – Bank Y GITC Review",
];

const CARDS_PER_ROW = 5;

type ProjectRequestFilter = "all" | "approved" | "pending";

type RequestItem = {
  id: string;
  requestText: string;
  organization?: string;
  createdAt: string;
  status?: string;
  approval_status?: string;
  isDeleted?: boolean;
  isArchived?: boolean;
};

function formatRequestStatus(request: RequestItem): string {
  const approvalStatus = String(request.approval_status || "").trim().toLowerCase();

  if (approvalStatus === "approved") {
    return "Approved";
  }

  const status = String(request.status || "").trim();
  return status ? status : "Pending";
}

export default function ProjectsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { showToast } = useToast();
  const [activeProject, setActiveProject] = useState<string | null>(
    null
  );
  const [requestFilter, setRequestFilter] = useState<ProjectRequestFilter>("all");
  const [confirmArchiveFor, setConfirmArchiveFor] = useState<string | null>(null);
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [carouselOffset, setCarouselOffset] = useState(0);

  useEffect(() => {
    function loadProjectContext() {
      const queryProject = (searchParams.get("project") || "").trim();
      const storedProject =
        sessionStorage.getItem("evidex-organization");
      const lastProject =
        localStorage.getItem("evidex-last-project");
      const storedRequests: RequestItem[] = JSON.parse(
        localStorage.getItem("evidex-requests") || "[]"
      );

      const normalizedStoredProject = queryProject || (storedProject || "").trim();
      let nextActiveProject =
        normalizedStoredProject && normalizedStoredProject.toLowerCase() !== "unassigned"
          ? normalizedStoredProject
          : null;

      // Auto-select last project if no project is currently selected
      if (!nextActiveProject && lastProject) {
        nextActiveProject = lastProject.trim();
        sessionStorage.setItem("evidex-organization", nextActiveProject);
      }

      setActiveProject(nextActiveProject);
      sessionStorage.setItem("evidex-organization", nextActiveProject || "");
      if (nextActiveProject) {
        localStorage.setItem("evidex-last-project", nextActiveProject);
      }
      setRequests(storedRequests.filter((request) => !request.isDeleted && !request.isArchived));

      const queryFilter = (searchParams.get("requestFilter") || "all").trim().toLowerCase();
      setRequestFilter(
        queryFilter === "approved" || queryFilter === "pending"
          ? (queryFilter as ProjectRequestFilter)
          : "all"
      );
    }

    loadProjectContext();
    window.addEventListener("storage", loadProjectContext);

    return () =>
      window.removeEventListener("storage", loadProjectContext);
  }, [searchParams]);

  const projects = useMemo(() => {
    const uniqueProjects = new Set(DEFAULT_PROJECTS);

    requests.forEach((request) => {
      if (request.organization?.trim()) {
        uniqueProjects.add(request.organization.trim());
      }
    });

    return Array.from(uniqueProjects);
  }, [requests]);

  const projectRequests = useMemo(() => {
    if (!activeProject) {
      return [];
    }

    return requests
      .filter(
        (request) => (request.organization || "").trim() === activeProject
      )
      .filter((request) => {
        const approvalStatus = String(request.approval_status || "").trim().toLowerCase();
        const isApproved = approvalStatus === "approved";

        if (requestFilter === "approved") {
          return isApproved;
        }

        if (requestFilter === "pending") {
          return !isApproved;
        }

        return true;
      })
      .sort(
        (left, right) =>
          new Date(right.createdAt).getTime() -
          new Date(left.createdAt).getTime()
      );
  }, [activeProject, requests, requestFilter]);

  function selectProject(project: string) {
    sessionStorage.setItem("evidex-organization", project);
    localStorage.setItem("evidex-last-project", project);
    setActiveProject(project);
  }

  const maxOffset = Math.max(0, projects.length - CARDS_PER_ROW);
  const canGoBack = carouselOffset > 0;
  const canGoForward = carouselOffset < maxOffset;

  const handlePrevious = () => {
    setCarouselOffset(Math.max(0, carouselOffset - 1));
  };

  const handleNext = () => {
    setCarouselOffset(Math.min(maxOffset, carouselOffset + 1));
  };

  function handleArchiveRequest(requestId: string) {
    moveRequestToArchive(requestId, sessionStorage.getItem("userEmail") || "");
    showToast("Request archived.", "success");
    navigate("/archive");
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
      <h1 style={{ marginTop: 0, marginBottom: "8px" }}>Projects</h1>

      <p style={{ color: "var(--text-muted)", marginTop: 0, marginBottom: "14px", lineHeight: 1.5 }}>
        Select an audit project to set the working context across EviDex.
      </p>

      <div style={{ position: "relative", marginBottom: "14px" }}>
        {/* Navigation Buttons */}
        {projects.length > CARDS_PER_ROW && (
          <>
            <button
              onClick={handlePrevious}
              disabled={!canGoBack}
              style={{
                position: "absolute",
                left: "-50px",
                top: "50%",
                transform: "translateY(-50%)",
                background: canGoBack ? "var(--evidex-green)" : "#ccc",
                border: "none",
                borderRadius: "50%",
                width: "40px",
                height: "40px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: canGoBack ? "pointer" : "not-allowed",
                color: canGoBack ? "white" : "gray",
                fontSize: "20px",
                fontWeight: "bold",
                transition: "background 0.2s ease",
              }}
            >
              ‹
            </button>

            <button
              onClick={handleNext}
              disabled={!canGoForward}
              style={{
                position: "absolute",
                right: "-50px",
                top: "50%",
                transform: "translateY(-50%)",
                background: canGoForward ? "var(--evidex-green)" : "#ccc",
                border: "none",
                borderRadius: "50%",
                width: "40px",
                height: "40px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: canGoForward ? "pointer" : "not-allowed",
                color: canGoForward ? "white" : "gray",
                fontSize: "20px",
                fontWeight: "bold",
                transition: "background 0.2s ease",
              }}
            >
              ›
            </button>
          </>
        )}

        {/* Card Grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${CARDS_PER_ROW}, 1fr)`,
            gap: "12px",
            paddingRight: projects.length > CARDS_PER_ROW ? "50px" : "0",
            paddingLeft: projects.length > CARDS_PER_ROW ? "50px" : "0",
          }}
        >
          {projects.slice(carouselOffset, carouselOffset + CARDS_PER_ROW).map((project) => (
            <button
              key={project}
              onClick={() => selectProject(project)}
              style={{
                padding: "14px",
                border: `2px solid ${activeProject === project ? "var(--evidex-green)" : "var(--border-color)"}`,
                borderRadius: "10px",
                background: activeProject === project ? "var(--evidex-green-tint-strong)" : "transparent",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                alignItems: "flex-start",
                minHeight: "90px",
                transition: "all 0.2s ease",
                color: "inherit",
                textAlign: "left",
              }}
              onMouseEnter={(e) => {
                if (activeProject !== project) {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--evidex-green)";
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(153, 204, 0, 0.05)";
                }
              }}
              onMouseLeave={(e) => {
                if (activeProject !== project) {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border-color)";
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }
              }}
            >
              <span style={{ fontWeight: 600, fontSize: "13px", lineHeight: 1.3 }}>
                {project}
              </span>

              {activeProject === project && (
                <span style={{ fontSize: "11px", color: "var(--evidex-green)", fontWeight: 500 }}>
                  ✓ Active
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <section
        style={{
          ...cardSubtleStyle,
          marginTop: "6px",
          padding: "16px",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <h2 style={{ fontSize: "20px", margin: 0 }}>
          {activeProject ? `${activeProject} Requests` : "Project Requests"}
        </h2>

        <p style={{ color: "var(--text-muted)", marginTop: "8px", marginBottom: "12px" }}>
          {activeProject
            ? requestFilter === "approved"
              ? `Showing only approved evidence requests for ${activeProject}.`
              : requestFilter === "pending"
              ? `Showing only pending evidence requests for ${activeProject}.`
              : `Showing only the evidence requests created for ${activeProject}.`
            : "Select a project to view the requests created for that project only."}
        </p>

        {!activeProject ? (
          <p style={{ margin: 0, color: "var(--text-muted)" }}>No project selected.</p>
        ) : projectRequests.length === 0 ? (
          <p style={{ margin: 0, color: "var(--text-muted)" }}>
            {requestFilter === "approved"
              ? "No approved requests found for this project."
              : requestFilter === "pending"
              ? "No pending requests found for this project."
              : "No requests found for this project."}
          </p>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(auto-fill, minmax(${REQUEST_TILE_WIDTH_PX}px, ${REQUEST_TILE_WIDTH_PX}px))`,
              gridAutoRows: `${REQUEST_TILE_HEIGHT_PX}px`,
              gap: "10px",
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              paddingRight: "6px",
              alignContent: "start",
            }}
          >
            {projectRequests.map((request) => (
              <article
                key={request.id}
                onClick={() => navigate(`/interaction/${request.id}`)}
                style={{
                  textAlign: "left",
                  padding: "12px 14px",
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  background: "transparent",
                  color: "inherit",
                  cursor: "pointer",
                  transition: "border-color 0.15s ease",
                  fontSize: "13px",
                  width: `${REQUEST_TILE_WIDTH_PX}px`,
                  height: `${REQUEST_TILE_HEIGHT_PX}px`,
                  boxSizing: "border-box",
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                }}
                title={`Open ${request.id}`}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start" }}>
                  <div>
                    <strong style={{ fontSize: "14px" }}>{request.id}</strong>
                    <div style={{ color: "var(--text-muted)", fontSize: "12px", marginTop: "2px" }}>
                      {formatDateDMY(request.createdAt)}
                    </div>
                  </div>

                  <RequestActions onArchive={() => setConfirmArchiveFor(request.id)} />
                </div>

                <p
                  style={{
                    margin: "6px 0 6px 0",
                    lineHeight: 1.45,
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                    flex: 1,
                  }}
                >
                  {request.requestText}
                </p>

                <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>
                  Status: {formatRequestStatus(request)}
                </span>
              </article>
            ))}
          </div>
        )}
      </section>

      {confirmArchiveFor && (
        <ArchiveConfirmationModal
          onCancel={() => setConfirmArchiveFor(null)}
          onConfirm={() => {
            handleArchiveRequest(confirmArchiveFor);
            setConfirmArchiveFor(null);
          }}
        />
      )}
    </div>
  );
}