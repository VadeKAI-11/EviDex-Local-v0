import os
from typing import Dict, List, Tuple, Any, Optional

from agents.collection_agent import collect_documents, collect_evidence
from agents.request_id_generator import RequestIDGenerator
from agents.reasoning_logger import log_step, StepLogger


def get_folder_access(folder_path: str) -> Dict[str, Any]:
    """
    Verifies folder accessibility and automatically links to collection_agent
    by returning collected supported documents when access is granted.
    
    Parameters:
    - folder_path: Path to the folder to access
    
    Returns:
    - Dict with access status, reason, and documents
    """
    if not os.path.exists(folder_path):
        return {
            "access": False,
            "reason": "Folder does not exist",
            "documents": [],
        }

    if not os.path.isdir(folder_path):
        return {
            "access": False,
            "reason": "Provided path is not a folder",
            "documents": [],
        }

    try:
        os.listdir(folder_path)
    except PermissionError:
        return {
            "access": False,
            "reason": "Permission denied for folder",
            "documents": [],
        }
    except Exception as exc:
        return {
            "access": False,
            "reason": f"Unable to access folder: {exc}",
            "documents": [],
        }

    documents = collect_documents(folder_path)
    return {
        "access": True,
        "reason": "Access granted",
        "documents": documents,
    }


def verify_and_access_sources(
    data_sources: List[str]
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """
    Verify access to multiple data sources and collect documents.
    
    Parameters:
    - data_sources: List of folder paths to access
    
    Returns:
    - Tuple of (accessible_documents, access_errors)
    """
    
    accessible_docs = []
    errors = []
    
    for source in data_sources:
        access_result = get_folder_access(source)
        
        if access_result["access"]:
            accessible_docs.extend(access_result["documents"])
        else:
            errors.append(f"{source}: {access_result['reason']}")
    
    return accessible_docs, errors


class AccessAgent:
    """
    Handles audit request initialization and folder access verification.
    
    Primary responsibilities:
    - Initialize new audit requests with unique IDs
    - Verify and manage folder/system access
    - Link access verification to evidence collection
    """

    def __init__(self):
        self.id_generator = RequestIDGenerator()

    def initialize_request(self) -> Dict[str, Any]:
        """
        Initialize a new audit request with unique ID.
        
        Returns:
        - dict containing request_id and reasoning log
        """
        
        request_id = self.id_generator.generate()

        with StepLogger(
            step_name="Request Initialization",
            agent_name="access_agent",
            request_id=request_id,
            confidence_score=1.0
        ) as logger:
            logger.add_output("request_id", request_id)
            logger.add_output("status", "initialized")
            
            step_log = logger.get_step_log()

        return {
            "request_id": request_id,
            "log": step_log,
            "status": "initialized"
        }
    
    def verify_folder_access(
        self,
        request_id: str,
        folder_paths: List[str]
    ) -> Dict[str, Any]:
        """
        Verify access to audit evidence folders.
        
        Parameters:
        - request_id: The audit request ID
        - folder_paths: List of folder paths to verify
        
        Returns:
        - Dict with access status for each folder
        """
        
        with StepLogger(
            step_name="Folder Access Verification",
            agent_name="access_agent",
            request_id=request_id,
            confidence_score=1.0
        ) as logger:
            
            logger.add_input("folders_to_verify", len(folder_paths))
            
            results = {}
            documents_found = []
            access_errors = []
            
            for folder_path in folder_paths:
                access_result = get_folder_access(folder_path)
                results[folder_path] = access_result
                
                if access_result["access"]:
                    documents_found.extend(access_result["documents"])
                    logger.add_output(f"access_{folder_path}", "granted")
                else:
                    access_errors.append({
                        "folder": folder_path,
                        "reason": access_result["reason"]
                    })
                    logger.add_output(f"access_{folder_path}", "denied")
            
            step_log = logger.get_step_log()
            
            return {
                "request_id": request_id,
                "results": results,
                "total_folders": len(folder_paths),
                "accessible_folders": len([r for r in results.values() if r["access"]]),
                "documents_found": len(documents_found),
                "errors": access_errors,
                "step_log": step_log
            }
    
    def retrieve_evidence_from_sources(
        self,
        request_id: str,
        data_sources: List[str],
        keywords: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        Retrieve evidence items from verified data sources.
        
        Parameters:
        - request_id: The audit request ID
        - data_sources: List of folder paths with evidence
        - keywords: Optional keywords to filter evidence
        
        Returns:
        - Dict with collected evidence items
        """
        
        with StepLogger(
            step_name="Evidence Retrieval",
            agent_name="access_agent",
            request_id=request_id,
            confidence_score=0.9
        ) as logger:
            
            logger.add_input("data_sources", len(data_sources))
            if keywords:
                logger.add_input("keywords", keywords)
            
            # Collect evidence from all sources
            evidence_items = collect_evidence(
                data_sources=data_sources,
                tasks=[],  # Can be enhanced with specific task info
                keywords=keywords or []
            )
            
            logger.add_output("evidence_items_collected", len(evidence_items))
            
            step_log = logger.get_step_log()
            
            return {
                "request_id": request_id,
                "evidence_items": evidence_items,
                "total_collected": len(evidence_items),
                "step_log": step_log
            }
