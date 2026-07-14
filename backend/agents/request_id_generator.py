import json
import os
import re
from threading import Lock
from typing import Dict

# Internal system state directory (local-only)
SYSTEM_DIR = ".system"
COUNTER_FILE = os.path.join(SYSTEM_DIR, "request_counter.json")

_lock = Lock()


class RequestIDGenerator:
    """
    Backend-controlled request ID generator.

    Generates sequential audit request IDs in the format:
    {PROJECT_ID}-REQ-001, {PROJECT_ID}-REQ-002, {PROJECT_ID}-REQ-003, ...
    
    Example: AUDIT01-REQ-001, AUDIT01-REQ-002, etc.

    This is the single authoritative source for request IDs
    in local development mode.
    """

    def __init__(self):
        os.makedirs(SYSTEM_DIR, exist_ok=True)

        if not os.path.exists(COUNTER_FILE):
            self._initialize_counter()

    def generate(self, project_key: str = "default") -> str:
        """
        Generate the next request ID for a project scope with project identifier.
        
        Args:
            project_key: Project name or identifier (e.g., "Audit_Project_01", "audit", "client_xyz")
        
        Returns:
            Request ID in format: {PROJECT_ID}-REQ-{number:03d}
            Example: AP01-REQ-001, AUDIT-REQ-002, etc.
        """
        normalized_project_key = self._normalize_project_key(project_key)
        project_id = self._generate_project_id(normalized_project_key)

        with _lock:
            persisted_max = self._read_max_active_request_number(project_id)
            # If no active request IDs exist for this project, reset counter tracking.
            if persisted_max == 0:
                self._write_counter(normalized_project_key, 0)
            current = persisted_max
            next_number = current + 1
            self._write_counter(normalized_project_key, next_number)

        return f"{project_id}-REQ-{next_number:03d}"

    def _initialize_counter(self):
        self._write_counter("default", 0)

    def _read_counter(self, project_key: str) -> int:
        # Tolerate Windows PowerShell UTF-8 BOM files (utf-8-sig strips BOM if present).
        with open(COUNTER_FILE, "r", encoding="utf-8-sig") as f:
            data = json.load(f)

        # Backward compatibility for older flat counter format.
        if "projects" not in data:
            return int(data.get("last_request_number", 0))

        projects: Dict[str, int] = data.get("projects", {})
        return int(projects.get(project_key, 0))

    def _write_counter(self, project_key: str, number: int):
        data = {
            "projects": {},
            "last_request_number": 0,
        }

        if os.path.exists(COUNTER_FILE):
            # Read BOM-safe to avoid JSON decode errors from PowerShell-written files.
            with open(COUNTER_FILE, "r", encoding="utf-8-sig") as f:
                existing = json.load(f)

            if "projects" in existing:
                data["projects"] = existing.get("projects", {})
            else:
                legacy_last = int(existing.get("last_request_number", 0))
                data["projects"]["default"] = legacy_last

        data["projects"][project_key] = number
        data["last_request_number"] = number

        with open(COUNTER_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

    def _normalize_project_key(self, project_key: str) -> str:
        normalized = (project_key or "").strip().lower()
        return normalized or "default"

    def _generate_project_id(self, project_key: str) -> str:
        """
        Generate a short project identifier from the project key.
        
        Examples:
        - "default" -> "DEF"
        - "audit_project_01" -> "AP01"
        - "client_xyz" -> "CXYZ"
        - "audit" -> "AUD"
        - "proj_a_01" -> "PA01"
        """
        if not project_key or project_key == "default":
            return "DEFAULT"
        
        # Remove underscores and spaces, then extract uppercase letters
        cleaned = project_key.replace("_", "").replace(" ", "").replace("-", "")
        
        # Extract first letter of each word (separated by original separators)
        words = project_key.split("_")
        short_id = "".join(word[0].upper() for word in words if word)
        
        # If too short, use first 3-4 characters
        if len(short_id) < 2:
            short_id = cleaned[:4].upper()
        elif len(short_id) > 4:
            short_id = short_id[:4]
        
        return short_id

    def _read_max_active_request_number(self, project_id: str) -> int:
        requests_dir = os.path.join(SYSTEM_DIR, "requests")
        if not os.path.isdir(requests_dir):
            return 0

        pattern = re.compile(rf"^{re.escape(project_id)}-REQ-(\d{{3}})\.json$", re.IGNORECASE)
        max_number = 0

        for filename in os.listdir(requests_dir):
            match = pattern.match(filename)
            if not match:
                continue
            max_number = max(max_number, int(match.group(1)))

        return max_number