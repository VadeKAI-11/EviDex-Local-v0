"""
Workflow Orchestrator for Audit Evidence Collection and Validation

This module coordinates the entire audit workflow, managing transitions between
stages and maintaining complete traceability through structured step logging.

Workflow stages:
1. INITIALIZATION - Setup request and create execution context
2. INTERPRETATION - Parse audit request into actionable tasks
3. RETRIEVAL - Access folders and collect evidence
4. VALIDATION - Evaluate evidence and assign sufficiency scores
5. CONCLUSION - Generate findings and summary report
6. APPROVAL - Send to auditor for review and approval
7. EXPORTED - Final export of approved report
"""

from datetime import datetime
from typing import Dict, List, Any, Optional, Tuple
from uuid import uuid4
from threading import Lock
import time
import json
import os
import re
import shutil

_SYSTEM_REQUESTS_DIR = os.path.join(os.path.dirname(__file__), ".system", "requests")
from agents.request_id_generator import RequestIDGenerator

from models.schemas import (
    WorkflowStage,
    ValidationStatus,
    ApprovalStatus,
    WorkflowStepLog,
    AuditRequest,
    RequestInterpretation,
    EvidenceValidationResult,
    AuditConclusion,
    WorkflowExecutionContext,
)
from agents.reasoning_logger import StepLogger, log_workflow_step, create_step_input, create_step_output


def generate_evidence_id() -> str:
    """Generate a unique evidence ID."""
    return f"EV-{uuid4().hex[:12].upper()}"


