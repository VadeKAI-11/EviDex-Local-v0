import { createBrowserRouter, Navigate, useParams } from "react-router-dom";
import { getStoredRequests } from "../utils/recycleBin";
import LoginPage from "../pages/LoginPage";
import DashboardPage from "../pages/DashboardPage";
import ProjectsPage from "../pages/ProjectsPage";
import NewEvidenceRequestPage from "../pages/NewEvidenceRequestPage";
import EvidenceDetailPage from "../pages/EvidenceDetailPage";
import AuditWorkflowPage from "../pages/AuditWorkflowPage";
import ArchivePage from "../pages/ArchivePage";
import RequestsHistoryPage from "../pages/RequestsHistoryPage";
import AuditLogPage from "../pages/AuditLogPage";
import AppLayout from "../layout/AppLayout";
import RecentRequestsPanel from "../components/RecentRequestsPanel";

function WorkflowRouteRedirect() {
  const { id } = useParams<{ id?: string }>();

  if (id) {
    return <Navigate to={`/audit/${id}?tab=status`} replace />;
  }

  const currentRequestId = sessionStorage.getItem("evidex-current-request-id");
  if (currentRequestId) {
    return <Navigate to={`/audit/${currentRequestId}?tab=status`} replace />;
  }

  const latestRequest = getStoredRequests()
    .filter((request) => !request.isDeleted && !request.isArchived)
    .sort((a, b) => {
      const aTs = new Date(String(a.updatedAt || a.createdAt || 0)).getTime();
      const bTs = new Date(String(b.updatedAt || b.createdAt || 0)).getTime();
      return bTs - aTs;
    })[0];

  if (latestRequest?.id) {
    return <Navigate to={`/audit/${latestRequest.id}?tab=status`} replace />;
  }

  return <Navigate to="/new-request" replace />;
}

function InteractionRouteRedirect() {
  const { id } = useParams<{ id?: string }>();

  if (id) {
    return <Navigate to={`/audit/${id}?tab=workflow-interaction`} replace />;
  }

  const currentRequestId = sessionStorage.getItem("evidex-current-request-id");
  if (currentRequestId) {
    return <Navigate to={`/audit/${currentRequestId}?tab=workflow-interaction`} replace />;
  }

  const latestRequest = getStoredRequests()
    .filter((request) => !request.isDeleted && !request.isArchived)
    .sort((a, b) => {
      const aTs = new Date(String(a.updatedAt || a.createdAt || 0)).getTime();
      const bTs = new Date(String(b.updatedAt || b.createdAt || 0)).getTime();
      return bTs - aTs;
    })[0];

  if (latestRequest?.id) {
    return <Navigate to={`/audit/${latestRequest.id}?tab=workflow-interaction`} replace />;
  }

  return <Navigate to="/new-request" replace />;
}

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },

  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="dashboard" replace /> },
      { path: "dashboard", element: <DashboardPage /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "new-request", element: <NewEvidenceRequestPage /> },
      { path: "workflow", element: <WorkflowRouteRedirect /> },
      { path: "workflow/:id", element: <WorkflowRouteRedirect /> },
      { path: "interaction", element: <InteractionRouteRedirect /> },
      { path: "interaction/:id", element: <InteractionRouteRedirect /> },
      { path: "archive", element: <ArchivePage /> },
      { path: "requests-history", element: <RequestsHistoryPage /> },
      { path: "audit-log", element: <AuditLogPage /> },
      { path: "recent-requests", element: <RecentRequestsPanel /> },
      { path: "evidence/:id", element: <EvidenceDetailPage /> },
      { path: "audit/:id", element: <AuditWorkflowPage /> },
    ],
  },
]);