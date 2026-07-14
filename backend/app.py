"""
EviDex Backend - FastAPI Application Entry Point

This is the main FastAPI application that exposes REST API endpoints for the
EviDex audit evidence collection and validation workflow. It coordinates all
workflow stages, manages evidence files, and integrates with AWS Bedrock for
AI-powered interpretation, validation, and summarization.

Key Responsibilities:
- Expose RESTful API endpoints for workflow operations
- Coordinate workflow orchestration through WorkflowOrchestrator
- Handle evidence file uploads and downloads
- Integrate with AWS Bedrock for AI agent capabilities
- Maintain audit logs and step-by-step traceability
- Support conversational "Ask Agent Why" explanations

API Structure:
- /api/requests/* - Core workflow endpoints (create, interpret, retrieve, validate, conclude)
- /api/evidence/* - Evidence file management and preview
- /api/chat/* - Conversational agent interaction
- /api/admin/* - System management (standards knowledge base, diagnostics)
"""

# ============================================================================
# IMPORTS AND DEPENDENCIES
# ============================================================================

import json
import os
import logging
import re
import shutil
import mimetypes
import hashlib
import subprocess
from datetime import datetime

# Inject the OS trust store (Windows cert store) into Python's ssl module
# so that boto3 and all other SSL clients trust Deloitte's corporate proxy CA.
try:
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass  # truststore not installed; fall back to env-var or certifi bundle
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, UploadFile, File, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

from agents.access_agent import AccessAgent
from agents.interpretation_agent_ai import interpret_audit_request_ai
from agents.validation_agent_ai import validate_evidence_ai
from agents.summarization_agent_ai import generate_audit_conclusion_ai
from agents.bedrock_summary_agent import (
    summarize_with_bedrock,
    get_bedrock_tls_debug_info,
    _resolve_explicit_credentials,
    _is_placeholder_credential,
)
from agents.reasoning_logger import log_workflow_step, create_step_input, create_step_output, log_step
from agents.conversation_manager import ConversationManager
from agents.evidence_parser import parse_evidence_file
from agents.standards_knowledge_base import (
    get_refresh_configuration,
    start_background_refresh,
    stop_background_refresh,
)
from auth.login import router as auth_router
from storage.filesystem import copy_inventory_to_s3
from storage.local_storage import save_uploaded_files, AUTOMATIC_EVIDENCE_DIR
from workflow_orchestrator import WorkflowOrchestrator
from models.schemas import (
    WorkflowStage,
    ApprovalStatus,
    APIWorkflowStatusResponse,
    ConversationMessage,
    EvidenceValidationResult,
    ValidationStatus,
)

# ============================================================================
# FASTAPI APP SETUP
# ============================================================================

app = FastAPI(
    title="EviDex Backend - Audit Evidence Collection & Validation",
    version="1.0.0",
    description="Agentic AI system for automated audit evidence collection with full process traceability"
)

logger = logging.getLogger("evidex.startup")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Auth endpoints
app.include_router(auth_router)


@app.on_event("startup")
def log_startup_tls_health() -> None:
    tls_info = get_bedrock_tls_debug_info()
    logger.info(
        "Bedrock TLS verify source=%s value=%s",
        tls_info.get("source", "unknown"),
        tls_info.get("value", "unknown"),
    )
    
    # Log credential diagnostic info
    region = os.getenv("AWS_REGION", "us-east-1")
    explicit_creds = _resolve_explicit_credentials(region)
    
    if explicit_creds:
        access_key_id = explicit_creds.get("aws_access_key_id", "")
        secret_key = explicit_creds.get("aws_secret_access_key", "")
        
        # Mask the keys for logging
        masked_key_id = (access_key_id[:6] + "..." + access_key_id[-4:]) if len(access_key_id) > 10 else "***"
        masked_secret = ("***" + secret_key[-4:]) if len(secret_key) > 4 else "***"
        
        logger.info(
            "Bedrock credentials resolved: access_key_id=%s secret_key=%s region=%s",
            masked_key_id,
            masked_secret,
            explicit_creds.get("region_name", region),
        )
    else:
        logger.warning(
            "WARNING: No explicit Bedrock credentials found. Will attempt to use AWS shared profile or instance role."
        )

    refresh_config = get_refresh_configuration()
    logger.info(
        "Standards refresh config interval_hours=%s ttl_days=%s external_search_ttl_days=%s",
        refresh_config.get("refresh_interval_hours"),
        refresh_config.get("ttl_days"),
        refresh_config.get("external_search_ttl_days"),
    )

    start_background_refresh()


@app.on_event("shutdown")
def stop_background_tasks() -> None:
    stop_background_refresh()

# ============================================================================
# GLOBAL INSTANCES
# ============================================================================

access_agent = AccessAgent()
workflow_orchestrator = WorkflowOrchestrator()

mimetypes.add_type("application/vnd.ms-outlook", ".msg")

OFFICE_PREVIEW_EXTENSIONS = {
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
}

RELEVANCE_STOPWORDS = {
    "about", "after", "again", "against", "also", "audit", "because", "before", "being",
    "between", "could", "evidence", "files", "from", "have", "into", "just", "more",
    "other", "request", "should", "than", "that", "their", "there", "these", "this",
    "those", "through", "very", "what", "when", "where", "which", "while", "with",
}

# Initialize conversation manager (uses Bedrock Claude)
try:
    conversation_manager = ConversationManager()
except Exception:
    conversation_manager = None


# ============================================================================
# REQUEST/RESPONSE MODELS
# ============================================================================

class InitiateRequestPayload(BaseModel):
    """Payload for initiating a new audit request."""
    auditor_id: str
    auditor_email: str
    request_text: str
    request_category: str = "general"
    priority: str = "normal"
    project_name: str = "default"


class InterpretRequestPayload(BaseModel):
    """Payload for interpreting an audit request."""
    request_id: str


class RetrieveEvidencePayload(BaseModel):
    """Payload for retrieving evidence."""
    request_id: str
    data_sources: List[str]
    keywords: Optional[List[str]] = None


class AuditorFeedbackPayload(BaseModel):
    """Payload for auditor feedback."""
    request_id: str
    feedback_text: str
    feedback_type: str = "general"


class ConversationMessagePayload(BaseModel):
    """Payload for conversation messages."""
    request_id: str
    message_text: str
    message_type: str = "question"
    referenced_step_id: Optional[str] = None
    referenced_evidence_ids: Optional[List[str]] = None


class ApprovalPayload(BaseModel):
    """Payload for approval actions."""
    request_id: str
    auditor_email: str
    action: str  # "approve", "reject", "revision_requested"
    notes: Optional[str] = None


# ============================================================================
# WORKFLOW ENDPOINTS
# ============================================================================

@app.post("/api/requests")
def create_audit_request(payload: InitiateRequestPayload):
    """
    Initialize a new audit request.
    
    This is the entry point for a new audit. Creates request ID and execution context.
    """
    try:
        audit_request, step_log = workflow_orchestrator.initialize_request(
            auditor_id=payload.auditor_id,
            auditor_email=payload.auditor_email,
            request_text=payload.request_text,
            request_category=payload.request_category,
            priority=payload.priority,
            project_name=payload.project_name,
        )
        
        return {
            "success": True,
            "request_id": audit_request.request_id,
            "stage": audit_request.current_stage.value,
            "created_at": audit_request.created_at.isoformat(),
            "step_log": step_log
        }
    except Exception as e:
        raise HTTPException(500, f"Failed to create request: {str(e)}")


@app.get("/api/requests/list")
def list_requests():
    """List persisted requests so frontend can sync past and present runs."""
    try:
        return {
            "success": True,
            "requests": workflow_orchestrator.list_request_summaries(),
        }
    except Exception as e:
        raise HTTPException(500, f"Failed to list requests: {str(e)}")