class WorkflowOrchestrator:
    """
    Orchestrates the complete audit evidence workflow.
    
    Manages workflow state transitions, coordinates agent execution,
    maintains complete step logs, and ensures process traceability.
    """
    
    def __init__(self):
        self.contexts: Dict[str, WorkflowExecutionContext] = {}
        self.requests: Dict[str, AuditRequest] = {}
        self._request_locks: Dict[str, Lock] = {}
        self._request_locks_guard = Lock()
        self.request_id_generator = RequestIDGenerator()

    def _get_request_lock(self, request_id: str) -> Lock:
        with self._request_locks_guard:
            lock = self._request_locks.get(request_id)
            if lock is None:
                lock = Lock()
                self._request_locks[request_id] = lock
            return lock

    def _sanitize_folder_segment(self, value: str, fallback: str = "default") -> str:
        """Sanitize folder names for cross-platform filesystem safety."""
        raw = str(value or "").strip()
        cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", raw).strip("._-")
        return cleaned or fallback

    def _project_from_request_id(self, request_id: str) -> Optional[str]:
        match = re.match(r"^([A-Za-z0-9]+)-REQ-\d{3}$", str(request_id or "").strip())
        if not match:
            return None
        return match.group(1)

    def _resolve_project_name(self, request_id: str, project_name: Optional[str]) -> str:
        provided = str(project_name or "").strip()
        if provided and provided.lower() != "default":
            return self._sanitize_folder_segment(provided, fallback="default")

        inferred = self._project_from_request_id(request_id)
        if inferred:
            return self._sanitize_folder_segment(inferred, fallback="default")

        return "default"

    def _request_evidence_dir(self, request_id: str, project_name: Optional[str] = None) -> str:
        """Resolve canonical evidence folder path: EVIDENCE FILE/<request_id>."""
        from agents.collection_agent import AUTOMATIC_EVIDENCE_DIR

        return os.path.join(AUTOMATIC_EVIDENCE_DIR, request_id)

    def _request_scoped_source_dirs(self, request_id: str, project_name: Optional[str] = None) -> List[str]:
        """Return request-specific source folders under the automatic evidence root."""
        from agents.collection_agent import AUTOMATIC_EVIDENCE_DIR

        resolved_project = self._resolve_project_name(request_id=request_id, project_name=project_name)
        canonical_dir = os.path.join(AUTOMATIC_EVIDENCE_DIR, request_id)
        legacy_project_dir = os.path.join(AUTOMATIC_EVIDENCE_DIR, resolved_project, request_id)

        ordered_candidates = [canonical_dir, legacy_project_dir]
        existing = [path for path in ordered_candidates if os.path.isdir(path)]

        # Ensure there is always a request-specific drop folder available.
        if not existing:
            os.makedirs(canonical_dir, exist_ok=True)
            existing = [canonical_dir]

        deduped: List[str] = []
        seen = set()
        for path in existing:
            abs_path = os.path.abspath(path)
            if abs_path in seen:
                continue
            seen.add(abs_path)
            deduped.append(abs_path)
        return deduped

    def _evidence_signature(self, item: Dict[str, Any]) -> str:
        """Generate a stable signature for evidence deduplication across retrieval runs."""
        source_signature = str(item.get("source_signature") or "").strip()
        if source_signature:
            return source_signature.lower()

        filename = str(item.get("filename") or "").strip().lower()
        file_size = int(item.get("file_size_bytes") or 0)
        storage_path = str(item.get("storage_path") or "").strip()

        mtime = 0
        if storage_path and os.path.exists(storage_path):
            try:
                mtime = int(os.path.getmtime(storage_path))
            except OSError:
                mtime = 0

        return f"{filename}::{file_size}::{mtime}"

    def prepare_retrieval_folder(self, request_id: str) -> Dict[str, Any]:
        """Prepare request-specific evidence folder before retrieval starts."""
        self._ensure_loaded(request_id)
        context = self.contexts[request_id]
        project_name = str((context.execution_metadata or {}).get("project_name") or "default")

        request_dir = self._request_evidence_dir(request_id=request_id, project_name=project_name)
        root_dir = os.path.dirname(request_dir)

        root_already_exists = os.path.isdir(root_dir)
        request_already_exists = os.path.isdir(request_dir)

        if not root_already_exists:
            os.makedirs(root_dir, exist_ok=True)

        if not request_already_exists:
            os.makedirs(request_dir, exist_ok=True)

        context.execution_metadata["request_evidence_dir"] = request_dir
        self._persist_request(request_id)

        return {
            "stage": "pre_retrieval_folder_setup",
            "project_name": self._resolve_project_name(request_id=request_id, project_name=project_name),
            "project_dir": root_dir,
            "request_dir": request_dir,
            "project_already_exists": root_already_exists,
            "request_folder_already_exists": request_already_exists,
        }

    def _ensure_request_evidence_dir(self, request_id: str, project_name: Optional[str] = None) -> str:
        """Create request evidence directory if it does not exist."""
        target_dir = self._request_evidence_dir(request_id=request_id, project_name=project_name)
        os.makedirs(target_dir, exist_ok=True)
        return target_dir

    def _copy_evidence_into_request_dir(
        self,
        request_id: str,
        project_name: str,
        evidence_items: List[Dict[str, Any]],
    ) -> int:
        """Copy retrieved evidence files into project/request folder and repoint storage_path."""
        target_dir = self._ensure_request_evidence_dir(request_id=request_id, project_name=project_name)
        copied = 0

        for item in evidence_items:
            source_path = str(item.get("storage_path") or "").strip()
            if not source_path or not os.path.isfile(source_path):
                continue

            source_abs = os.path.abspath(source_path)
            target_abs = os.path.abspath(target_dir)
            if os.path.commonpath([source_abs, target_abs]) == target_abs:
                item["storage_path"] = source_abs
                item.setdefault("project_name", project_name)
                item.setdefault("request_evidence_dir", target_dir)
                continue

            filename = os.path.basename(source_abs)
            candidate = os.path.join(target_dir, filename)
            stem, ext = os.path.splitext(filename)
            suffix = 1

            while os.path.exists(candidate):
                try:
                    if os.path.samefile(candidate, source_abs):
                        break
                except OSError:
                    pass
                candidate = os.path.join(target_dir, f"{stem}_{suffix}{ext}")
                suffix += 1

            if not os.path.exists(candidate):
                shutil.copy2(source_abs, candidate)
                copied += 1

            item["original_storage_path"] = source_abs
            item["storage_path"] = candidate
            item.setdefault("source_origin", item.get("source", ""))
            item["source"] = target_dir
            item["project_name"] = project_name
            item["request_evidence_dir"] = target_dir

        return copied

    # ========================================================================
    # DISK PERSISTENCE HELPERS
    # ========================================================================

    def _request_file_path(self, request_id: str) -> str:
        return os.path.join(_SYSTEM_REQUESTS_DIR, f"{request_id}.json")

    def _persist_request(self, request_id: str) -> None:
        """Persist an AuditRequest + its context to disk so it survives restarts."""
        try:
            os.makedirs(_SYSTEM_REQUESTS_DIR, exist_ok=True)
            audit_request = self.requests.get(request_id)
            context = self.contexts.get(request_id)
            if audit_request is None:
                return
            data = {
                "request": audit_request.model_dump(mode="json"),
                "context": context.model_dump(mode="json") if context else None,
            }
            with open(self._request_file_path(request_id), "w", encoding="utf-8") as f:
                json.dump(data, f, default=str)
        except Exception:
            pass  # Persistence failures must never break the workflow

    def _load_from_disk(self, request_id: str) -> bool:
        """Load a persisted request + context from disk into memory. Returns True if loaded."""
        try:
            path = self._request_file_path(request_id)
            if not os.path.exists(path):
                return False
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.requests[request_id] = AuditRequest.model_validate(data["request"])
            if data.get("context"):
                self.contexts[request_id] = WorkflowExecutionContext.model_validate(data["context"])
            return True
        except Exception:
            return False

    def _ensure_loaded(self, request_id: str) -> None:
        """Ensure the request is in memory, loading from disk if needed. Raises ValueError if not found."""
        if request_id not in self.requests:
            if not self._load_from_disk(request_id):
                raise ValueError(f"Request {request_id} not found")

    def list_request_summaries(self) -> List[Dict[str, Any]]:
        """List persisted requests from disk/memory as normalized summaries."""
        os.makedirs(_SYSTEM_REQUESTS_DIR, exist_ok=True)
        summaries: List[Dict[str, Any]] = []

        for filename in os.listdir(_SYSTEM_REQUESTS_DIR):
            if not filename.lower().endswith(".json"):
                continue

            path = os.path.join(_SYSTEM_REQUESTS_DIR, filename)
            try:
                with open(path, "r", encoding="utf-8-sig") as handle:
                    payload = json.load(handle)

                request_payload = payload.get("request") or {}
                if not isinstance(request_payload, dict):
                    continue

                request_id = str(request_payload.get("request_id") or "").strip()
                if not request_id:
                    continue

                context_payload = payload.get("context") or {}
                if not isinstance(context_payload, dict):
                    context_payload = {}

                execution_metadata = context_payload.get("execution_metadata") or {}
                if not isinstance(execution_metadata, dict):
                    execution_metadata = {}

                project_name = str(execution_metadata.get("project_name") or "").strip()
                if not project_name:
                    step_logs = request_payload.get("step_logs") or []
                    if isinstance(step_logs, list):
                        for log in step_logs:
                            if not isinstance(log, dict):
                                continue
                            inputs = log.get("inputs") or []
                            if not isinstance(inputs, list):
                                continue
                            for entry in inputs:
                                if not isinstance(entry, dict):
                                    continue
                                if str(entry.get("key") or "").strip() != "project_name":
                                    continue
                                candidate = str(entry.get("value") or "").strip()
                                if candidate and candidate.lower() != "default":
                                    project_name = candidate
                                    break
                            if project_name:
                                break
                if not project_name:
                    project_name = self._resolve_project_name(request_id=request_id, project_name=None)

                summaries.append(
                    {
                        "request_id": request_id,
                        "request_text": str(request_payload.get("request_text") or ""),
                        "request_category": str(request_payload.get("request_category") or "general"),
                        "current_stage": str(request_payload.get("current_stage") or WorkflowStage.INITIALIZATION.value),
                        "approval_status": str(request_payload.get("approval_status") or ApprovalStatus.PENDING.value),
                        "created_at": str(request_payload.get("created_at") or ""),
                        "updated_at": str(request_payload.get("updated_at") or request_payload.get("created_at") or ""),
                        "auditor_email": str(request_payload.get("auditor_email") or ""),
                        "project_name": project_name,
                    }
                )
            except Exception:
                continue

        summaries.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        return summaries

    # ========================================================================
    # WORKFLOW INITIALIZATION
    # ========================================================================
    
    def initialize_request(
        self,
        auditor_id: str,
        auditor_email: str,
        request_text: str,
        request_category: str = "general",
        priority: str = "normal",
        project_name: str = "default"
    ) -> Tuple[AuditRequest, WorkflowStepLog]:
        """
        Initialize a new audit request and create execution context.
        
        Returns:
        - (AuditRequest, WorkflowStepLog): The created request and initialization log
        """
        
        with StepLogger(
            step_name="Initialization",
            agent_name="workflow_orchestrator",
            request_id="SYSTEM",
            confidence_score=1.0
        ) as logger:
            request_id = self.request_id_generator.generate(project_name)
            now = datetime.utcnow()
            
            # Log inputs
            logger.add_inputs_bulk({
                "auditor_id": auditor_id,
                "auditor_email": auditor_email,
                "request_text": request_text,
                "request_category": request_category,
                "project_name": project_name,
            })
            
            # Create audit request
            audit_request = AuditRequest(
                request_id=request_id,
                auditor_id=auditor_id,
                auditor_email=auditor_email,
                created_at=now,
                updated_at=now,
                request_text=request_text,
                request_category=request_category,
                current_stage=WorkflowStage.INITIALIZATION,
                priority=priority,
                tags=[]
            )
            
            # Create execution context
            context = WorkflowExecutionContext(
                request_id=request_id,
                current_stage=WorkflowStage.INITIALIZATION,
                step_logs=[],
                evidence_collected=[],
                approval_status=ApprovalStatus.PENDING,
                execution_metadata={
                    "auditor_id": auditor_id,
                    "auditor_email": auditor_email,
                    "project_name": project_name,
                }
            )

            # Register canonical request evidence path without eagerly creating
            # folders. Physical folder creation is deferred to backend write
            # operations (upload/copy) to reduce runtime overhead.
            request_evidence_dir = self._request_evidence_dir(
                request_id=request_id,
                project_name=project_name,
            )
            context.execution_metadata["request_evidence_dir"] = request_evidence_dir
            
            # Store in memory
            self.requests[request_id] = audit_request
            self.contexts[request_id] = context
            
            # Log outputs
            logger.add_outputs_bulk({
                "request_id": request_id,
                "stage": WorkflowStage.INITIALIZATION.value,
                "execution_context_created": True,
                "request_evidence_dir": request_evidence_dir,
            })
            
            step_log = logger.get_step_log()
            
            # Store step log
            audit_request.step_logs.append(step_log)
            context.step_logs.append(step_log)

            self._persist_request(request_id)

            return audit_request, step_log
    
    # ========================================================================
    # WORKFLOW STAGE: INTERPRETATION
    # ========================================================================
    
    def interpret_request(
        self,
        request_id: str,
        interpretation_handler  # Function to call for interpretation
    ) -> Tuple[RequestInterpretation, WorkflowStepLog]:
        """
        Move to INTERPRETATION stage and parse the audit request.
        
        Parameters:
        - request_id: The request being processed
        - interpretation_handler: Function(request_text) -> interpreted_tasks
        
        Returns:
        - (RequestInterpretation, WorkflowStepLog): Interpretation result and log
        """
        
        with self._get_request_lock(request_id):
            self._ensure_loaded(request_id)

            audit_request = self.requests[request_id]
            context = self.contexts[request_id]

            # Idempotency guard: if interpretation already exists, do not run it again.
            if audit_request.interpretation is not None:
                if audit_request.current_stage == WorkflowStage.INITIALIZATION:
                    audit_request.current_stage = WorkflowStage.INTERPRETATION
                    context.current_stage = WorkflowStage.INTERPRETATION
                    context.interpretation = audit_request.interpretation
                    audit_request.updated_at = datetime.utcnow()
                    self._persist_request(request_id)

                last_interpret_log = next(
                    (
                        log
                        for log in reversed(audit_request.step_logs)
                        if getattr(log, "step_name", "") == "Request Interpretation"
                    ),
                    audit_request.step_logs[-1],
                )
                return audit_request.interpretation, last_interpret_log

            with StepLogger(
                step_name="Request Interpretation",
                agent_name="interpretation_agent",
                request_id=request_id,
                confidence_score=0.8  # Will be updated with actual Bedrock confidence
            ) as logger:
                logger.add_input("request_text", audit_request.request_text)

                # Call interpretation handler
                interpretation_result = interpretation_handler(
                    request_text=audit_request.request_text
                )
                
                # Update confidence score with actual value from Bedrock model
                logger.confidence_score = interpretation_result.get("confidence", 0.8)

                interpretation_id = f"INTERP-{uuid4().hex[:12].upper()}"
                interpretation = RequestInterpretation(
                    interpretation_id=interpretation_id,
                    request_id=request_id,
                    timestamp=datetime.utcnow(),
                    original_request=audit_request.request_text,
                    interpreted_tasks=interpretation_result["tasks"],
                    interpretation_confidence=interpretation_result["confidence"],
                    required_data_sources=interpretation_result.get("data_sources", []),
                    interpretation_notes=interpretation_result.get("notes", "")
                )

                # Update request
                audit_request.interpretation = interpretation
                audit_request.current_stage = WorkflowStage.INTERPRETATION
                audit_request.updated_at = datetime.utcnow()

                # Update context
                context.current_stage = WorkflowStage.INTERPRETATION
                context.interpretation = interpretation

                # Log outputs
                logger.add_outputs_bulk({
                    "interpretation_id": interpretation_id,
                    "tasks_count": len(interpretation.interpreted_tasks),
                    "confidence": interpretation.interpretation_confidence,
                    "data_sources": len(interpretation.required_data_sources)
                })

                step_log = logger.get_step_log()

                # Store logs
                audit_request.step_logs.append(step_log)
                context.step_logs.append(step_log)

                self._persist_request(request_id)

                return interpretation, step_log
    
    # ========================================================================
    # WORKFLOW STAGE: RETRIEVAL
    # ========================================================================
    
    def retrieve_evidence(
        self,
        request_id: str,
        retrieval_handler  # Function to call for evidence retrieval
    ) -> Tuple[List[Dict[str, Any]], WorkflowStepLog]:
        """
        Move to RETRIEVAL stage and collect evidence from sources.
        
        Parameters:
        - request_id: The request being processed
        - retrieval_handler: Function(data_sources, tasks) -> evidence_list
        
        Returns:
        - (evidence_items, WorkflowStepLog): Retrieved evidence and log
        """
        
        self._ensure_loaded(request_id)
        
        audit_request = self.requests[request_id]
        context = self.contexts[request_id]
        
        if audit_request.interpretation is None:
            raise ValueError(f"Request {request_id} must be interpreted first")
        
        with StepLogger(
            step_name="Evidence Retrieval",
            agent_name="collection_agent",
            request_id=request_id,
            confidence_score=0.8
        ) as logger:
            data_sources = audit_request.interpretation.required_data_sources
            tasks = audit_request.interpretation.interpreted_tasks

            project_name = str(context.execution_metadata.get("project_name") or "default")
            scoped_sources = self._request_scoped_source_dirs(
                request_id=request_id,
                project_name=project_name,
            )
            request_evidence_dir = scoped_sources[0]
            context.execution_metadata["request_evidence_dir"] = request_evidence_dir
            retrieval_sources = list(dict.fromkeys(scoped_sources))
            
            logger.add_inputs_bulk({
                "data_sources_count": len(retrieval_sources),
                "tasks_count": len(tasks),
                "automatic_evidence_folder": "C:\\Users\\vadewale\\OneDrive - Deloitte (O365D)\\AGENTIC AI\\CAPSTONE\\DEMO\\EVIDENCE FILE",
                "request_evidence_folder": request_evidence_dir,
                "interpretation_data_sources_ignored_for_scope": len(data_sources),
            })
            
            # Call retrieval handler
            try:
                evidence_items = retrieval_handler(
                    data_sources=retrieval_sources,
                    tasks=tasks
                )
            except Exception as retrieval_error:
                # Keep stage progression deterministic when a source scan or
                # parser failure occurs; downstream validation/conclusion can
                # still produce NO EVIDENCE FOUND outputs.
                evidence_items = []
                logger.add_output("retrieval_handler_error", str(retrieval_error))
            copied_count = self._copy_evidence_into_request_dir(
                request_id=request_id,
                project_name=project_name,
                evidence_items=evidence_items,
            )

            existing_signatures = {
                self._evidence_signature(item if isinstance(item, dict) else item.model_dump(mode="json"))
                for item in context.evidence_collected
            }

            deduped_items: List[Dict[str, Any]] = []
            duplicate_count = 0
            for item in evidence_items:
                signature = self._evidence_signature(item)
                if signature in existing_signatures:
                    duplicate_count += 1
                    continue
                existing_signatures.add(signature)

                item["evidence_id"] = generate_evidence_id()
                item["request_id"] = request_id
                deduped_items.append(item)
            
            # Update request
            audit_request.current_stage = WorkflowStage.RETRIEVAL
            audit_request.updated_at = datetime.utcnow()
            
            # Update context
            context.current_stage = WorkflowStage.RETRIEVAL
            context.evidence_collected.extend(deduped_items)

            all_sources = list(retrieval_sources)

            logger.add_outputs_bulk({
                "evidence_items_collected": len(deduped_items),
                "evidence_items_skipped_as_duplicates": duplicate_count,
                "evidence_files_copied_to_request_folder": copied_count,
                "sources_scanned": all_sources,
                "automatic_evidence_folder": request_evidence_dir,
                "request_evidence_folder": request_evidence_dir,
                "sources_accessed": len(all_sources),
            })
            
            step_log = logger.get_step_log()
            
            # Store logs
            audit_request.step_logs.append(step_log)
            context.step_logs.append(step_log)

            self._persist_request(request_id)
            
            return deduped_items, step_log
    
    # ========================================================================
    # WORKFLOW STAGE: VALIDATION
    # ========================================================================
    
    def validate_evidence(
        self,
        request_id: str,
        validation_handler  # Function to call for validation
    ) -> Tuple[EvidenceValidationResult, WorkflowStepLog]:
        """
        Move to VALIDATION stage and evaluate evidence.
        
        Parameters:
        - request_id: The request being processed
        - validation_handler: Function(evidence_items, interpretation) -> validation_result
        
        Returns:
        - (EvidenceValidationResult, WorkflowStepLog): Validation result and log
        """
        
        self._ensure_loaded(request_id)
        
        audit_request = self.requests[request_id]
        context = self.contexts[request_id]
        
        with StepLogger(
            step_name="Evidence Validation",
            agent_name="validation_agent",
            request_id=request_id,
            confidence_score=0.8  # Will be updated with actual Bedrock confidence
        ) as logger:
            
            logger.add_input("evidence_items_count", len(context.evidence_collected))
            
            # Call validation handler
            validation_result = validation_handler(
                evidence_items=context.evidence_collected,
                interpretation=audit_request.interpretation
            )
            
            # Update confidence score with actual value from Bedrock model
            logger.confidence_score = validation_result.average_confidence_score
            
            # Update request
            audit_request.validation_result = validation_result
            audit_request.current_stage = WorkflowStage.VALIDATION
            audit_request.updated_at = datetime.utcnow()
            
            # Update context
            context.current_stage = WorkflowStage.VALIDATION
            context.validation_result = validation_result
            
            # Log outputs
            logger.add_outputs_bulk({
                "validation_id": validation_result.validation_id,
                "total_items": validation_result.total_evidence_items,
                "sufficient_items": validation_result.sufficient_items,
                "overall_sufficiency": validation_result.overall_sufficiency_score,
                "validation_status": validation_result.overall_validation_status.value,
                "confidence": validation_result.average_confidence_score
            })
            
            step_log = logger.get_step_log()
            
            # Store logs
            audit_request.step_logs.append(step_log)
            context.step_logs.append(step_log)

            self._persist_request(request_id)
            
            return validation_result, step_log
    
    # ========================================================================
    # WORKFLOW STAGE: CONCLUSION
    # ========================================================================
    
    def generate_conclusion(
        self,
        request_id: str,
        conclusion_handler  # Function to call for conclusion generation
    ) -> Tuple[AuditConclusion, WorkflowStepLog]:
        """
        Move to CONCLUSION stage and generate audit findings.
        
        Parameters:
        - request_id: The request being processed
        - conclusion_handler: Function(validation_result, evidence) -> conclusion
        
        Returns:
        - (AuditConclusion, WorkflowStepLog): Conclusion and log
        """
        
        self._ensure_loaded(request_id)
        
        audit_request = self.requests[request_id]
        context = self.contexts[request_id]
        
        if audit_request.validation_result is None:
            raise ValueError(f"Evidence validation required before conclusion")
        
        with StepLogger(
            step_name="Conclusion Generation",
            agent_name="summarization_agent",
            request_id=request_id,
            confidence_score=0.8  # Will be updated with actual Bedrock confidence
        ) as logger:
            
            logger.add_input("validation_status", 
                           audit_request.validation_result.overall_validation_status.value)
            
            # Call conclusion handler
            conclusion_data = conclusion_handler(
                validation_result=audit_request.validation_result,
                evidence_items=context.evidence_collected,
                interpretation=audit_request.interpretation
            )
            
            # Update confidence score with actual value from Bedrock model
            logger.confidence_score = conclusion_data.get("confidence", 0.8)

            raw_findings = conclusion_data.get("key_findings", [])
            normalized_findings = []
            for index, finding in enumerate(raw_findings, start=1):
                if not isinstance(finding, dict):
                    continue

                normalized_findings.append({
                    "finding_id": finding.get("finding_id", f"FIND-{index:03}"),
                    "description": finding.get("description") or finding.get("title", "No finding description provided."),
                    "evidence_references": finding.get("evidence_references", []),
                    "severity": finding.get("severity", "medium"),
                })
            
            conclusion_id = f"CONC-{uuid4().hex[:12].upper()}"
            conclusion = AuditConclusion(
                conclusion_id=conclusion_id,
                request_id=request_id,
                timestamp=datetime.utcnow(),
                key_findings=normalized_findings,
                overall_assessment=conclusion_data.get("overall_assessment", ""),
                average_ai_confidence_score=conclusion_data.get("confidence", 0.8),
                evidence_coverage=conclusion_data.get("coverage", 0.0),
                recommendations=conclusion_data.get("recommendations", [])
            )
            
            # Update request
            audit_request.conclusion = conclusion
            audit_request.current_stage = WorkflowStage.CONCLUSION
            audit_request.updated_at = datetime.utcnow()
            
            # Update context
            context.current_stage = WorkflowStage.CONCLUSION
            context.conclusion = conclusion
            report_sections = conclusion_data.get("report_sections")
            if isinstance(report_sections, dict):
                context.execution_metadata["model_report_sections"] = {
                    "engagement_context": str(report_sections.get("engagement_context") or "").strip(),
                    "review_procedures": str(report_sections.get("review_procedures") or "").strip(),
                    "review_highlights": str(report_sections.get("review_highlights") or "").strip(),
                    "conclusion": str(report_sections.get("conclusion") or "").strip(),
                }
            
            # Log outputs
            logger.add_outputs_bulk({
                "conclusion_id": conclusion_id,
                "key_findings_count": len(conclusion.key_findings),
                "confidence": conclusion.average_ai_confidence_score,
                "coverage": conclusion.evidence_coverage
            })
            
            step_log = logger.get_step_log()
            
            # Store logs
            audit_request.step_logs.append(step_log)
            context.step_logs.append(step_log)

            self._persist_request(request_id)
            
            return conclusion, step_log
    
    # ========================================================================
    # WORKFLOW STAGE: APPROVAL
    # ========================================================================
    
    def move_to_approval(
        self,
        request_id: str
    ) -> Tuple[AuditRequest, WorkflowStepLog]:
        """
        Move to APPROVAL stage and prepare for auditor review.
        
        Parameters:
        - request_id: The request ready for approval
        
        Returns:
        - (AuditRequest, WorkflowStepLog): Updated request and log
        """
        
        self._ensure_loaded(request_id)
        
        audit_request = self.requests[request_id]
        context = self.contexts[request_id]
        
        if audit_request.conclusion is None:
            raise ValueError(f"Conclusion required before approval")
        
        with StepLogger(
            step_name="Move to Approval",
            agent_name="workflow_orchestrator",
            request_id=request_id,
            confidence_score=1.0
        ) as logger:
            
            logger.add_input("current_stage", audit_request.current_stage.value)
            
            # Update request
            audit_request.current_stage = WorkflowStage.APPROVAL
            audit_request.approval_status = ApprovalStatus.PENDING
            audit_request.updated_at = datetime.utcnow()
            
            # Update context
            context.current_stage = WorkflowStage.APPROVAL
            context.approval_status = ApprovalStatus.PENDING
            
            logger.add_outputs_bulk({
                "new_stage": WorkflowStage.APPROVAL.value,
                "approval_status": ApprovalStatus.PENDING.value,
                "auditor_email": audit_request.auditor_email
            })
            
            step_log = logger.get_step_log()
            
            # Store logs
            audit_request.step_logs.append(step_log)
            context.step_logs.append(step_log)

            self._persist_request(request_id)
            
            return audit_request, step_log
    
    # ========================================================================
    # APPROVAL ACTIONS
    # ========================================================================
    
    def approve_request(
        self,
        request_id: str,
        auditor_email: str,
        notes: str = ""
    ) -> Tuple[AuditRequest, WorkflowStepLog]:
        """Approve the audit request and move to EXPORTED stage."""
        
        self._ensure_loaded(request_id)
        
        audit_request = self.requests[request_id]
        context = self.contexts[request_id]
        
        with StepLogger(
            step_name="Approval Confirmation",
            agent_name="approval_handler",
            request_id=request_id,
            confidence_score=1.0
        ) as logger:
            
            logger.add_inputs_bulk({
                "auditor_email": auditor_email,
                "current_status": audit_request.approval_status.value
            })
            
            # Update request
            audit_request.approval_status = ApprovalStatus.APPROVED
            audit_request.current_stage = WorkflowStage.EXPORTED
            audit_request.updated_at = datetime.utcnow()
            
            # Update context
            context.current_stage = WorkflowStage.EXPORTED
            context.approval_status = ApprovalStatus.APPROVED
            
            logger.add_outputs_bulk({
                "new_status": ApprovalStatus.APPROVED.value,
                "stage": WorkflowStage.EXPORTED.value,
                "timestamp": datetime.utcnow().isoformat()
            })
            
            step_log = logger.get_step_log()
            audit_request.step_logs.append(step_log)
            context.step_logs.append(step_log)
            self._persist_request(request_id)
            
            return audit_request, step_log
    
    def reject_request(
        self,
        request_id: str,
        auditor_email: str,
        rejection_reason: str
    ) -> Tuple[AuditRequest, WorkflowStepLog]:
        """Reject the audit request."""
        
        self._ensure_loaded(request_id)
        
        audit_request = self.requests[request_id]
        context = self.contexts[request_id]
        
        with StepLogger(
            step_name="Approval Rejection",
            agent_name="approval_handler",
            request_id=request_id,
            confidence_score=1.0
        ) as logger:
            
            logger.add_inputs_bulk({
                "auditor_email": auditor_email,
                "rejection_reason": rejection_reason
            })
            
            audit_request.approval_status = ApprovalStatus.REJECTED
            audit_request.updated_at = datetime.utcnow()
            
            context.approval_status = ApprovalStatus.REJECTED
            
            logger.add_outputs_bulk({
                "new_status": ApprovalStatus.REJECTED.value,
                "reason": rejection_reason
            })
            
            step_log = logger.get_step_log()
            audit_request.step_logs.append(step_log)
            context.step_logs.append(step_log)
            self._persist_request(request_id)
            
            return audit_request, step_log
    
    def request_revision(
        self,
        request_id: str,
        auditor_email: str,
        revision_notes: str
    ) -> Tuple[AuditRequest, WorkflowStepLog]:
        """Request revision to the audit report."""
        
        self._ensure_loaded(request_id)
        
        audit_request = self.requests[request_id]
        context = self.contexts[request_id]
        
        with StepLogger(
            step_name="Revision Requested",
            agent_name="approval_handler",
            request_id=request_id,
            confidence_score=1.0
        ) as logger:
            
            logger.add_inputs_bulk({
                "auditor_email": auditor_email,
                "revision_notes": revision_notes
            })
            
            audit_request.approval_status = ApprovalStatus.REVISING
            audit_request.updated_at = datetime.utcnow()
            
            context.approval_status = ApprovalStatus.REVISING
            
            logger.add_output("new_status", ApprovalStatus.REVISING.value)
            
            step_log = logger.get_step_log()
            audit_request.step_logs.append(step_log)
            context.step_logs.append(step_log)
            self._persist_request(request_id)
            
            return audit_request, step_log
    
    # ========================================================================
    # DATA RETRIEVAL
    # ========================================================================
    
    def get_request(self, request_id: str) -> Optional[AuditRequest]:
        """Get audit request by ID, loading from disk if not in memory."""
        if request_id not in self.requests:
            self._load_from_disk(request_id)
        return self.requests.get(request_id)
    
    def get_context(self, request_id: str) -> Optional[WorkflowExecutionContext]:
        """Get workflow execution context by request ID, loading from disk if not in memory."""
        if request_id not in self.contexts:
            self._load_from_disk(request_id)
        if request_id not in self.contexts and request_id in self.requests:
            audit_request = self.requests[request_id]
            self.contexts[request_id] = WorkflowExecutionContext(
                request_id=request_id,
                current_stage=audit_request.current_stage,
                step_logs=list(audit_request.step_logs),
                evidence_collected=[],
                interpretation=audit_request.interpretation,
                validation_result=audit_request.validation_result,
                conclusion=audit_request.conclusion,
                approval_status=audit_request.approval_status,
                execution_metadata={
                    "auditor_id": audit_request.auditor_id,
                    "auditor_email": audit_request.auditor_email,
                    "recovered_context": True,
                },
            )
            self._persist_request(request_id)
        return self.contexts.get(request_id)
    
    def get_step_logs(self, request_id: str) -> List[WorkflowStepLog]:
        """Get all step logs for a request."""
        audit_request = self.get_request(request_id)
        if audit_request:
            return audit_request.step_logs
        return []
    
    def get_workflow_status(self, request_id: str) -> Dict[str, Any]:
        """Get current workflow status."""
        audit_request = self.get_request(request_id)
        if not audit_request:
            return {"error": "Request not found"}

        context = self.get_context(request_id)
        if not context:
            return {"error": f"Request context missing for {request_id}"}

        evidence_count = len(context.evidence_collected)
        if evidence_count == 0:
            # Fallback for restored sessions where context evidence may not be hydrated yet.
            evidence_count = self._derive_evidence_count_from_logs(audit_request.step_logs)
        
        return {
            "request_id": request_id,
            "current_stage": audit_request.current_stage.value,
            "approval_status": audit_request.approval_status.value,
            "evidence_count": evidence_count,
            "step_count": len(audit_request.step_logs),
            "average_confidence": self._calculate_avg_confidence(audit_request.step_logs),
            "created_at": audit_request.created_at.isoformat(),
            "updated_at": audit_request.updated_at.isoformat()
        }

    def _extract_step_entries(self, step_log: Any, field_name: str) -> List[Any]:
        """Normalize step log inputs/outputs for both dict and model formats."""
        if isinstance(step_log, dict):
            entries = step_log.get(field_name, [])
        else:
            entries = getattr(step_log, field_name, [])
        return entries or []

    def _extract_entry_key_value(self, entry: Any) -> Tuple[str, Any]:
        """Extract key/value from either dict entries or pydantic model entries."""
        if isinstance(entry, dict):
            return str(entry.get("key", "")), entry.get("value")
        return str(getattr(entry, "key", "")), getattr(entry, "value", None)

    def _coerce_count(self, value: Any) -> Optional[int]:
        """Convert supported value types into a non-negative integer count."""
        if isinstance(value, (list, tuple, set)):
            return len(value)

        if isinstance(value, bool):
            return None

        if isinstance(value, (int, float)):
            return max(0, int(value))

        if isinstance(value, str):
            stripped = value.strip()
            if stripped.isdigit():
                return int(stripped)

        return None

    def _derive_evidence_count_from_logs(self, step_logs: List[WorkflowStepLog]) -> int:
        """Estimate evidence count from step logs when context evidence is empty."""
        candidate_keys = {
            "total_evidence_items_available",
            "evidence_items_collected",
            "uploaded_file_count",
            "evidence_items_count",
            "total_items",
            "evidence_items",
        }

        best_count = 0
        for step_log in step_logs:
            for field_name in ("outputs", "inputs"):
                for entry in self._extract_step_entries(step_log, field_name):
                    key, value = self._extract_entry_key_value(entry)
                    if key not in candidate_keys:
                        continue

                    parsed = self._coerce_count(value)
                    if parsed is not None:
                        best_count = max(best_count, parsed)

        return best_count
    
    def _calculate_avg_confidence(self, step_logs: List[WorkflowStepLog]) -> float:
        """Calculate average confidence score across all steps."""
        if not step_logs:
            return 0.0
        
        total_confidence = 0.0
        for log in step_logs:
            if isinstance(log, dict):
                total_confidence += float(log.get("confidence_score", 0.8))
            else:
                total_confidence += float(getattr(log, "confidence_score", 0.8))
        return total_confidence / len(step_logs)

    def delete_request_permanently(self, request_id: str) -> Dict[str, Any]:
        """Remove request state from memory and disk persistence."""
        removed: Dict[str, Any] = {
            "request_removed": False,
            "context_removed": False,
            "request_file_removed": False,
            "log_file_removed": False,
        }

        if request_id in self.requests:
            del self.requests[request_id]
            removed["request_removed"] = True

        if request_id in self.contexts:
            del self.contexts[request_id]
            removed["context_removed"] = True

        if request_id in self._request_locks:
            del self._request_locks[request_id]

        request_file = self._request_file_path(request_id)
        if os.path.exists(request_file):
            os.remove(request_file)
            removed["request_file_removed"] = True

        logs_file = os.path.join(os.path.dirname(_SYSTEM_REQUESTS_DIR), f"logs-{request_id}.json")
        if os.path.exists(logs_file):
            os.remove(logs_file)
            removed["log_file_removed"] = True

        return removed
