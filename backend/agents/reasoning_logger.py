from datetime import datetime
from typing import Dict, List, Any, Optional
from uuid import uuid4
import time
import json
import os
from threading import Lock


_AUDIT_LOG_LOCK = Lock()
_AUDIT_LOG_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", ".system", "audit_logs")
)

try:
    os.makedirs(os.path.dirname(_AUDIT_LOG_PATH), exist_ok=True)
    if not os.path.exists(_AUDIT_LOG_PATH):
        with open(_AUDIT_LOG_PATH, "a", encoding="utf-8"):
            pass
except Exception:
    pass


def _append_audit_log(entry: Dict[str, Any]) -> None:
    """Append a backend-only audit log entry to the centralized audit_logs file."""
    try:
        os.makedirs(os.path.dirname(_AUDIT_LOG_PATH), exist_ok=True)
        with _AUDIT_LOG_LOCK:
            with open(_AUDIT_LOG_PATH, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, default=str) + "\n")
    except Exception:
        # Audit logging should never break runtime workflows.
        pass


def generate_step_id() -> str:
    """Generate a unique step ID."""
    return f"STEP-{uuid4().hex[:12].upper()}"


def create_step_input(key: str, value: Any) -> Dict[str, Any]:
    """Create a structured input entry for a step."""
    return {"key": key, "value": value}


def create_step_output(key: str, value: Any) -> Dict[str, Any]:
    """Create a structured output entry for a step."""
    return {"key": key, "value": value}


def log_step(
    agent: str,
    request_id: str,
    message: str
) -> Dict[str, str]:
    """
    Legacy simple log entry for backward compatibility.

    Parameters:
    - agent (str): Name of the agent producing the log
    - request_id (str): Audit request identifier
    - message (str): Description of the action or decision

    Returns:
    - dict: Structured reasoning log entry
    """
    entry = {
        "timestamp": datetime.utcnow().isoformat(),
        "agent": agent,
        "request_id": request_id,
        "message": message
    }
    _append_audit_log({
        "log_type": "legacy_log",
        **entry,
    })
    return entry


def log_workflow_step(
    step_name: str,
    agent_name: str,
    request_id: str,
    action_taken: str,
    inputs: List[Dict[str, Any]],
    outputs: List[Dict[str, Any]],
    status: str = "completed",
    confidence_score: float = 1.0,
    execution_time_ms: int = 0,
    error_message: Optional[str] = None
) -> Dict[str, Any]:
    """
    Creates a comprehensive workflow step log with full traceability.
    
    This is the primary function for logging workflow steps with complete context.
    All agents should use this function for step logging.

    Parameters:
    - step_name (str): Name of the step (e.g., "Interpretation", "Retrieval", "Validation")
    - agent_name (str): Name of the agent executing the step
    - request_id (str): Audit request identifier
    - action_taken (str): Description of what action was performed
    - inputs (List[Dict]): List of input dictionaries with "key" and "value"
    - outputs (List[Dict]): List of output dictionaries with "key" and "value"
    - status (str): "completed", "in_progress", or "failed"
    - confidence_score (float): AI confidence for this step (0-1)
    - execution_time_ms (int): Time taken to execute in milliseconds
    - error_message (str): Error details if step failed

    Returns:
    - dict: Complete workflow step log entry
    """
    
    entry = {
        "step_id": generate_step_id(),
        "step_name": step_name,
        "agent_name": agent_name,
        "request_id": request_id,
        "timestamp": datetime.utcnow().isoformat(),
        "action_taken": action_taken,
        "inputs": inputs,
        "outputs": outputs,
        "status": status,
        "confidence_score": confidence_score,
        "execution_time_ms": execution_time_ms,
        "error_message": error_message
    }
    _append_audit_log({
        "log_type": "workflow_step",
        **entry,
    })
    return entry


class StepLogger:
    """
    Context manager for logging workflow steps with automatic timing and error handling.
    
    Usage:
        with StepLogger("Interpretation", "interpretation_agent", request_id) as logger:
            logger.add_input("request_text", "Verify financial controls")
            # ... do work ...
            logger.add_output("tasks", ["Task 1", "Task 2"])
    """
    
    def __init__(
        self,
        step_name: str,
        agent_name: str,
        request_id: str,
        confidence_score: float = 0.8
    ):
        self.step_name = step_name
        self.agent_name = agent_name
        self.request_id = request_id
        self.confidence_score = confidence_score
        self.inputs = []
        self.outputs = []
        self.start_time = None
        self.error_message = None
        self.status = "in_progress"
    
    def add_input(self, key: str, value: Any) -> None:
        """Add an input parameter to the step."""
        self.inputs.append(create_step_input(key, value))
    
    def add_output(self, key: str, value: Any) -> None:
        """Add an output result to the step."""
        self.outputs.append(create_step_output(key, value))
    
    def add_inputs_bulk(self, inputs_dict: Dict[str, Any]) -> None:
        """Add multiple inputs at once from a dictionary."""
        for key, value in inputs_dict.items():
            self.add_input(key, value)
    
    def add_outputs_bulk(self, outputs_dict: Dict[str, Any]) -> None:
        """Add multiple outputs at once from a dictionary."""
        for key, value in outputs_dict.items():
            self.add_output(key, value)
    
    def __enter__(self):
        self.start_time = time.time_ns()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        execution_time_ms = (time.time_ns() - self.start_time) // 1_000_000
        
        if exc_type is not None:
            self.status = "failed"
            self.error_message = str(exc_val)
        else:
            self.status = "completed"
        
        # Log the step
        step_log = log_workflow_step(
            step_name=self.step_name,
            agent_name=self.agent_name,
            request_id=self.request_id,
            action_taken=f"Executed {self.step_name} workflow step",
            inputs=self.inputs,
            outputs=self.outputs,
            status=self.status,
            confidence_score=self.confidence_score,
            execution_time_ms=execution_time_ms,
            error_message=self.error_message
        )
        
        # Store the log for later retrieval (could be extended to persist to DB)
        self._last_log = step_log
        
        return False  # Don't suppress exceptions
    
    def get_step_log(self) -> Dict[str, Any]:
        """Get the generated step log (only available after context exit)."""
        if hasattr(self, '_last_log'):
            return self._last_log

        execution_time_ms = 0
        if self.start_time is not None:
            execution_time_ms = (time.time_ns() - self.start_time) // 1_000_000

        # If requested before context exit and no exception is tracked,
        # finalize as completed to avoid persisting stale "in_progress" logs.
        status = self.status
        action_taken = f"Executing {self.step_name} workflow step"
        if status == "in_progress" and self.error_message is None:
            status = "completed"
            action_taken = f"Executed {self.step_name} workflow step"

        return log_workflow_step(
            step_name=self.step_name,
            agent_name=self.agent_name,
            request_id=self.request_id,
            action_taken=action_taken,
            inputs=self.inputs,
            outputs=self.outputs,
            status=status,
            confidence_score=self.confidence_score,
            execution_time_ms=execution_time_ms,
            error_message=self.error_message,
        )