@app.post("/api/requests/{request_id}/interpret")
def interpret_request(request_id: str):
    """
    Move to INTERPRETATION stage and parse the audit request into actionable tasks.
    """
    try:
        audit_request = workflow_orchestrator.get_request(request_id)
        if not audit_request:
            raise HTTPException(404, f"Request {request_id} not found")

        if (
            audit_request.current_stage != WorkflowStage.INITIALIZATION
            and audit_request.interpretation is not None
        ):
            interpretation = audit_request.interpretation
            return {
                "success": True,
                "request_id": request_id,
                "stage": audit_request.current_stage.value,
                "interpretation": {
                    "tasks": [
                        {
                            "task_id": task.task_id,
                            "description": task.task_description,
                            "priority": task.priority,
                            "evidence_types": task.required_evidence_types,
                            "keywords": task.keywords,
                        }
                        for task in interpretation.interpreted_tasks
                    ],
                    "confidence": interpretation.interpretation_confidence,
                    "data_sources": interpretation.required_data_sources,
                },
                "message": "Interpretation already completed for this request.",
                "step_log": None,
            }
        
        # Define interpretation handler
        def interpret_handler(request_text: str) -> Dict[str, Any]:
            from agents.collection_agent import AUTOMATIC_EVIDENCE_DIR as _AUTO_DIR

            result = interpret_audit_request_ai(request_text)
            requested_sources = (
                result.get("data_sources")
                if isinstance(result.get("data_sources"), list)
                else []
            )

            normalized_sources: List[str] = [_AUTO_DIR]
            for source in requested_sources:
                source_str = str(source or "").strip()
                if not source_str:
                    continue
                if source_str.lower() == "/audit/evidence":
                    continue
                if source_str not in normalized_sources:
                    normalized_sources.append(source_str)

            result["data_sources"] = normalized_sources
            return result
        
        interpretation, step_log = workflow_orchestrator.interpret_request(
            request_id=request_id,
            interpretation_handler=interpret_handler
        )
        
        return {
            "success": True,
            "request_id": request_id,
            "stage": WorkflowStage.INTERPRETATION.value,
            "interpretation": {
                "tasks": [
                    {
                        "task_id": task.task_id,
                        "description": task.task_description,
                        "priority": task.priority,
                        "evidence_types": task.required_evidence_types,
                        "keywords": task.keywords
                    }
                    for task in interpretation.interpreted_tasks
                ],
                "confidence": interpretation.interpretation_confidence,
                "data_sources": interpretation.required_data_sources
            },
            "step_log": step_log
        }
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        logger.error(f"Interpretation failed for {request_id}: {str(e)}")
        logger.error(traceback.format_exc())
        raise HTTPException(500, f"Interpretation failed: {str(e)}")


