import { useEffect, useState } from "react";
import { Outlet, Navigate } from "react-router-dom";
import Header from "./Header";
import {
  getStoredRequests,
  purgeExpiredRecycleBinItems,
  syncStoredRequestsFromBackend,
} from "../utils/recycleBin";

export type ThemeMode = "light" | "dark";
const THEME_KEY = "evidex-theme";

export default function AppLayout() {
  const isAuthenticated = sessionStorage.getItem("isAuthenticated");

  const [theme, setTheme] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark"
      ? stored
      : "dark";
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.setAttribute(
      "data-theme",
      theme
    );
  }, [theme]);

  useEffect(() => {
    async function hydrateRequests() {
      try {
        await syncStoredRequestsFromBackend();
      } catch {
        // Backend may be offline during initial app load; keep local cache.
      }

      try {
        purgeExpiredRecycleBinItems();

        const storedRequests = getStoredRequests() as Array<{ id?: string; organization?: string }>;
        const normalized = storedRequests.map((request) => {
          const rawOrganization = (request.organization || "").trim();
          const inferred = /^([A-Za-z0-9]+)-REQ-\d{3}$/i.exec(String(request.id || "").trim());
          return {
            ...request,
            organization:
              rawOrganization && rawOrganization.toLowerCase() !== "unassigned"
                ? rawOrganization
                : inferred
                  ? inferred[1].toUpperCase()
                  : "default",
          };
        });

        localStorage.setItem("evidex-requests", JSON.stringify(normalized));

        const selectedProject = (sessionStorage.getItem("evidex-organization") || "").trim();
        if (!selectedProject || selectedProject.toLowerCase() === "unassigned") {
          sessionStorage.removeItem("evidex-organization");
        } else {
          // Persist the currently selected project as the last used
          localStorage.setItem("evidex-last-project", selectedProject);
        }

        // Auto-restore last project if no project is currently selected
        if (!selectedProject) {
          const lastProject = localStorage.getItem("evidex-last-project");
          if (lastProject && lastProject.toLowerCase() !== "unassigned") {
            sessionStorage.setItem("evidex-organization", lastProject);
          }
        }
      } catch {
        // Ignore malformed localStorage payloads and continue rendering.
      }
    }

    void hydrateRequests();
  }, []);

  useEffect(() => {
    function applyResponsiveSidebarMode() {
      setIsSidebarCollapsed(window.innerWidth < 1024);
    }

    applyResponsiveSidebarMode();
    window.addEventListener("resize", applyResponsiveSidebarMode);

    return () => {
      window.removeEventListener("resize", applyResponsiveSidebarMode);
    };
  }, []);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="app-shell" style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <Header
        theme={theme}
        setTheme={setTheme}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={() =>
          setIsSidebarCollapsed((prev) => !prev)
        }
      />
      <main className="app-main" style={{ padding: "32px", flex: 1, minWidth: 0, overflowY: "auto", height: "100vh" }}>
        <Outlet />
      </main>
    </div>
  );
}
