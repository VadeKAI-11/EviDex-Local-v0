import os
import re
from typing import List, Tuple
from fastapi import UploadFile

from agents.evidence_parser import extract_archive, get_extension, parse_evidence_file, SUPPORTED_FORMATS
from agents.reasoning_logger import log_step

# Base directory for all locally stored evidence
BASE_EVIDENCE_DIR = ".local_evidence"

# Automatic evidence retrieval folder path
AUTOMATIC_EVIDENCE_DIR = os.getenv(
    "AUTOMATIC_EVIDENCE_DIR",
    r"C:\Users\vadewale\OneDrive - Deloitte (O365D)\AGENTIC AI\CAPSTONE\PSEUDO DATA",
)


def _sanitize_folder_segment(value: str, fallback: str = "default") -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(value or ""))
    cleaned = cleaned.strip("._-")
    return cleaned or fallback


def _project_from_request_id(request_id: str) -> str | None:
    match = re.match(r"^([A-Za-z0-9]+)-REQ-\d{3}$", str(request_id or "").strip())
    if not match:
        return None
    return match.group(1)


def _resolve_project_name(project_name: str, request_id: str) -> str:
    provided = str(project_name or "").strip()
    if provided and provided.lower() != "default":
        return _sanitize_folder_segment(provided, fallback="default")

    inferred = _project_from_request_id(request_id)
    if inferred:
        return _sanitize_folder_segment(inferred, fallback="default")

    return "default"


def save_uploaded_files(
    request_id: str,
    files: List[UploadFile],
    project_name: str = "default",
) -> Tuple[list, list]:
    """
    Saves uploaded evidence files locally under a request-specific folder AND
    to a request-ID subfolder inside the automatic evidence retrieval folder.

    Directory structure:
    .local_evidence/
        REQ-001/
            file1.pdf
            file2.xlsx

    Also copies to:
    EVIDENCE FILE\\<project_name>\\REQ-001\\
            file1.pdf
            file2.xlsx

    Returns:
    - inventory: list of saved file metadata
    - logs: reasoning logs for audit transparency
    """

    os.makedirs(AUTOMATIC_EVIDENCE_DIR, exist_ok=True)

    safe_project = _resolve_project_name(project_name=project_name, request_id=request_id)

    # Create project/request subfolder inside the automatic evidence directory
    request_dir = os.path.join(AUTOMATIC_EVIDENCE_DIR, safe_project, request_id)
    os.makedirs(request_dir, exist_ok=True)

    inventory = []
    logs = []

    for file in files:
        extension = get_extension(file.filename)
        if extension not in {
            supported_extension
            for supported_extensions in SUPPORTED_FORMATS.values()
            for supported_extension in supported_extensions
        }:
            raise ValueError(
                f"Unsupported evidence format '{file.filename}'. "
                "Supported formats: pdf, docx, txt, msg, csv, xlsx, json, xml, png, jpg, jpeg, zip."
            )

        destination_path = os.path.join(request_dir, file.filename)

        file_bytes = file.file.read()
        with open(destination_path, "wb") as buffer:
            buffer.write(file_bytes)

        if extension == "zip":
            extracted_items, skipped_members = extract_archive(
                archive_path=destination_path,
                request_id=request_id,
                extract_root=request_dir,
            )
            inventory.extend(extracted_items)

            archive_message = (
                f"Expanded archive '{file.filename}' into {len(extracted_items)} supported evidence file(s)."
            )
            if skipped_members:
                archive_message += f" Skipped unsupported members: {', '.join(skipped_members)}"

            logs.append(
                log_step(
                    agent="collection_agent",
                    request_id=request_id,
                    message=archive_message,
                )
            )
            continue

        parsed_file = parse_evidence_file(destination_path)
        parsed_file["request_id"] = request_id
        inventory.append(parsed_file)

        logs.append(
            log_step(
                agent="collection_agent",
                request_id=request_id,
                message=(
                    f"Saved and parsed evidence file '{file.filename}' "
                    f"using {parsed_file['parsing_strategy']}"
                )
            )
        )

    return inventory, logs