@app.post("/api/requests/{request_id}/retrieve")
def retrieve_evidence(request_id: str, payload: RetrieveEvidencePayload):
    """
    Move to RETRIEVAL stage and collect evidence from data sources.
    """
    try:
        audit_request = workflow_orchestrator.get_request(request_id)
        if not audit_request:
            raise HTTPException(404, f"Request {request_id} not found")

        if payload.request_id and payload.request_id != request_id:
            raise HTTPException(400, "request_id in payload must match URL request_id")

        # Build scan log before retrieval (shown in UI as evidence of scanning activity)
        from agents.collection_agent import AUTOMATIC_EVIDENCE_DIR as _AUTO_DIR
        requested_sources = payload.data_sources or []
        normalized_sources: List[str] = [_AUTO_DIR]
        for source in requested_sources:
            source_str = str(source or "").strip()
            if not source_str:
                continue
            if source_str.lower() == "/audit/evidence":
                continue
            if source_str not in normalized_sources:
                normalized_sources.append(source_str)

        # Always include the automatic evidence source so retrieval does not
        # stall on placeholder paths.
        if audit_request.interpretation:
            audit_request.interpretation.required_data_sources = normalized_sources

        request_folder = os.path.join(_AUTO_DIR, request_id)

        scan_log = [
            "Pre-retrieval folder creation is disabled (lazy backend write mode).",
            f"Default evidence folder: {_AUTO_DIR}",
            f"Request-scoped evidence folder: {request_folder}",
        ]

        # Scan only the request-specific folder under automatic evidence root
        try:
            if os.path.exists(request_folder):
                auto_files = []
                for root, dirs, fnames in os.walk(request_folder):
                    for fname in fnames:
                        rel = os.path.relpath(os.path.join(root, fname), request_folder)
                        auto_files.append(rel)
                scan_log.append(f"Scanning {request_folder} — found {len(auto_files)} file(s)")
                for fname in sorted(auto_files)[:20]:
                    scan_log.append(f"  \u2192 {fname}")
            else:
                scan_log.append(f"Request evidence folder does not exist yet: {request_folder}")
        except Exception as _e:
            scan_log.append(f"Could not scan request evidence folder: {str(_e)}")

        # Scan any additional user-supplied sources
        for source in normalized_sources:
            if source == _AUTO_DIR:
                continue
            try:
                if os.path.exists(source):
                    src_files = [f for f in os.listdir(source) if os.path.isfile(os.path.join(source, f))]
                    scan_log.append(f"Scanning {source} — found {len(src_files)} file(s)")
                    for fname in sorted(src_files)[:10]:
                        scan_log.append(f"  \u2192 {fname}")
                else:
                    scan_log.append(f"Source not found: {source}")
            except Exception as _e:
                scan_log.append(f"Error scanning {source}: {str(_e)}")

        # Define retrieval handler
        def retrieval_handler(data_sources: List[str], tasks: List[Any]) -> List[Dict[str, Any]]:
            from agents.collection_agent import collect_evidence

            try:
                evidence = collect_evidence(
                    data_sources=data_sources,
                    tasks=tasks,
                    keywords=payload.keywords or []
                )
                return evidence
            except Exception as retrieval_error:
                # Keep workflow progression deterministic even if folder access/parsing
                # fails for a specific source during retrieval.
                scan_log.append(f"Retrieval handler fallback triggered: {str(retrieval_error)}")
                return []

        evidence_items, step_log = workflow_orchestrator.retrieve_evidence(
            request_id=request_id,
            retrieval_handler=retrieval_handler
        )

        return {
            "success": True,
            "request_id": request_id,
            "stage": WorkflowStage.RETRIEVAL.value,
            "evidence_items": len(evidence_items),
            "items": evidence_items[:5],  # Return first 5 for preview
            "scan_log": scan_log,
            "step_log": step_log
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Evidence retrieval failed: {str(e)}")


@app.post("/api/requests/{request_id}/validate")
def validate_evidence_endpoint(request_id: str):
    """
    Move to VALIDATION stage and evaluate evidence quality and sufficiency.
    """
    try:
        audit_request = workflow_orchestrator.get_request(request_id)
        if not audit_request:
            raise HTTPException(404, f"Request {request_id} not found")
        
        context = workflow_orchestrator.get_context(request_id)
        
        # Define validation handler
        validation_payload: Dict[str, Any] = {}

        def validation_handler(evidence_items: List[Dict[str, Any]], interpretation: Any) -> Any:
            if not evidence_items:
                result = EvidenceValidationResult(
                    validation_id=f"VAL-NOEVID-{request_id}",
                    request_id=request_id,
                    timestamp=datetime.utcnow(),
                    total_evidence_items=0,
                    sufficient_items=0,
                    insufficient_items=0,
                    overall_sufficiency_score=0.0,
                    overall_validation_status=ValidationStatus.INSUFFICIENT,
                    evidence_items=[],
                    gap_recommendations=["NO EVIDENCE FOUND"],
                    average_confidence_score=1.0,
                )
                validation_payload["result"] = {
                    "validated_items": [],
                    "validation_result": result,
                }
                return result

            result = validate_evidence_ai(
                request_id=request_id,
                evidence_inventory=evidence_items,
                interpretation=interpretation,
                request_text=audit_request.request_text,
            )
            validation_payload["result"] = result
            return result["validation_result"]
        
        validation_result, step_log = workflow_orchestrator.validate_evidence(
            request_id=request_id,
            validation_handler=validation_handler
        )

        if validation_payload.get("result"):
            selected_items = validation_payload["result"].get("selected_validated_items")
            if isinstance(selected_items, list) and selected_items:
                context.execution_metadata["selected_evidence_for_scoring"] = selected_items
            else:
                context.execution_metadata["selected_evidence_for_scoring"] = validation_payload["result"].get("validated_items", [])

            # Persist full validated item metadata so conclusion can derive
            # per-file sufficient subsets for partial/insufficient outcomes.
            context.execution_metadata["validated_evidence_for_scoring"] = validation_payload["result"].get("validated_items", [])

            # Keep full collected evidence inventory intact for status/evidence listing.
            # Selected subset is tracked separately in execution_metadata for scoring paths.
            workflow_orchestrator._persist_request(request_id)
        
        return {
            "success": True,
            "request_id": request_id,
            "stage": WorkflowStage.VALIDATION.value,
            "validation": {
                "total_items": validation_result.total_evidence_items,
                "sufficient_items": validation_result.sufficient_items,
                "overall_sufficiency": validation_result.overall_sufficiency_score,
                "status": validation_result.overall_validation_status.value,
                "sufficiency_conclusion": validation_payload.get("result", {}).get("sufficiency_conclusion", ""),
                "confidence": validation_result.average_confidence_score,
                "recommendations": validation_result.gap_recommendations
            },
            "step_log": step_log
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Validation failed: {str(e)}")


@app.post("/api/requests/{request_id}/conclude")
def generate_conclusion_endpoint(request_id: str):
    """
    Move to CONCLUSION stage and generate audit findings and assessment.
    """
    try:
        audit_request = workflow_orchestrator.get_request(request_id)
        if not audit_request:
            raise HTTPException(404, f"Request {request_id} not found")
        
        if not audit_request.validation_result:
            raise HTTPException(400, "Validation required before conclusion")
        
        context = workflow_orchestrator.get_context(request_id)

        selected_for_scoring = []
        validated_for_scoring = []
        if context and isinstance(context.execution_metadata, dict):
            selected_candidate = context.execution_metadata.get("selected_evidence_for_scoring")
            if isinstance(selected_candidate, list):
                selected_for_scoring = selected_candidate
            validated_candidate = context.execution_metadata.get("validated_evidence_for_scoring")
            if isinstance(validated_candidate, list):
                validated_for_scoring = validated_candidate
        
        # Define conclusion handler
        def conclusion_handler(validation_result: Any, evidence_items: List[Dict[str, Any]], interpretation: Any) -> Dict[str, Any]:
            status_value = str(getattr(validation_result, "overall_validation_status", "") or "").lower()

            def _is_file_level_sufficient(item: Dict[str, Any]) -> bool:
                item_status = str(item.get("validation_status") or item.get("status") or "").lower()
                if item_status == ValidationStatus.SUFFICIENT.value:
                    return True
                try:
                    return float(item.get("sufficiency_score", 0.0) or 0.0) >= 0.85
                except (TypeError, ValueError):
                    return False

            per_file_sufficient_items = [
                item for item in validated_for_scoring if isinstance(item, dict) and _is_file_level_sufficient(item)
            ]

            def _strongest_validated_subset(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
                candidates = [item for item in items if isinstance(item, dict)]
                if not candidates:
                    return []

                def _rank(item: Dict[str, Any]) -> float:
                    try:
                        relevance = float(item.get("relevance_score", 0.0) or 0.0)
                    except (TypeError, ValueError):
                        relevance = 0.0
                    try:
                        sufficiency = float(item.get("sufficiency_score", 0.0) or 0.0)
                    except (TypeError, ValueError):
                        sufficiency = 0.0
                    return (sufficiency * 0.75) + (relevance * 0.25)

                ranked = sorted(candidates, key=_rank, reverse=True)
                max_subset = min(len(ranked), 3)
                return ranked[:max_subset] if max_subset > 0 else []

            strongest_items = _strongest_validated_subset(validated_for_scoring)

            # Scoring evidence policy:
            # - sufficient: use selected subset from validation
            # - partial/insufficient: use file-level sufficient items when available,
            #   otherwise fall back to selected subset then full evidence list
            if status_value in {ValidationStatus.PARTIAL.value, ValidationStatus.INSUFFICIENT.value}:
                scoring_evidence = (
                    per_file_sufficient_items
                    if per_file_sufficient_items
                    else (
                        strongest_items
                        if strongest_items
                        else (selected_for_scoring if selected_for_scoring else evidence_items)
                    )
                )
            else:
                scoring_evidence = selected_for_scoring if selected_for_scoring else evidence_items

            if not scoring_evidence:
                return {
                    "key_findings": [
                        {
                            "title": "NO EVIDENCE FOUND",
                            "description": "NO EVIDENCE FOUND",
                            "severity": "high",
                        }
                    ],
                    "overall_assessment": "NO EVIDENCE FOUND",
                    "confidence": 1.0,
                    "coverage": 0.0,
                    "recommendations": [
                        "NO EVIDENCE FOUND"
                    ],
                    "status": "requires_additional_evidence",
                }

            result = generate_audit_conclusion_ai(
                validation_result=validation_result,
                evidence_items=scoring_evidence,
                interpretation=interpretation,
                request_text=audit_request.request_text,
            )
            return result
        
        conclusion, step_log = workflow_orchestrator.generate_conclusion(
            request_id=request_id,
            conclusion_handler=conclusion_handler
        )

        validation_summary = {
            "overall_sufficiency_score": audit_request.validation_result.overall_sufficiency_score,
            "confidence": audit_request.validation_result.average_confidence_score,
            "overall_validation_status": audit_request.validation_result.overall_validation_status.value,
            "gap_recommendations": audit_request.validation_result.gap_recommendations,
        }
        conclusion_summary = {
            "overall_assessment": conclusion.overall_assessment,
            "confidence": conclusion.average_ai_confidence_score,
            "coverage": conclusion.evidence_coverage,
            "recommendations": conclusion.recommendations,
            "key_findings": [
                {
                    "description": getattr(finding, "description", ""),
                    "severity": getattr(finding, "severity", "medium"),
                }
                for finding in conclusion.key_findings
            ],
        }
        bedrock_summary = summarize_with_bedrock(
            request_id=request_id,
            request_text=audit_request.request_text,
            evidence_items=context.evidence_collected,
            validation_summary=validation_summary,
            conclusion_summary=conclusion_summary,
        )
        context.execution_metadata["bedrock_summary"] = bedrock_summary
        workflow_orchestrator._persist_request(request_id)
        model_report_sections = (
            context.execution_metadata.get("model_report_sections", {})
            if isinstance(context.execution_metadata, dict)
            else {}
        )
        
        return {
            "success": True,
            "request_id": request_id,
            "stage": WorkflowStage.CONCLUSION.value,
            "conclusion": {
                "key_findings": [
                    {
                        # KeyFinding is a Pydantic model — use attribute access, not .get()
                        "title": (f.description if hasattr(f, "description") else f.get("description") or f.get("title", "")),
                        "description": (f.description if hasattr(f, "description") else f.get("description", "")),
                        "severity": (f.severity if hasattr(f, "severity") else f.get("severity", "medium")),
                    }
                    for f in conclusion.key_findings
                ],
                "overall_assessment": conclusion.overall_assessment,
                "confidence": conclusion.average_ai_confidence_score,
                "coverage": conclusion.evidence_coverage,
                "recommendations": conclusion.recommendations,
                "report_sections": model_report_sections,
            },
            "bedrock_summary": bedrock_summary,
            "step_log": step_log
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Conclusion generation failed: {str(e)}")


# ============================================================================
# APPROVAL WORKFLOW ENDPOINTS
# ============================================================================

@app.post("/api/requests/{request_id}/submit-for-approval")
def submit_for_approval(request_id: str):
    """
    Submit the audit conclusion for auditor review and approval.
    """
    try:
        audit_request, step_log = workflow_orchestrator.move_to_approval(request_id)
        
        return {
            "success": True,
            "request_id": request_id,
            "stage": audit_request.current_stage.value,
            "approval_status": audit_request.approval_status.value,
            "auditor_email": audit_request.auditor_email,
            "step_log": step_log
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Approval submission failed: {str(e)}")


@app.post("/api/requests/{request_id}/approve")
def approve_request(request_id: str, payload: ApprovalPayload):
    """
    Approve the audit conclusion and move to EXPORTED stage.
    """
    try:
        audit_request, step_log = workflow_orchestrator.approve_request(
            request_id=request_id,
            auditor_email=payload.auditor_email,
            notes=payload.notes or ""
        )
        
        return {
            "success": True,
            "request_id": request_id,
            "stage": audit_request.current_stage.value,
            "approval_status": audit_request.approval_status.value,
            "message": "Request approved and ready for export",
            "step_log": step_log
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Approval failed: {str(e)}")


@app.post("/api/requests/{request_id}/reject")
def reject_request(request_id: str, payload: ApprovalPayload):
    """
    Reject the audit conclusion.
    """
    try:
        audit_request, step_log = workflow_orchestrator.reject_request(
            request_id=request_id,
            auditor_email=payload.auditor_email,
            rejection_reason=payload.notes or "No reason provided"
        )
        
        return {
            "success": True,
            "request_id": request_id,
            "approval_status": audit_request.approval_status.value,
            "step_log": step_log
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Rejection failed: {str(e)}")


@app.post("/api/requests/{request_id}/request-revision")
def request_revision(request_id: str, payload: ApprovalPayload):
    """
    Request revision to the audit conclusion.
    """
    try:
        audit_request, step_log = workflow_orchestrator.request_revision(
            request_id=request_id,
            auditor_email=payload.auditor_email,
            revision_notes=payload.notes or "Revisions needed"
        )
        
        return {
            "success": True,
            "request_id": request_id,
            "approval_status": audit_request.approval_status.value,
            "step_log": step_log
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Revision request failed: {str(e)}")


# ============================================================================
# CONVERSATION ENDPOINTS
# ============================================================================

@app.post("/api/conversations/create")
def create_conversation(payload: Dict[str, Any]):
    """Create a new conversation session for an audit request."""
    
    if not conversation_manager:
        raise HTTPException(
            503, 
            "Conversation service not available. Configure AWS Bedrock credentials and model access."
        )
    
    try:
        request_id = payload.get("request_id")
        topic = payload.get("topic", "clarification")
        
        if not request_id:
            raise HTTPException(400, "request_id is required")
        
        # Verify request exists
        audit_request = workflow_orchestrator.get_request(request_id)
        if not audit_request:
            raise HTTPException(404, f"Request {request_id} not found")
        
        conversation = conversation_manager.create_conversation(
            request_id=request_id,
            topic=topic
        )
        
        return {
            "success": True,
            "conversation_id": conversation.conversation_id,
            "request_id": conversation.request_id,
            "topic": conversation.topic
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to create conversation: {str(e)}")


@app.get("/api/conversations/health")
def conversation_health(probe: bool = True):
    """Conversation diagnostics endpoint with optional Bedrock probe."""

    if not conversation_manager:
        raise HTTPException(
            503,
            "Conversation service not available. Configure AWS Bedrock credentials and model access.",
        )

    try:
        health = conversation_manager.get_health_status(run_probe=probe)
        if not health.get("bedrock_access_ok", False):
            raise HTTPException(503, health.get("diagnostic_message", "Bedrock probe failed"))
        return health
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Conversation health check failed: {str(e)}")


@app.post("/api/conversations/{conversation_id}/messages")
def send_message(conversation_id: str, payload: ConversationMessagePayload):
    """Send a message in a conversation and get AI response."""
    
    if not conversation_manager:
        raise HTTPException(
            503,
            "Conversation service not available. Configure AWS Bedrock credentials and model access."
        )
    
    try:
        # Get conversation
        conversation = conversation_manager.get_conversation(conversation_id)
        if not conversation:
            raise HTTPException(404, f"Conversation {conversation_id} not found")
        
        # Add auditor message
        auditor_msg = conversation_manager.add_auditor_message(
            conversation_id=conversation_id,
            message_text=payload.message_text,
            message_type=payload.message_type,
            referenced_step_id=payload.referenced_step_id,
            referenced_evidence_ids=payload.referenced_evidence_ids
        )
        
        # Get request context
        audit_request = workflow_orchestrator.get_request(conversation.request_id)
        
        # Generate AI response
        ai_msg = conversation_manager.generate_ai_response(
            conversation_id=conversation_id,
            request=audit_request
        )
        
        return {
            "success": True,
            "conversation_id": conversation_id,
            "auditor_message_id": auditor_msg.message_id,
            "ai_message_id": ai_msg.message_id,
            "ai_response": ai_msg.message_text,
            "confidence": ai_msg.ai_confidence
        }
    except HTTPException:
        raise
    except Exception as e:
        message = str(e)
        lowered = message.lower()
        if (
            "bedrock access denied" in lowered
            or "unable to connect to aws bedrock" in lowered
            or "model access" in lowered
            or "invoke" in lowered and "bedrock" in lowered
        ):
            raise HTTPException(503, message)
        raise HTTPException(500, f"Message processing failed: {message}")


@app.get("/api/conversations/{conversation_id}")
def get_conversation(conversation_id: str):
    """Get conversation history and summary."""
    
    if not conversation_manager:
        raise HTTPException(
            503,
            "Conversation service not available. Configure AWS Bedrock credentials and model access."
        )
    
    try:
        summary = conversation_manager.get_conversation_summary(conversation_id)
        return {
            "success": True,
            "conversation": summary
        }
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"Failed to retrieve conversation: {str(e)}")


# ============================================================================
# DATA RETRIEVAL ENDPOINTS
# ============================================================================

@app.get("/api/requests/{request_id}")
def get_request_details(request_id: str):
    """Get complete audit request details."""
    
    try:
        audit_request = workflow_orchestrator.get_request(request_id)
        if not audit_request:
            raise HTTPException(404, f"Request {request_id} not found")

        workflow_status = workflow_orchestrator.get_workflow_status(request_id)
        evidence_count = int(workflow_status.get("evidence_count", 0)) if isinstance(workflow_status, dict) else 0
        
        return {
            "success": True,
            "request": {
                "request_id": audit_request.request_id,
                "auditor_id": audit_request.auditor_id,
                "auditor_email": audit_request.auditor_email,
                "request_text": audit_request.request_text,
                "category": audit_request.request_category,
                "evidence_count": evidence_count,
                "current_stage": audit_request.current_stage.value,
                "approval_status": audit_request.approval_status.value,
                "created_at": audit_request.created_at.isoformat(),
                "updated_at": audit_request.updated_at.isoformat()
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to retrieve request: {str(e)}")


def _serialize_validation_summary(validation_result: Any) -> Optional[Dict[str, Any]]:
    if not validation_result:
        return None

    status_value = getattr(validation_result, "overall_validation_status", None)
    if hasattr(status_value, "value"):
        status_value = status_value.value

    return {
        "total_items": int(getattr(validation_result, "total_evidence_items", 0) or 0),
        "sufficient_items": int(getattr(validation_result, "sufficient_items", 0) or 0),
        "overall_sufficiency": float(getattr(validation_result, "overall_sufficiency_score", 0.0) or 0.0),
        "status": str(status_value or "insufficient"),
        "confidence": float(getattr(validation_result, "average_confidence_score", 0.0) or 0.0),
        "recommendations": list(getattr(validation_result, "gap_recommendations", []) or []),
    }


def _serialize_conclusion_summary(conclusion: Any, metadata: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    if not conclusion:
        return None

    findings: List[Dict[str, Any]] = []
    for finding in list(getattr(conclusion, "key_findings", []) or []):
        findings.append(
            {
                "title": getattr(finding, "description", "") or getattr(finding, "title", ""),
                "description": getattr(finding, "description", ""),
                "severity": getattr(finding, "severity", "medium"),
            }
        )

    return {
        "key_findings": findings,
        "overall_assessment": str(getattr(conclusion, "overall_assessment", "") or ""),
        "confidence": float(getattr(conclusion, "average_ai_confidence_score", 0.0) or 0.0),
        "coverage": float(getattr(conclusion, "evidence_coverage", 0.0) or 0.0),
        "recommendations": list(getattr(conclusion, "recommendations", []) or []),
        "report_sections": (
            metadata.get("model_report_sections", {})
            if isinstance(metadata, dict)
            else {}
        ),
    }


@app.get("/api/requests/{request_id}/workflow-outputs")
def get_workflow_outputs(request_id: str):
    """Return persisted validation, conclusion, and Bedrock outputs for a request."""
    try:
        audit_request = workflow_orchestrator.get_request(request_id)
        if not audit_request:
            raise HTTPException(404, f"Request {request_id} not found")

        context = workflow_orchestrator.get_context(request_id)
        metadata = context.execution_metadata if context else {}

        validation = _serialize_validation_summary(audit_request.validation_result)
        conclusion = _serialize_conclusion_summary(audit_request.conclusion, metadata=metadata if isinstance(metadata, dict) else None)

        bedrock_summary = metadata.get("bedrock_summary") if isinstance(metadata, dict) else None

        if not bedrock_summary and validation and conclusion:
            validation_summary = {
                "overall_sufficiency_score": validation.get("overall_sufficiency"),
                "confidence": validation.get("confidence"),
                "overall_validation_status": validation.get("status"),
                "gap_recommendations": validation.get("recommendations", []),
            }
            conclusion_summary = {
                "overall_assessment": conclusion.get("overall_assessment"),
                "confidence": conclusion.get("confidence"),
                "coverage": conclusion.get("coverage"),
                "recommendations": conclusion.get("recommendations", []),
                "key_findings": [
                    {
                        "description": finding.get("description", ""),
                        "severity": finding.get("severity", "medium"),
                    }
                    for finding in conclusion.get("key_findings", [])
                ],
            }
            bedrock_summary = summarize_with_bedrock(
                request_id=request_id,
                request_text=audit_request.request_text,
                evidence_items=(context.evidence_collected if context else []),
                validation_summary=validation_summary,
                conclusion_summary=conclusion_summary,
            )
            if isinstance(metadata, dict):
                metadata["bedrock_summary"] = bedrock_summary
                workflow_orchestrator._persist_request(request_id)

        return {
            "success": True,
            "request_id": request_id,
            "validation": validation,
            "conclusion": conclusion,
            "bedrock_summary": bedrock_summary,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to retrieve workflow outputs: {str(e)}")


@app.delete("/api/requests/{request_id}/permanent")
def permanently_delete_request(request_id: str):
    """Permanently delete a request, its persisted workflow state, and its evidence folder(s)."""
    try:
        removed_state = workflow_orchestrator.delete_request_permanently(request_id)

        removed_folders: List[str] = []

        # Canonical request folder path from orchestrator resolution.
        canonical_dir = workflow_orchestrator._request_evidence_dir(request_id=request_id, project_name=None)
        if os.path.isdir(canonical_dir):
            shutil.rmtree(canonical_dir, ignore_errors=True)
            removed_folders.append(canonical_dir)

        # Cleanup for any historical duplicate project folders containing the same request ID.
        if os.path.isdir(AUTOMATIC_EVIDENCE_DIR):
            for project_name in os.listdir(AUTOMATIC_EVIDENCE_DIR):
                candidate = os.path.join(AUTOMATIC_EVIDENCE_DIR, project_name, request_id)
                if os.path.isdir(candidate) and candidate not in removed_folders:
                    shutil.rmtree(candidate, ignore_errors=True)
                    removed_folders.append(candidate)

        return {
            "success": True,
            "request_id": request_id,
            "removed_state": removed_state,
            "removed_evidence_folders": removed_folders,
        }
    except Exception as e:
        raise HTTPException(500, f"Failed to permanently delete request: {str(e)}")


@app.get("/api/requests/{request_id}/status")
def get_workflow_status(request_id: str):
    """Get current workflow status and progress."""
    
    try:
        status = workflow_orchestrator.get_workflow_status(request_id)
        if "error" in status:
            raise HTTPException(404, status["error"])

        # Keep status evidence count aligned with /evidence-items inventory logic.
        # This guarantees the dashboard card count matches the modal list.
        try:
            inventory = _collect_request_evidence_inventory(request_id)
            status["evidence_count"] = len(inventory)
        except HTTPException:
            raise
        except Exception:
            # Preserve original status payload if inventory sync fails.
            pass
        
        return {
            "success": True,
            "status": status
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to retrieve status: {str(e)}")


@app.get("/api/requests/{request_id}/step-logs")
def get_step_logs(request_id: str):
    """Get all step logs for complete process traceability."""
    
    try:
        step_logs = workflow_orchestrator.get_step_logs(request_id)

        def _read_log(log: Any, key: str, default: Any = None) -> Any:
            if isinstance(log, dict):
                return log.get(key, default)
            return getattr(log, key, default)

        def _read_confidence(log: Any) -> float:
            raw = _read_log(log, "confidence_score", None)
            if raw is None:
                return 0.0
            try:
                return float(raw)
            except (TypeError, ValueError):
                return 0.0
        
        return {
            "success": True,
            "request_id": request_id,
            "step_count": len(step_logs),
            "steps": [
                {
                    "step_id": _read_log(log, "step_id"),
                    "step_name": _read_log(log, "step_name"),
                    "agent_name": _read_log(log, "agent_name"),
                    "request_id": _read_log(log, "request_id", request_id),
                    "timestamp": _read_log(log, "timestamp"),
                    "status": _read_log(log, "status", "in_progress"),
                    "action_taken": _read_log(log, "action_taken", "No action recorded"),
                    "inputs": _read_log(log, "inputs", []),
                    "outputs": _read_log(log, "outputs", []),
                    "error_message": _read_log(log, "error_message"),
                    "confidence_score": _read_confidence(log),
                    "execution_time_ms": _read_log(log, "execution_time_ms", 0)
                }
                for log in step_logs
            ]
        }
    except Exception as e:
        raise HTTPException(500, f"Failed to retrieve step logs: {str(e)}")


def _read_evidence_field(item: Any, key: str, default: Any = None) -> Any:
    if isinstance(item, dict):
        return item.get(key, default)
    return getattr(item, key, default)


def _extract_version_rank(filename: str) -> int:
    text = str(filename or "").lower()
    matches = re.findall(r"(?:^|[\s._-])(v|ver|version|rev|r)(\d{1,3})(?:$|[\s._-])", text)
    if not matches:
        return 0
    try:
        return max(int(number) for _, number in matches)
    except Exception:
        return 0


def _logical_filename_key(filename: str, file_type: str) -> str:
    base = os.path.splitext(str(filename or ""))[0].lower()
    base = re.sub(r"[\(\[]\s*(copy|final|draft|rev(?:ision)?|v(?:ersion)?\s*\d+)\s*[\)\]]", " ", base)
    base = re.sub(r"(?:^|[\s._-])(copy|final|draft|rev(?:ision)?|v(?:ersion)?\s*\d+|v\d+|r\d+)(?:$|[\s._-])", " ", base)
    base = re.sub(r"\d+$", "", base)
    base = re.sub(r"[^a-z0-9]+", " ", base).strip()
    if not base:
        base = str(filename or "").lower().strip()
    return f"{base}|{str(file_type or '').lower().strip()}"


def _source_priority(source: str) -> int:
    normalized = str(source or "").lower()
    if "validation" in normalized or "bedrock" in normalized:
        return 5
    if "upload" in normalized:
        return 4
    if "retriev" in normalized or "collection" in normalized:
        return 3
    if "persisted" in normalized:
        return 2
    if "folder_scan" in normalized:
        return 1
    return 0


def _candidate_rank(record: Dict[str, Any]) -> tuple:
    path = str(record.get("storage_path") or "")
    preview = str(record.get("content_preview") or "")
    source = str(record.get("source") or "")
    filename = str(record.get("filename") or "")
    version_rank = _extract_version_rank(filename)
    has_path = 1 if path and os.path.isfile(path) else 0
    has_preview = 1 if preview.strip() else 0
    preview_len = len(preview.strip())
    return (
        has_path,
        _source_priority(source),
        has_preview,
        version_rank,
        preview_len,
    )


def _read_request_folder_inventory(context: Any, request_id: str) -> List[Dict[str, Any]]:
    candidates: List[str] = []
    metadata = (context.execution_metadata if context else {}) or {}
    request_dir = str(metadata.get("request_evidence_dir") or "").strip()
    if request_dir:
        candidates.append(request_dir)

    try:
        fallback_dir = workflow_orchestrator._request_evidence_dir(request_id=request_id, project_name=None)
        if fallback_dir:
            candidates.append(str(fallback_dir))
    except Exception:
        pass

    # Legacy local fallback for historical runs that used .local_evidence.
    backend_local_evidence_dir = os.path.join(os.path.dirname(__file__), ".local_evidence", request_id)
    if os.path.isdir(backend_local_evidence_dir):
        candidates.append(backend_local_evidence_dir)

    workspace_local_evidence_dir = os.path.join(".local_evidence", request_id)
    if os.path.isdir(workspace_local_evidence_dir):
        candidates.append(workspace_local_evidence_dir)

    # Broaden search: scan every project subfolder of AUTOMATIC_EVIDENCE_DIR
    # for a subdirectory matching request_id. This handles cases where the
    # project name at upload time differs from what is inferred at query time.
    try:
        if os.path.isdir(AUTOMATIC_EVIDENCE_DIR):
            for project_entry in os.listdir(AUTOMATIC_EVIDENCE_DIR):
                candidate = os.path.join(AUTOMATIC_EVIDENCE_DIR, project_entry, request_id)
                if os.path.isdir(candidate):
                    candidates.append(candidate)
    except Exception:
        pass

    folder_inventory: List[Dict[str, Any]] = []
    seen_paths: set[str] = set()

    for root in candidates:
        if not root or not os.path.isdir(root):
            continue

        for dirpath, _, filenames in os.walk(root):
            for filename in sorted(filenames):
                path = os.path.join(dirpath, filename)
                normalized = os.path.normcase(os.path.abspath(path))
                if normalized in seen_paths:
                    continue
                seen_paths.add(normalized)

                file_type = os.path.splitext(filename)[1].lstrip(".")
                folder_inventory.append(
                    {
                        "filename": filename,
                        "storage_path": path,
                        "file_type": file_type,
                        "content_preview": "",
                        "source": "request_folder_scan",
                    }
                )

    return folder_inventory


def _read_persisted_context_evidence_inventory(request_id: str) -> List[Dict[str, Any]]:
    """Best-effort recovery of evidence inventory from raw persisted JSON context."""
    try:
        request_state_path = workflow_orchestrator._request_file_path(request_id)
        if not os.path.isfile(request_state_path):
            return []

        with open(request_state_path, "r", encoding="utf-8-sig") as handle:
            payload = json.load(handle)

        context_payload = payload.get("context") if isinstance(payload, dict) else {}
        if not isinstance(context_payload, dict):
            return []

        evidence_entries = context_payload.get("evidence_collected")
        if not isinstance(evidence_entries, list):
            return []

        recovered: List[Dict[str, Any]] = []
        for idx, item in enumerate(evidence_entries, start=1):
            if not isinstance(item, dict):
                continue

            filename = str(
                item.get("filename")
                or item.get("file_name")
                or item.get("name")
                or ""
            ).strip()
            storage_path = str(item.get("storage_path") or item.get("path") or "").strip()

            if not filename and storage_path:
                filename = os.path.basename(storage_path)
            if not filename:
                filename = f"evidence_{idx}"

            file_type = str(item.get("file_type") or "").strip()
            if not file_type and filename:
                file_type = os.path.splitext(filename)[1].lstrip(".")

            evidence_id = str(item.get("evidence_id") or "").strip()
            if not evidence_id:
                fingerprint = os.path.normcase(os.path.abspath(storage_path)) if storage_path else filename.lower()
                derived_id = hashlib.sha1(fingerprint.encode("utf-8")).hexdigest()[:12].upper()
                evidence_id = f"EVID-{derived_id}"

            content_preview = str(item.get("content_preview") or item.get("preview") or "")
            if not content_preview:
                content_preview = str(item.get("extracted_text") or "")[:500]

            recovered.append(
                {
                    "evidence_id": evidence_id,
                    "filename": filename,
                    "storage_path": storage_path,
                    "file_type": file_type,
                    "content_preview": content_preview,
                    "source": str(item.get("source") or "persisted_context"),
                }
            )

        return recovered
    except Exception:
        return []


def _collect_request_evidence_inventory(request_id: str) -> List[Dict[str, Any]]:
    audit_request = workflow_orchestrator.get_request(request_id)
    if not audit_request:
        raise HTTPException(404, f"Request {request_id} not found")

    context = workflow_orchestrator.get_context(request_id)

    # Build from authoritative in-memory/persisted sources first.
    # The folder scan is a last-resort fallback only used when neither
    # authoritative source has items — this eliminates cross-source duplicates
    # because all files for a request live in a single folder.
    authoritative: List[Any] = []
    authoritative.extend(list((context.evidence_collected if context else []) or []))
    if audit_request.validation_result and audit_request.validation_result.evidence_items:
        authoritative.extend(list(audit_request.validation_result.evidence_items))
    authoritative.extend(list(getattr(audit_request, "evidence_items", []) or []))

    raw_items: List[Any] = authoritative if authoritative else _read_request_folder_inventory(context, request_id)
    if not raw_items:
        raw_items = _read_persisted_context_evidence_inventory(request_id)

    premerged: List[Dict[str, Any]] = []
    seen_paths: set[str] = set()

    for idx, item in enumerate(raw_items, start=1):
        filename = str(_read_evidence_field(item, "filename", "") or "").strip() or f"evidence_{idx}"
        storage_path = str(_read_evidence_field(item, "storage_path", "") or "").strip()
        file_type = str(_read_evidence_field(item, "file_type", "") or "").strip()
        content_preview = str(_read_evidence_field(item, "content_preview", "") or "")
        source = str(_read_evidence_field(item, "source", "") or "")

        path_key = os.path.normcase(os.path.abspath(storage_path)) if storage_path else ""
        name_key = filename.lower()

        if path_key and path_key in seen_paths:
            continue

        if path_key:
            seen_paths.add(path_key)

        if not file_type and filename:
            file_type = os.path.splitext(filename)[1].lstrip(".")

        premerged.append(
            {
                "filename": filename,
                "storage_path": storage_path,
                "file_type": file_type,
                "content_preview": content_preview,
                "source": source,
                "_name_key": name_key,
                "_logical_key": _logical_filename_key(filename, file_type),
                "_existing_id": str(_read_evidence_field(item, "evidence_id", "") or "").strip(),
            }
        )

    # Keep all collected/uploaded files visible; dedupe only exact duplicates.
    # Do not collapse versioned filenames, as each uploaded/retrieved file
    # should remain visible in evidence inventory.
    merged: List[Dict[str, Any]] = []
    seen_fingerprints: set[str] = set()
    for record in premerged:
        filename = str(record.get("filename") or "")
        storage_path = str(record.get("storage_path") or "")
        file_type = str(record.get("file_type") or "")
        source = str(record.get("source") or "")
        content_preview = str(record.get("content_preview") or "")
        name_key = str(record.get("_name_key") or filename.lower())
        path_key = os.path.normcase(os.path.abspath(storage_path)) if storage_path else ""

        fingerprint = path_key or f"{name_key}:{file_type.lower()}"
        if fingerprint in seen_fingerprints:
            continue
        seen_fingerprints.add(fingerprint)

        existing_id = str(record.get("_existing_id") or "").strip()
        derived_id = hashlib.sha1(fingerprint.encode("utf-8")).hexdigest()[:12].upper()
        evidence_id = existing_id or f"EVID-{derived_id}"

        merged.append(
            {
                "evidence_id": evidence_id,
                "filename": filename,
                "storage_path": storage_path,
                "file_type": file_type,
                "content_preview": content_preview,
                "source": source,
            }
        )

    return merged


def _get_request_evidence_item(request_id: str, evidence_id: str) -> Any:
    inventory = _collect_request_evidence_inventory(request_id)

    for item in inventory:
        if str(_read_evidence_field(item, "evidence_id", "")) == evidence_id:
            return item

    raise HTTPException(404, f"Evidence {evidence_id} not found for request {request_id}")


def _extract_relevance_terms(audit_request: Any, context: Any) -> List[str]:
    raw_terms: List[str] = []

    def _append_text(value: Any) -> None:
        if value is None:
            return
        raw_terms.extend(re.findall(r"[a-z0-9][a-z0-9_-]{2,}", str(value).lower()))

    _append_text(getattr(audit_request, "request_text", ""))
    _append_text(getattr(audit_request, "request_category", ""))

    interpretation = getattr(audit_request, "interpretation", None) or getattr(context, "interpretation", None)
    tasks = list(getattr(interpretation, "interpreted_tasks", []) or [])
    for task in tasks:
        _append_text(getattr(task, "task_description", ""))
        for keyword in list(getattr(task, "keywords", []) or []):
            _append_text(keyword)
        for evidence_type in list(getattr(task, "required_evidence_types", []) or []):
            _append_text(evidence_type)

    deduped_terms: List[str] = []
    seen = set()
    for term in raw_terms:
        cleaned = term.strip().lower()
        if len(cleaned) < 3 or cleaned in RELEVANCE_STOPWORDS:
            continue
        if cleaned in seen:
            continue
        seen.add(cleaned)
        deduped_terms.append(cleaned)

    return deduped_terms


def _partition_relevant_uploaded_evidence(
    inventory: List[Dict[str, Any]],
    audit_request: Any,
    context: Any,
) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    terms = _extract_relevance_terms(audit_request, context)

    # If request context is too small, avoid false negatives and keep all files.
    if len(terms) < 4:
        for item in inventory:
            item["request_relevance_score"] = 1.0
            item["request_relevance_matches"] = terms
        return inventory, []

    accepted: List[Dict[str, Any]] = []
    rejected: List[Dict[str, Any]] = []

    for item in inventory:
        text_blob = " ".join(
            [
                str(item.get("filename") or ""),
                str(item.get("content_preview") or ""),
                str(item.get("extracted_text") or "")[:6000],
                " ".join(str(x) for x in list(item.get("key_findings") or [])),
            ]
        ).lower()

        matches = [term for term in terms if term in text_blob]
        parser_score = float(item.get("relevance_score") or 0.0)
        request_relevance_score = min(1.0, (len(matches) * 0.15) + (parser_score * 0.35))

        item["request_relevance_score"] = request_relevance_score
        item["request_relevance_matches"] = matches[:20]

        is_relevant = (
            len(matches) >= 2
            or (len(matches) >= 1 and parser_score >= 0.6)
            or request_relevance_score >= 0.55
        )

        if is_relevant:
            accepted.append(item)
        else:
            rejected.append(item)

    return accepted, rejected


def _is_office_preview_file(filename: str, file_type: str = "") -> bool:
    extension = os.path.splitext(str(filename or "").lower())[1]
    normalized_type = str(file_type or "").strip().lower()

    if extension in OFFICE_PREVIEW_EXTENSIONS:
        return True

    if normalized_type and not normalized_type.startswith("."):
        normalized_type = f".{normalized_type}"

    return normalized_type in OFFICE_PREVIEW_EXTENSIONS


def _resolve_soffice_binary() -> Optional[str]:
    configured_path = os.getenv("SOFFICE_PATH", "").strip()
    if configured_path and os.path.isfile(configured_path):
        return configured_path

    for candidate in ["soffice", "soffice.exe"]:
        resolved = shutil.which(candidate)
        if resolved:
            return resolved

    return None


def _convert_office_to_pdf(file_path: str, request_id: str, evidence_id: str) -> str:
    if not os.path.isfile(file_path):
        raise HTTPException(404, f"Evidence file is unavailable on disk for {evidence_id}")

    soffice_bin = _resolve_soffice_binary()
    if not soffice_bin:
        raise HTTPException(
            503,
            "Office preview conversion is not available because LibreOffice was not found. Install LibreOffice and/or set SOFFICE_PATH.",
        )

    cache_dir = os.path.join(os.path.dirname(__file__), ".system", "preview_cache", request_id)
    os.makedirs(cache_dir, exist_ok=True)

    output_pdf_path = os.path.join(cache_dir, f"{evidence_id}.pdf")
    source_mtime = os.path.getmtime(file_path)
    if os.path.isfile(output_pdf_path):
        cached_mtime = os.path.getmtime(output_pdf_path)
        if cached_mtime >= source_mtime:
            return output_pdf_path

    command = [
        soffice_bin,
        "--headless",
        "--nologo",
        "--nolockcheck",
        "--nodefault",
        "--norestore",
        "--convert-to",
        "pdf",
        "--outdir",
        cache_dir,
        file_path,
    ]

    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(504, "Timed out while converting Office file for browser preview") from exc
    except Exception as exc:
        raise HTTPException(500, f"Failed to start Office preview conversion: {str(exc)}") from exc

    if result.returncode != 0:
        details = (result.stderr or result.stdout or "Conversion process failed").strip()
        raise HTTPException(500, f"Office preview conversion failed: {details}")

    source_stem = os.path.splitext(os.path.basename(file_path))[0]
    expected_output_path = os.path.join(cache_dir, f"{source_stem}.pdf")

    if os.path.isfile(expected_output_path) and expected_output_path != output_pdf_path:
        try:
            shutil.move(expected_output_path, output_pdf_path)
        except Exception:
            shutil.copy2(expected_output_path, output_pdf_path)

    if not os.path.isfile(output_pdf_path):
        if os.path.isfile(expected_output_path):
            return expected_output_path
        raise HTTPException(500, "Office preview conversion did not produce a PDF output")

    return output_pdf_path


@app.get("/api/requests/{request_id}/evidence-items")
def get_request_evidence_items(request_id: str):
    """List evidence inventory for a request so the UI can link Bedrock references to real files."""
    try:
        items = _collect_request_evidence_inventory(request_id)

        return {
            "success": True,
            "request_id": request_id,
            "count": len(items),
            "items": items,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to list evidence items: {str(e)}")


@app.get("/api/requests/{request_id}/evidence/{evidence_id}/preview")
def preview_request_evidence_file(request_id: str, evidence_id: str):
    """Return evidence file as inline content for browser preview."""
    try:
        item = _get_request_evidence_item(request_id, evidence_id)
        file_path = str(_read_evidence_field(item, "storage_path", "") or "")
        filename = str(_read_evidence_field(item, "filename", "evidence.bin"))
        file_type = str(_read_evidence_field(item, "file_type", "") or "")

        if not file_path or not os.path.isfile(file_path):
            raise HTTPException(404, f"Evidence file is unavailable on disk for {evidence_id}")

        response_path = file_path
        response_filename = filename
        response_media_type = None

        normalized_extension = os.path.splitext(filename)[1].lower()
        normalized_type = file_type.strip().lower()

        if normalized_extension == ".msg" or normalized_type == "msg":
            parsed_item = item
            extracted_text = str(_read_evidence_field(parsed_item, "extracted_text", "") or "").strip()
            if not extracted_text:
                try:
                    parsed_item = parse_evidence_file(file_path, source="preview")
                    extracted_text = str(parsed_item.get("extracted_text") or "").strip()
                except Exception:
                    extracted_text = ""

            if not extracted_text:
                extracted_text = "No readable email content could be extracted from this Outlook message."

            safe_basename = os.path.splitext(filename)[0].replace('"', "")
            safe_filename = f"{safe_basename}.txt"
            return PlainTextResponse(
                content=extracted_text,
                media_type="text/plain; charset=utf-8",
                headers={"Content-Disposition": f'inline; filename="{safe_filename}"'},
            )

        if _is_office_preview_file(filename, file_type):
            response_path = _convert_office_to_pdf(file_path, request_id, evidence_id)
            response_filename = f"{os.path.splitext(filename)[0]}.pdf"
            response_media_type = "application/pdf"

        media_type, _ = mimetypes.guess_type(response_filename)
        safe_filename = response_filename.replace('"', "")
        headers = {"Content-Disposition": f'inline; filename="{safe_filename}"'}

        return FileResponse(
            path=response_path,
            media_type=response_media_type or media_type or "application/octet-stream",
            headers=headers,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to preview evidence: {str(e)}")


@app.get("/api/requests/{request_id}/evidence/{evidence_id}/download")
def download_request_evidence_file(request_id: str, evidence_id: str):
    """Return evidence file as attachment for download."""
    try:
        item = _get_request_evidence_item(request_id, evidence_id)
        file_path = str(_read_evidence_field(item, "storage_path", "") or "")
        filename = str(_read_evidence_field(item, "filename", "evidence.bin"))

        if not file_path or not os.path.isfile(file_path):
            raise HTTPException(404, f"Evidence file is unavailable on disk for {evidence_id}")

        media_type, _ = mimetypes.guess_type(filename)
        return FileResponse(
            path=file_path,
            filename=filename,
            media_type=media_type or "application/octet-stream",
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to download evidence: {str(e)}")


@app.post("/api/requests/{request_id}/evidence/upload")
def upload_evidence_only(
    request_id: str,
    files: List[UploadFile] = File(...)
):
    """Upload evidence files only.

    Validation and conclusion are intentionally separate workflow calls:
    - POST /api/requests/{request_id}/validate
    - POST /api/requests/{request_id}/conclude
    """

    # Accept both legacy IDs (REQ-001) and project-scoped IDs (PROJECT-REQ-001).
    if not re.match(r"^[A-Z0-9]+-REQ-\d{3}$", request_id) and not re.match(r"^REQ-\d{3}$", request_id):
        raise HTTPException(400, "Invalid request ID")

    audit_request = workflow_orchestrator.get_request(request_id)
    context = workflow_orchestrator.get_context(request_id)
    if not audit_request or not context:
        raise HTTPException(
            status_code=404,
            detail=(
                "Request not found in the active backend session. "
                "Recreate or reopen the request after the backend is running, then upload again."
            ),
        )

    def evidence_fingerprint(item: Dict[str, Any]) -> str:
        """Create a stable fingerprint to avoid duplicate evidence entries."""
        storage_path = item.get("storage_path") or item.get("s3_uri") or item.get("path")
        if storage_path:
            return str(storage_path)
        filename = item.get("filename", "unknown")
        file_size = item.get("file_size_bytes", "")
        request_scope = item.get("request_id", request_id)
        return f"{request_scope}:{filename}:{file_size}"

    try:
        context_project = str((context.execution_metadata or {}).get("project_name") or "default")
        inventory, collection_logs = save_uploaded_files(
            request_id=request_id,
            files=files,
            project_name=context_project,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    accepted_inventory, rejected_inventory = _partition_relevant_uploaded_evidence(
        inventory=inventory,
        audit_request=audit_request,
        context=context,
    )

    rejected_files = [str(item.get("filename") or "Unknown file") for item in rejected_inventory]
    accepted_files = [str(item.get("filename") or "Unknown file") for item in accepted_inventory]

    for rejected_item in rejected_inventory:
        rejected_path = str(rejected_item.get("storage_path") or "").strip()
        if rejected_path and os.path.isfile(rejected_path):
            try:
                os.remove(rejected_path)
            except OSError:
                pass

    if rejected_files:
        collection_logs.append(
            log_step(
                agent="collection_agent",
                request_id=request_id,
                message=(
                    "Rejected unrelated evidence files for this request: "
                    + ", ".join(rejected_files)
                ),
            )
        )

    existing_evidence = list(context.evidence_collected or [])

    merged_evidence: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for evidence_item in [*existing_evidence, *accepted_inventory]:
        key = evidence_fingerprint(evidence_item)
        if key in seen:
            continue
        seen.add(key)
        merged_evidence.append(evidence_item)

    s3_bucket = os.getenv("S3_EVIDENCE_BUCKET")
    if s3_bucket:
        try:
            s3_region = os.getenv("AWS_REGION")
            inventory_with_s3, s3_logs = copy_inventory_to_s3(
                request_id=request_id,
                evidence_inventory=accepted_inventory,
                bucket_name=s3_bucket,
                region_name=s3_region,
            )
            collection_logs = collection_logs + s3_logs
            accepted_inventory = inventory_with_s3
        except RuntimeError:
            pass  # Continue with local storage if S3 fails

    upload_step_log = log_workflow_step(
        step_name="Evidence Upload",
        agent_name="collection_agent",
        request_id=request_id,
        action_taken=(
            "Uploaded evidence files, accepted request-relevant files, rejected unrelated files, "
            "merged accepted evidence with existing request memory, and re-ran the workflow"
        ),
        inputs=[
            create_step_input("files_uploaded", [item.get("filename") for item in inventory]),
            create_step_input("accepted_files", accepted_files),
            create_step_input("rejected_files", rejected_files),
            create_step_input("uploaded_file_count", len(inventory)),
            create_step_input("accepted_file_count", len(accepted_inventory)),
            create_step_input("rejected_file_count", len(rejected_inventory)),
            create_step_input("existing_evidence_count", len(existing_evidence)),
        ],
        outputs=[
            create_step_output("newly_parsed_items", len(accepted_inventory)),
            create_step_output("rejected_unrelated_items", len(rejected_inventory)),
            create_step_output("total_evidence_items_available", len(merged_evidence)),
            create_step_output("current_stage", WorkflowStage.RETRIEVAL.value),
        ],
        confidence_score=0.95,
    )

    context.evidence_collected = merged_evidence
    audit_request.current_stage = WorkflowStage.RETRIEVAL
    audit_request.updated_at = datetime.utcnow()
    audit_request.step_logs.append(upload_step_log)
    context.step_logs.append(upload_step_log)
    workflow_orchestrator._persist_request(request_id)

    return {
        "success": True,
        "request_id": request_id,
        "stage": audit_request.current_stage.value,
        "uploaded_count": len(accepted_inventory),
        "rejected_count": len(rejected_inventory),
        "accepted_files": accepted_files,
        "rejected_files": rejected_files,
        "total_evidence_items": len(merged_evidence),
        "items": merged_evidence[:5],
        "collection_logs": collection_logs,
        "step_log": upload_step_log,
    }


# ============================================================================
# HEALTH CHECK
# ============================================================================

@app.get("/health")
def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "service": "EviDex Backend",
        "version": "1.0.0",
        "conversation_service": "available" if conversation_manager else "unavailable"
    }


@app.get("/health/bedrock")
def bedrock_health_check():
    """Bedrock configuration and diagnostic endpoint."""
    region = os.getenv("AWS_REGION", "us-east-1")
    explicit_creds = _resolve_explicit_credentials(region)
    tls_info = get_bedrock_tls_debug_info()
    
    # Check environment variables
    bedrock_access_key = os.getenv("BEDROCK_AWS_ACCESS_KEY_ID", "")
    bedrock_secret = os.getenv("BEDROCK_AWS_SECRET_ACCESS_KEY", "")
    aws_access_key = os.getenv("AWS_ACCESS_KEY_ID", "")
    aws_secret = os.getenv("AWS_SECRET_ACCESS_KEY", "")
    
    return {
        "status": "healthy" if explicit_creds else "missing_credentials",
        "region": region,
        "tls_verify": {
            "source": tls_info.get("source", "unknown"),
            "configured": bool(tls_info.get("verify")),
        },
        "credentials": {
            "BEDROCK_AWS_ACCESS_KEY_ID": {
                "set": bool(bedrock_access_key),
                "is_placeholder": _is_placeholder_credential(bedrock_access_key),
                "preview": (bedrock_access_key[:6] + "..." + bedrock_access_key[-4:]) if len(bedrock_access_key) > 10 else "not_set",
            },
            "BEDROCK_AWS_SECRET_ACCESS_KEY": {
                "set": bool(bedrock_secret),
                "is_placeholder": _is_placeholder_credential(bedrock_secret),
                "preview": ("***" + bedrock_secret[-4:]) if len(bedrock_secret) > 4 else "not_set",
            },
            "AWS_ACCESS_KEY_ID": {
                "set": bool(aws_access_key),
                "is_placeholder": _is_placeholder_credential(aws_access_key),
                "preview": (aws_access_key[:6] + "..." + aws_access_key[-4:]) if len(aws_access_key) > 10 else "not_set",
            },
            "AWS_SECRET_ACCESS_KEY": {
                "set": bool(aws_secret),
                "is_placeholder": _is_placeholder_credential(aws_secret),
                "preview": ("***" + aws_secret[-4:]) if len(aws_secret) > 4 else "not_set",
            },
        },
        "resolved_credentials": bool(explicit_creds),
        "note": "If credentials are missing or invalid, add real AWS credentials to test_bedrock.py or set environment variables.",
    }



@app.get("/")
def root():
    """Root endpoint with API documentation."""
    return {
        "message": "EviDex Backend - Audit Evidence Collection & Validation",
        "version": "1.0.0",
        "endpoints": {
            "workflow": {
                "POST /api/requests": "Initialize new audit request",
                "POST /api/requests/{id}/interpret": "Interpret audit request",
                "POST /api/requests/{id}/retrieve": "Retrieve evidence",
                "POST /api/requests/{id}/validate": "Validate evidence",
                "POST /api/requests/{id}/conclude": "Generate conclusion"
            },
            "approval": {
                "POST /api/requests/{id}/submit-for-approval": "Submit for approval",
                "POST /api/requests/{id}/approve": "Approve request",
                "POST /api/requests/{id}/reject": "Reject request",
                "POST /api/requests/{id}/request-revision": "Request revision"
            },
            "conversation": {
                "POST /api/conversations/create": "Create conversation",
                "POST /api/conversations/{id}/messages": "Send message",
                "GET /api/conversations/{id}": "Get conversation"
            },
            "data": {
                "GET /api/requests/{id}": "Get request details",
                "GET /api/requests/{id}/status": "Get workflow status",
                "GET /api/requests/{id}/step-logs": "Get step logs"
            }
        }
    }


@app.post("/api/debug/reset-all")
def debug_reset_all():
    """
    DANGER: Resets all backend state to 'scratch'.
    Deletes all requests, resets counters, and clears audit logs.
    """
    try:
        system_dir = os.path.join(os.path.dirname(__file__), ".system")
        requests_dir = os.path.join(system_dir, "requests")
        counter_file = os.path.join(system_dir, "request_counter.json")
        audit_log_file = os.path.join(system_dir, "audit_logs")

        # 1. Clear requests folder
        if os.path.exists(requests_dir):
            for f in os.listdir(requests_dir):
                fpath = os.path.join(requests_dir, f)
                if os.path.isfile(fpath):
                    os.remove(fpath)
                elif os.path.isdir(fpath):
                    shutil.rmtree(fpath)
        
        # 2. Reset counter
        with open(counter_file, "w") as f:
            json.dump({"projects": {}, "last_request_number": 0}, f, indent=2)

        # 3. Truncate audit logs
        if os.path.exists(audit_log_file):
            with open(audit_log_file, "w") as f:
                f.write("")

        return {"success": True, "message": "Backend state reset successfully."}
    except Exception as e:
        raise HTTPException(500, f"Reset failed: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
