/**
 * API Type Definitions - TypeScript Types for Backend Communication
 * 
 * Defines all TypeScript types, interfaces, and enums used for API requests
 * and responses. Ensures type safety across frontend-backend integration.
 * 
 * Key Responsibilities:
 * - Define workflow stage enums
 * - Define validation and approval status types
 * - Define evidence item structures
 * - Define step log structures
 * - Define request detail structures
 * - Define validation result structures
 * - Ensure type consistency across components
 * 
 * Enum Pattern:
 * - Uses const objects with 'as const' assertion
 * - Provides both runtime values and type definitions
 * - TypeScript 3.4+ compatible
 * 
 * Type Categories:
 * 1. **Workflow Types**: Stages, status, state
 * 2. **Evidence Types**: Items, links, validation
 * 3. **Step Log Types**: Execution details, inputs, outputs
 * 4. **Request Types**: Full request details, summaries
 * 5. **Validation Types**: Sufficiency, confidence, recommendations
 * 6. **Approval Types**: Status, actions, history
 * 
 * Workflow Stages:
 * - INITIALIZATION: Request setup and access verification
 * - INTERPRETATION: AI parsing of request text
 * - RETRIEVAL: Evidence collection from sources
 * - VALIDATION: Sufficiency assessment
 * - CONCLUSION: Findings generation
 * - APPROVAL: Auditor review
 * - EXPORTED: Final export to systems of record
 * 
 * Validation Statuses:
 * - SUFFICIENT: Evidence meets requirements
 * - INSUFFICIENT: Evidence gaps exist
 * - PARTIAL: Some evidence present, gaps remain
 * 
 * Approval Statuses:
 * - PENDING: Awaiting auditor decision
 * - APPROVED: Approved by auditor
 * - REJECTED: Rejected by auditor
 * - REVISING: Revisions requested
 * 
 * Usage Pattern:
 * ```typescript
 * import { WorkflowStage, type RequestDetails } from './api/types';
 * 
 * const stage: WorkflowStage = WorkflowStage.VALIDATION;
 * const request: RequestDetails = await getRequestDetails(id);
 * ```
 * 
 * Naming Conventions:
 * - Enums: PascalCase (WorkflowStage)
 * - Interfaces: PascalCase (EvidenceItem)
 * - Properties: snake_case (request_id) - matches Python backend
 * 
 * Backend Compatibility:
 * - Matches Pydantic models in backend/models/schemas.py
 * - snake_case matches Python naming conventions
 * - Optional fields use TypeScript ? operator
 * 
 * Used By: All frontend components and API client (backend-api.ts)
 */

// ============================================================================
// WORKFLOW AND STATUS ENUMS
// ============================================================================

/**
 * Type definitions for API responses and requests
 */

/* ============================================================================ */
/* ENUMS */
/* ============================================================================ */

export const WorkflowStage = {
  INITIALIZATION: "initialization",
  INTERPRETATION: "interpretation",
  RETRIEVAL: "retrieval",
  VALIDATION: "validation",
  CONCLUSION: "conclusion",
  APPROVAL: "approval",
  EXPORTED: "exported",
} as const;
export type WorkflowStage =
  (typeof WorkflowStage)[keyof typeof WorkflowStage];

export const ValidationStatus = {
  SUFFICIENT: "sufficient",
  INSUFFICIENT: "insufficient",
  PARTIAL: "partial",
} as const;
export type ValidationStatus =
  (typeof ValidationStatus)[keyof typeof ValidationStatus];

