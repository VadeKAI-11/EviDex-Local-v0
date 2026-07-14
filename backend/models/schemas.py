from typing import Optional, List, Dict, Any
from pydantic import BaseModel
"""
Data Models and Schemas - Pydantic Models for Workflow State

This module defines all data structures used throughout the EviDex application.
It uses Pydantic models for validation, serialization, and type safety across
the backend and API communication layer.

Key Model Categories:
1. Workflow State Models - Track workflow progression and execution context
2. Evidence Models - Represent collected evidence items and validation results
3. Agent Output Models - Store interpretation, validation, and conclusion data
4. Step Logging Models - Maintain complete audit trail of all operations
5. Enumerations - Define valid states, statuses, and categories

Model Usage:
- Request/response validation in FastAPI endpoints
- State persistence to filesystem (.system/requests/)
- Data transfer between workflow stages
- Type hints for IDE support and static analysis

All models are immutable after creation (frozen=True) for audit integrity,
except WorkflowExecutionContext which tracks mutable workflow state.
"""

# ============================================================================
# IMPORTS
# ============================================================================

from datetime import datetime
from enum import Enum


# ============================================================================
# ENUMS
# ============================================================================

class WorkflowStage(str, Enum):
    """Represents the current stage in the audit workflow."""
    INITIALIZATION = "initialization"
    INTERPRETATION = "interpretation"
    RETRIEVAL = "retrieval"
    VALIDATION = "validation"
    CONCLUSION = "conclusion"
    APPROVAL = "approval"
    EXPORTED = "exported"


class ValidationStatus(str, Enum):
    """Represents the validation status of evidence."""
    SUFFICIENT = "sufficient"
    INSUFFICIENT = "insufficient"
    PARTIAL = "partial"


class ApprovalStatus(str, Enum):
    """Represents the approval status of the audit report."""
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    REVISING = "revising"


# ============================================================================
# STEP LOG SCHEMA
# ============================================================================

class StepInput(BaseModel):
    """Represents input data for a workflow step."""
    key: str
    value: Any


class StepOutput(BaseModel):
    """Represents output data from a workflow step."""
    key: str
    value: Any


class WorkflowStepLog(BaseModel):
    """
    Structured step log entry for complete process traceability.
    Required fields: step_name, action_taken, inputs, outputs
    """
    step_id: str  # Unique identifier for the step
    step_name: str  # Name of the step (e.g., "Interpretation", "Retrieval", "Validation")
    agent_name: str  # Name of the agent executing the step
    request_id: str  # Reference to the audit request
    timestamp: datetime
    action_taken: str  # Description of what action was performed
    inputs: List[StepInput]  # Input parameters/data for the step
    outputs: List[StepOutput]  # Output results from the step
    status: str  # "completed", "in_progress", "failed"
    error_message: Optional[str] = None  # Error details if step failed
    confidence_score: float  # AI confidence for this step (0-1)
    execution_time_ms: int  # Time taken to execute step in milliseconds


# ============================================================================
# EVIDENCE SCHEMA
# ============================================================================

class EvidenceItem(BaseModel):
    """Represents a single piece of evidence collected during the audit."""
    evidence_id: str
    request_id: str
    filename: str
    storage_path: str
    file_type: str  # pdf, docx, msg, xlsx, txt
    file_size_bytes: int
    upload_timestamp: datetime
    source: str  # "direct_upload", "folder_access", "system_extraction"
    
    # Validation fields
    relevance_score: float  # 0-1, indicates relevance to audit request
    sufficiency_score: float  # 0-1, percentage of sufficiency
    validation_status: ValidationStatus
    validation_notes: str  # Human-readable validation notes
    
    # Extracted content metadata
    content_preview: Optional[str] = None  # First 500 chars of content
    key_findings: List[str] = []  # Extracted key findings from document
    validation_step_log_id: Optional[str] = None  # Reference to validation step log


class EvidenceValidationResult(BaseModel):
    """Result of validating a batch of evidence items."""
    validation_id: str
    request_id: str
    timestamp: datetime
    total_evidence_items: int
    sufficient_items: int
    insufficient_items: int
    overall_sufficiency_score: float  # Average sufficiency across all items
    overall_validation_status: ValidationStatus
    evidence_items: List[EvidenceItem]
    gap_recommendations: List[str]
    average_confidence_score: float


# ============================================================================
# INTERPRETATION SCHEMA
# ============================================================================

class InterpretedTask(BaseModel):
    """Represents an actionable task extracted from the audit request."""
    task_id: str
    task_description: str
    priority: int  # 1 (high) to 5 (low)
    required_evidence_types: List[str]  # Types of documents to look for
    keywords: List[str]  # Keywords to search for in documents


class RequestInterpretation(BaseModel):
    """Result of interpreting an audit request."""
    interpretation_id: str
    request_id: str
    timestamp: datetime
    original_request: str
    interpreted_tasks: List[InterpretedTask]
    interpretation_confidence: float  # 0-1
    required_data_sources: List[str]  # Folder paths or systems to access
    interpretation_notes: str


