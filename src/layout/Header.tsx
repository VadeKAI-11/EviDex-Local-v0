import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faArrowRightFromBracket,
  faBoxArchive,
  faDiagramProject,
  faFileCirclePlus,
  faFolderOpen,
  faGaugeHigh,
  faShieldHalved,
  faTrashCan,
  faMoon,
  faSun,
  faRotate,
  faAnglesLeft,
  faAnglesRight,
  faClipboardList,
} from "@fortawesome/free-solid-svg-icons";
import { iconSize } from "../styles/tokens";
import { forceResetAppData } from "../utils/startupReset";
import { recordAuditEvent } from "../utils/auditLog";

type Props = {
  theme: "light" | "dark";
  setTheme: (t: "light" | "dark") => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
};

export default function Header({
  theme,
  setTheme,
  isCollapsed,
  onToggleCollapse,
}: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const organization =
    sessionStorage.getItem("evidex-organization");

  return (
    <aside
      style={{
        width: isCollapsed ? "60px" : "210px",
        height: "100vh",
        borderRight: "1px solid var(--border-color)",
        padding: isCollapsed ? "20px 8px" : "20px 12px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: "20px",
        background: "var(--card-bg)",
        flexShrink: 0,
        overflowY: "visible",
        overflowX: "visible",
        position: "relative",
        transition: "width 0.2s ease",
      }}
    >
      <div
        style={{
          display: "grid",
          gap: "10px",
          justifyItems: "stretch",
        }}
      >
        {!isCollapsed ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                <div
                  aria-label="EviDex"
                  title="EviDex"
                  style={{
                    width: "34px",
                    height: "34px",
                    borderRadius: "8px",
                    border: "1px solid var(--evidex-green)",
                    background: "var(--evidex-green-tint)",
                    color: "var(--evidex-green)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <FontAwesomeIcon icon={faShieldHalved} size="sm" />
                </div>
                <strong style={{ fontSize: "20px", letterSpacing: "-0.3px", display: "block" }}>
                  EviDex
                </strong>
              </div>
            </div>

            {organization && (
              <p style={{ margin: "0", color: "var(--text-muted)", fontSize: "11px", lineHeight: 1.4 }}>
                {organization}
              </p>
            )}
          </>
        ) : (
          <div style={{ display: "grid", justifyItems: "center", gap: "8px" }}>
            <div
              aria-label="EviDex"
              title="EviDex"
              style={{
                width: "34px",
                height: "34px",
                borderRadius: "8px",
                border: "1px solid var(--evidex-green)",
                background: "var(--evidex-green-tint)",
                color: "var(--evidex-green)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <FontAwesomeIcon icon={faShieldHalved} size="sm" />
            </div>
          </div>
        )}
      </div>

      <button
        onClick={onToggleCollapse}
        style={{
          position: "absolute",
          top: "19px",
          right: isCollapsed ? "-12px" : "0px",
          width: "22px",
          height: "36px",
          border: "1px solid transparent",
          borderLeft: "1px solid transparent",
          borderTopRightRadius: "10px",
          borderBottomRightRadius: "10px",
          borderTopLeftRadius: "0",
          borderBottomLeftRadius: "0",
          background: "transparent",
          color: "var(--text-muted)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0",
          fontSize: "12px",
          lineHeight: 1,
          fontWeight: 600,
          cursor: "pointer",
          boxShadow: "0 1px 4px rgba(0, 0, 0, 0.12)",
          zIndex: 20,
        }}
        title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <FontAwesomeIcon icon={isCollapsed ? faAnglesRight : faAnglesLeft} size="sm" />
      </button>

      <nav style={{ display: "grid", gap: "4px", justifyItems: isCollapsed ? "center" : "stretch" }}>
        <NavItem to="/dashboard" icon={faGaugeHigh} label="Dashboard" isCollapsed={isCollapsed} currentPath={location.pathname} />
        <NavItem to="/projects" icon={faFolderOpen} label="Projects" isCollapsed={isCollapsed} currentPath={location.pathname} />
        <NavItem to="/new-request" icon={faFileCirclePlus} label="Requests" isCollapsed={isCollapsed} currentPath={location.pathname} />
        <NavItem
          to="/workflow"
          icon={faDiagramProject}
          label="Workflow"
          isCollapsed={isCollapsed}
          currentPath={location.pathname}
          activePathPrefixes={["/audit/", "/workflow", "/interaction"]}
        />
        <NavItem to="/archive" icon={faBoxArchive} label="Archive" isCollapsed={isCollapsed} currentPath={location.pathname} />
        <NavItem to="/requests-history" icon={faTrashCan} label="Recycle Bin" isCollapsed={isCollapsed} currentPath={location.pathname} />
      </nav>

      <div style={{ marginTop: "auto", display: "grid", gap: "10px" }}>
        <NavItem
          to="/audit-log"
          icon={faClipboardList}
          label="Audit Log"
          isCollapsed={isCollapsed}
          currentPath={location.pathname}
        />

        {localStorage.getItem("evidex-debug-mode") === "true" && (
          <button
            onClick={() => {
              if (window.confirm("This will clear all local request history and cached data. Continue?")) {
                recordAuditEvent({
                  eventName: "admin.reset.local-state",
                  action: "Reset local app data",
                  category: "administration",
                  module: "settings",
                  feature: "debug-reset",
                  severity: "critical",
                  source: "ui",
                });
                forceResetAppData();
              }
            }}
            style={{
              ...actionButton,
              textAlign: isCollapsed ? "center" : "left",
              display: "flex",
              alignItems: "center",
              justifyContent: isCollapsed ? "center" : "flex-start",
              gap: "8px",
              color: "#ff4d4f", // Subtle red for destructive action
              borderColor: "rgba(255, 77, 79, 0.2)",
            }}
            title="Reset local app state"
          >
            <FontAwesomeIcon icon={faRotate} size={iconSize.base} />
            {!isCollapsed && <span>Reset App Data</span>}
          </button>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            marginTop: "2px",
          }}
        >
          <button
            onClick={() => {
              const nextTheme = theme === "dark" ? "light" : "dark";
              setTheme(nextTheme);
              recordAuditEvent({
                eventName: "config.theme.updated",
                action: `Theme switched to ${nextTheme}`,
                category: "configuration",
                module: "settings",
                feature: "theme-toggle",
                source: "ui",
                metadata: {
                  before: theme,
                  after: nextTheme,
                },
              });
            }}
            style={{
              ...actionButton,
              border: "none",
              padding: isCollapsed ? "7px" : "7px 10px",
              fontSize: "14px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
            }}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            <FontAwesomeIcon icon={theme === "dark" ? faSun : faMoon} size={iconSize.base} />
            {!isCollapsed && <span>{theme === "dark" ? "Light" : "Dark"}</span>}
          </button>

          <button
            onClick={() => {
              const currentEmail = sessionStorage.getItem("userEmail") || "unknown@unknown";
              const currentRole = sessionStorage.getItem("userRole") || "unknown";
              recordAuditEvent({
                eventName: "auth.logout",
                action: "User logged out",
                category: "authentication",
                module: "auth",
                feature: "logout",
                source: "ui",
                actor: {
                  email: currentEmail,
                  role: currentRole,
                  userId: currentEmail.split("@")[0] || currentEmail,
                },
              });
              sessionStorage.clear();
              navigate("/login");
            }}
            style={{
              ...actionButton,
              border: "none",
              padding: isCollapsed ? "7px" : "7px 10px",
              fontSize: "14px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
            }}
            title="Sign out"
          >
            <FontAwesomeIcon icon={faArrowRightFromBracket} size={iconSize.base} />
            {!isCollapsed && <span>Sign Out</span>}
          </button>
        </div>
      </div>
    </aside>
  );
}

function NavItem({
  to,
  icon,
  label,
  isCollapsed,
  currentPath,
  activePathPrefixes = [],
}: {
  to: string;
  icon: IconDefinition;
  label: string;
  isCollapsed: boolean;
  currentPath: string;
  activePathPrefixes?: string[];
}) {
  const isPathPrefixActive = activePathPrefixes.some((prefix) => currentPath.startsWith(prefix));

  return (
    <NavLink
      to={to}
      title={label}
      style={({ isActive }) => ({
        textDecoration: "none",
        fontWeight: 600,
        fontSize: "14px",
        display: "flex",
        alignItems: "center",
        justifyContent: isCollapsed ? "center" : "flex-start",
        gap: isCollapsed ? "0" : "10px",
        padding: "9px 12px",
        borderRadius: "8px",
        border: (isActive || isPathPrefixActive)
          ? "1px solid var(--evidex-green)"
          : "1px solid transparent",
        background: (isActive || isPathPrefixActive) ? "var(--evidex-green-tint)" : "transparent",
        color: "inherit",
        transition: "background 0.15s ease, border-color 0.15s ease",
      })}
    >
      <span aria-hidden="true">
        <FontAwesomeIcon icon={icon} size="1x" />
      </span>
      {!isCollapsed && <span>{label}</span>}
    </NavLink>
  );
}

const actionButton: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: "8px",
  border: "1px solid var(--border-color)",
  background: "transparent",
  color: "inherit",
  fontWeight: 600,
  fontSize: "14px",
  cursor: "pointer",
  textAlign: "left",
  transition: "opacity 0.2s ease",
};