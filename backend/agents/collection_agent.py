import os
from typing import List, Dict, Any
from datetime import datetime

from agents.evidence_parser import parse_evidence_file, SUPPORTED_EXTENSIONS as PARSER_SUPPORTED_EXTENSIONS

SUPPORTED_EXTENSIONS = tuple(f".{extension}" for extension in sorted(PARSER_SUPPORTED_EXTENSIONS))

# Common audit document patterns
AUDIT_DOCUMENT_PATTERNS = {
    "reconciliation": ["recon", "reconcil", "match", "variance"],
    "approval": ["approval", "approved", "sign", "authorized"],
    "testing": ["test", "sample", "testing", "verified"],
    "exception": ["exception", "issue", "deficiency", "finding"],
    "control": ["control", "procedure", "process", "workflow"],
    "report": ["report", "summary", "analysis", "findings"],
}

# Automatic evidence retrieval folder
AUTOMATIC_EVIDENCE_DIR = os.getenv(
    "AUTOMATIC_EVIDENCE_DIR",
    r"C:\Users\vadewale\OneDrive - Deloitte (O365D)\AGENTIC AI\CAPSTONE\PSEUDO DATA",
)


def collect_documents(folder_path: str) -> List[str]:
    """
    Collect all supported documents from a folder, scanning recursively
    through all subdirectories (e.g. request-ID subfolders).
    Returns list of file paths.
    """
    files = []
    
    if not os.path.exists(folder_path):
        return files
    
    try:
        for root, dirs, filenames in os.walk(folder_path):
            for filename in filenames:
                if filename.lower().endswith(SUPPORTED_EXTENSIONS):
                    full_path = os.path.join(root, filename)
                    files.append(full_path)
    except (PermissionError, OSError):
        pass
    
    return files


def collect_evidence(
    data_sources: List[str],
    tasks: List[Any],
    keywords: List[str] = None
) -> List[Dict[str, Any]]:
    """
    Collects evidence from specified data sources only.
    
    Parameters:
    - data_sources: List of folder paths to search
    - tasks: List of InterpretedTask objects with required evidence types
    - keywords: Optional list of keywords to match in filenames
    
    Returns:
    - List of evidence items with metadata
    """
    
    if keywords is None:
        keywords = []
    
    evidence_items = []
    
    all_sources = list(dict.fromkeys([str(source or "").strip() for source in data_sources if str(source or "").strip()]))

    seen_signatures = set()
    
    for source in all_sources:
        # Collect documents from this source
        documents = collect_documents(source)
        
        for doc_path in documents:
            try:
                file_name = os.path.basename(doc_path)
                file_size = os.path.getsize(doc_path)
                file_mtime = int(os.path.getmtime(doc_path))
                file_ext = os.path.splitext(file_name)[1].lower()

                # Stable signature avoids duplicates from repeated source overlap.
                file_signature = (file_name.lower(), file_size, file_mtime)
                if file_signature in seen_signatures:
                    continue
                seen_signatures.add(file_signature)
                
                # Calculate relevance score based on filename and keywords
                relevance_score = calculate_relevance(file_name, keywords)
                
                evidence_item = {
                    "filename": file_name,
                    "storage_path": doc_path,
                    "file_type": file_ext[1:] if file_ext else "unknown",
                    "file_size_bytes": file_size,
                    "source": source,
                    "upload_timestamp": datetime.utcnow().isoformat(),
                    "relevance_score": relevance_score,
                    "source_signature": f"{file_name.lower()}::{file_size}::{file_mtime}",
                    "content_preview": extract_preview(doc_path),
                    "extracted_text": extract_full_text(doc_path),
                }
                
                evidence_items.append(evidence_item)
            
            except (OSError, IOError):
                continue
    
    return evidence_items


def calculate_relevance(filename: str, keywords: List[str]) -> float:
    """
    Calculate relevance score for a document based on filename and keywords.
    Returns score between 0 and 1.
    """
    
    filename_lower = filename.lower()
    base_score = 0.5
    
    # Check for keyword matches
    matches = 0
    for keyword in keywords:
        if keyword.lower() in filename_lower:
            matches += 1
    
    keyword_boost = min(0.4, (matches / max(len(keywords), 1)) * 0.4)
    
    # Check for common audit document patterns
    pattern_boost = 0.0
    for pattern_type, patterns in AUDIT_DOCUMENT_PATTERNS.items():
        for pattern in patterns:
            if pattern in filename_lower:
                pattern_boost = max(pattern_boost, 0.3)
                break
    
    final_score = min(1.0, base_score + keyword_boost + pattern_boost)
    return final_score


def extract_preview(file_path: str, max_chars: int = 500) -> str:
    """
    Extract a preview of the file content for display.
    """
    try:
        parsed = parse_evidence_file(file_path, source="folder_access")
        return parsed.get("content_preview", "")[:max_chars]
    except Exception:
        return ""


def extract_full_text(file_path: str) -> str:
    """Extract normalized document text for downstream validation and matching."""
    try:
        parsed = parse_evidence_file(file_path, source="folder_access")
        return parsed.get("extracted_text", "")
    except Exception:
        return ""


def match_evidence_to_tasks(
    evidence_items: List[Dict[str, Any]],
    tasks: List[Any]
) -> Dict[str, List[Dict[str, Any]]]:
    """
    Match collected evidence to audit tasks.
    
    Returns a mapping of task_id to evidence items relevant to that task.
    """
    
    mapping = {}
    
    for task in tasks:
        task_id = task.task_id if hasattr(task, 'task_id') else str(task.get('task_id', ''))
        task_keywords = task.keywords if hasattr(task, 'keywords') else task.get('keywords', [])
        
        relevant_items = []
        
        for evidence in evidence_items:
            # Check if evidence filename matches task requirements
            filename_lower = evidence['filename'].lower()
            
            # Score based on keyword matches
            score = 0
            for keyword in task_keywords:
                if keyword.lower() in filename_lower:
                    score += evidence.get('relevance_score', 0.5) * 0.5
            
            if score > 0:
                relevant_items.append(evidence)
        
        if relevant_items:
            mapping[task_id] = relevant_items
    
    return mapping