# ============================================================================
# AUDIT REQUEST SCHEMA
# ============================================================================

class AuditRequest(BaseModel):
    """Main audit request entity."""
    request_id: str
    auditor_id: str
    auditor_email: str
    created_at: datetime
    updated_at: datetime
    
    # Request content
    request_text: str  # Natural language request from auditor
    request_category: str  # e.g., "financial", "operational", "compliance"
    
    # Workflow state
    current_stage: WorkflowStage
    
    # Linked entities
    interpretation: Optional[RequestInterpretation] = None
    evidence_items: List[EvidenceItem] = []
    validation_result: Optional[EvidenceValidationResult] = None
    conclusion: Optional[Any] = None
    approval_status: ApprovalStatus = ApprovalStatus.PENDING
    
    # Traceability
    step_logs: List[WorkflowStepLog] = []
    
    # Metadata
    priority: str = "normal"
    tags: List[str] = []


# ============================================================================
# CONCLUSION & REPORT SCHEMA
# ============================================================================

class KeyFinding(BaseModel):
    """Represents a key finding in the audit conclusion."""
    finding_id: str
    description: str
    evidence_references: List[str]  # Links to evidence_ids that support this finding
    severity: str  # "critical", "high", "medium", "low"


class AuditConclusion(BaseModel):
    """Generated conclusion from the validation workflow."""
    conclusion_id: str
    request_id: str
    timestamp: datetime
    key_findings: List[KeyFinding]
    overall_assessment: str  # Human-readable summary
    average_ai_confidence_score: float  # Average confidence across all steps
    evidence_coverage: float  # Percentage of request coverage by evidence
    recommendations: List[str]  # Next steps or recommendations


# ============================================================================
# APPROVAL WORKFLOW SCHEMA
# ============================================================================

class ApprovalRequest(BaseModel):
    """Represents an approval request sent to auditor."""
    approval_id: str
    request_id: str
    conclusion_id: str
    sent_at: datetime
    sent_to_email: str
    status: ApprovalStatus = ApprovalStatus.PENDING
    approved_at: Optional[datetime] = None
    approved_by: Optional[str] = None
    rejection_reason: Optional[str] = None


class ApprovalAction(BaseModel):
    """Record of an approval action (approve/reject/request revision)."""
    action_id: str
    approval_id: str
    request_id: str
    action_type: str  # "approved", "rejected", "revision_requested"
    action_taken_at: datetime
    taken_by: str  # Auditor email
    notes: str
    adjustment_details: Optional[Dict[str, Any]] = None  # For revision requests


# ============================================================================
# CONVERSATION SCHEMA
# ============================================================================

class ConversationMessage(BaseModel):
    """Represents a message in the conversational interface."""
    message_id: str
    request_id: str
    conversation_id: str
    timestamp: datetime
    sender_type: str  # "auditor" or "ai_agent"
    sender_id: str
    message_text: str
    message_type: str  # "question", "clarification", "feedback", "response", "explanation"
    
    # Context linking
    referenced_step_log_id: Optional[str] = None  # Links to specific step if explaining
    referenced_evidence_ids: List[str] = []  # Links to specific evidence items
    
    # AI response fields (only for AI messages)
    ai_model: Optional[str] = None
    ai_confidence: Optional[float] = None


class Conversation(BaseModel):
    """Represents a conversation session for an audit request."""
    conversation_id: str
    request_id: str
    created_at: datetime
    updated_at: datetime
    messages: List[ConversationMessage] = []
    
    # Conversation metadata
    topic: str  # e.g., "clarification", "feedback", "explanation"
    status: str  # "active", "resolved", "escalated"


# ============================================================================
# WORKFLOW EXECUTION CONTEXT
# ============================================================================

class WorkflowExecutionContext(BaseModel):
    """Context maintained during workflow execution."""
    request_id: str
    current_stage: WorkflowStage
    step_logs: List[WorkflowStepLog]
    evidence_collected: List[EvidenceItem]
    interpretation: Optional[RequestInterpretation] = None
    validation_result: Optional[EvidenceValidationResult] = None
    conclusion: Optional[AuditConclusion] = None
    approval_status: ApprovalStatus
    execution_metadata: Dict[str, Any] = {}  # Flexible metadata for storing agent-specific context


# ============================================================================
# API RESPONSE SCHEMAS
# ============================================================================

class APIStepLogResponse(BaseModel):
    """Response containing step logs for API endpoints."""
    request_id: str
    stage: WorkflowStage
    step_logs: List[WorkflowStepLog]
    timestamp: datetime


class APIWorkflowStatusResponse(BaseModel):
    """Response with current workflow status."""
    request_id: str
    current_stage: WorkflowStage
    approval_status: ApprovalStatus
    evidence_count: int
    overall_confidence_score: float
    step_logs_summary: List[Dict[str, Any]]  # Simplified summary of steps


class APIConversationResponse(BaseModel):
    """Response for conversation endpoints."""
    conversation_id: str
    request_id: str
    messages: List[ConversationMessage]
    timestamp: datetime