export const ApprovalStatus = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  REVISING: "revising",
} as const;
export type ApprovalStatus =
  (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

/* ============================================================================ */
/* STEP LOGS */
/* ============================================================================ */

export interface StepInput {
  key: string;
  value: any;
}

export interface StepOutput {
  key: string;
  value: any;
}

export interface WorkflowStepLog {
  step_id: string;
  step_name: string;
  agent_name: string;
  request_id: string;
  timestamp: string;
  action_taken: string;
  inputs: StepInput[];
  outputs: StepOutput[];
  status: string;
  confidence_score: number;
  execution_time_ms: number;
  error_message?: string | null;
}

/* ============================================================================ */
/* EVIDENCE */
/* ============================================================================ */

export interface EvidenceItem {
  evidence_id: string;
  filename: string;
  storage_path: string;
  file_type: string;
  file_size_bytes: number;
  source: string;
  relevance_score: number;
  sufficiency_score: number;
  validation_status: ValidationStatus;
  validation_notes: string;
  content_preview?: string;
}

export interface EvidenceLinkItem {
  evidence_id: string;
  filename: string;
  storage_path: string;
  file_type?: string;
  content_preview?: string;
}

export interface ValidationResult {
  total_items: number;
  sufficient_items: number;
  overall_sufficiency: number;
  status: ValidationStatus;
  confidence: number;
  recommendations: string[];
}

/* ============================================================================ */
/* INTERPRETATION */
/* ============================================================================ */

export interface InterpretedTask {
  task_id: string;
  description: string;
  priority: number;
  evidence_types: string[];
  keywords: string[];
}

export interface InterpretationResult {
  tasks: InterpretedTask[];
  confidence: number;
  data_sources: string[];
}

/* ============================================================================ */
/* CONCLUSION */
/* ============================================================================ */

export interface KeyFinding {
  title: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
}

export interface ConclusionResult {
  key_findings: KeyFinding[];
  overall_assessment: string;
  confidence: number;
  coverage: number;
  recommendations: string[];
  report_sections?: {
    engagement_context?: string;
    review_procedures?: string;
    review_highlights?: string;
    conclusion?: string;
  };
}

export interface BedrockSummaryResult {
  enabled?: boolean;
  provider?: string;
  status?: string;
  model_id?: string;
  summary?: string;
  message?: string;
  parsed_summary?: {
    executive_summary?: string;
    key_findings?: unknown[];
    sufficiency_assessment?: string;
    risks?: unknown[];
    recommended_next_steps?: unknown[];
  };
}

/* ============================================================================ */
/* WORKFLOW STATUS */
/* ============================================================================ */

export interface WorkflowStatus {
  request_id: string;
  current_stage: WorkflowStage;
  approval_status: ApprovalStatus;
  evidence_count: number;
  step_count: number;
  average_confidence: number;
  created_at: string;
  updated_at: string;
}

export interface RequestDetails {
  request_id: string;
  auditor_id: string;
  auditor_email: string;
  request_text: string;
  category: string;
  evidence_count?: number;
  current_stage: WorkflowStage;
  approval_status: ApprovalStatus;
  created_at: string;
  updated_at: string;
}

/* ============================================================================ */
/* WORKFLOW INTERACTIONS */
/* ============================================================================ */

export interface WorkflowMessage {
  message_id: string;
  sender_type: "auditor" | "ai_agent";
  sender_id: string;
  message_text: string;
  message_type: string;
  timestamp: string;
  ai_confidence?: number;
}

export interface WorkflowInteraction {
  conversation_id: string;
  request_id: string;
  topic: string;
  messages: WorkflowMessage[];
  created_at: string;
  updated_at: string;
}

/* ============================================================================ */
/* API RESPONSES */
/* ============================================================================ */

export interface ApiResponse<T> {
  success: boolean;
  request_id?: string;
  stage?: WorkflowStage;
  data?: T;
  error?: string;
}

export interface CreateRequestResponse {
  success: boolean;
  request_id: string;
  stage: WorkflowStage;
  created_at: string;
  step_log: WorkflowStepLog;
}

export interface InterpretResponse {
  success: boolean;
  request_id: string;
  stage: WorkflowStage;
  interpretation: InterpretationResult;
  step_log: WorkflowStepLog;
}

export interface RetrieveResponse {
  success: boolean;
  request_id: string;
  stage: WorkflowStage;
  pre_retrieval?: {
    stage: string;
    project_name: string;
    project_dir: string;
    request_dir: string;
    project_already_exists: boolean;
    request_folder_already_exists: boolean;
  };
  evidence_items: number;
  items: EvidenceItem[];
  scan_log?: string[];
  step_log: WorkflowStepLog;
}

export interface ValidateResponse {
  success: boolean;
  request_id: string;
  stage: WorkflowStage;
  validation: ValidationResult;
  step_log: WorkflowStepLog;
}

export interface ConcludeResponse {
  success: boolean;
  request_id: string;
  stage: WorkflowStage;
  conclusion: ConclusionResult;
  bedrock_summary?: BedrockSummaryResult;
  step_log: WorkflowStepLog;
}

export interface UploadEvidenceResponse {
  success: boolean;
  request_id: string;
  stage: WorkflowStage;
  uploaded_count: number;
  rejected_count?: number;
  accepted_files?: string[];
  rejected_files?: string[];
  total_evidence_items: number;
  items: EvidenceItem[];
  collection_logs?: unknown[];
  step_log: WorkflowStepLog;
}

export interface UploadEvidenceWorkflowResult {
  requestId: string;
  stage: WorkflowStage;
  validation: ValidationResult & { sufficient: boolean };
  conclusion: ConclusionResult;
  bedrock_summary?: BedrockSummaryResult;
  logs: unknown[];
  upload: UploadEvidenceResponse;
}

export interface WorkflowOutputsResponse {
  success: boolean;
  request_id: string;
  validation?: ValidationResult;
  conclusion?: ConclusionResult;
  bedrock_summary?: BedrockSummaryResult;
}

export interface ApprovalResponse {
  success: boolean;
  request_id: string;
  stage: WorkflowStage;
  approval_status: ApprovalStatus;
  step_log: WorkflowStepLog;
}

export interface StepLogsResponse {
  success: boolean;
  request_id: string;
  step_count: number;
  steps: WorkflowStepLog[];
}

export interface WorkflowInteractionResponse {
  success: boolean;
  conversation_id: string;
  request_id: string;
}

export interface MessageResponse {
  success: boolean;
  conversation_id: string;
  auditor_message_id: string;
  ai_message_id: string;
  ai_response: string;
  confidence: number;
}

export interface RequestSummaryItem {
  request_id: string;
  request_text: string;
  request_category: string;
  current_stage: string;
  approval_status: string;
  created_at: string;
  updated_at: string;
  auditor_email: string;
  project_name: string;
}

export interface RequestSummariesResponse {
  success: boolean;
  requests: RequestSummaryItem[];
}

export interface WorkflowInteractionHealthResponse {
  success: boolean;
  service_available: boolean;
  bedrock_access_ok: boolean;
  region?: string;
  model_id?: string;
  checked_at: string;
  diagnostic_message?: string;
}
