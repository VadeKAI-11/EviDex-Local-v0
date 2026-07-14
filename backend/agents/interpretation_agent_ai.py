import importlib
import os
from typing import Any, Dict, List
from uuid import uuid4

from models.schemas import InterpretedTask
import agents.bedrock_summary_agent as bedrock


def _invoke_bedrock_json(prompt: str) -> Dict[str, Any]:
    if not bedrock._bedrock_enabled():
        raise RuntimeError("Bedrock is disabled. Set BEDROCK_ENABLED=true.")

    if bedrock.boto3 is None:
        try:
            bedrock.boto3 = importlib.import_module("boto3")
        except Exception as exc:
            raise RuntimeError("boto3 is not installed; Bedrock interpretation unavailable") from exc

    region = os.getenv("AWS_REGION", "us-east-1")
    model_id = os.getenv("BEDROCK_MODEL_ID", bedrock.DEFAULT_MODEL_ID)
    tls_verify = bedrock._resolve_tls_verify()
    explicit_credentials = bedrock._resolve_explicit_credentials(region)

    client_kwargs: Dict[str, Any] = {
        "region_name": region,
        "verify": tls_verify,
    }
    if explicit_credentials:
        client_kwargs.update(explicit_credentials)

    try:
        client = bedrock.boto3.client("bedrock-runtime", **client_kwargs)
        response = bedrock._invoke_bedrock_converse(client, model_id, prompt)
    except Exception as exc:
        message = str(exc).lower()
        if "unrecognizedclientexception" in message or "security token included in the request is invalid" in message:
            response = bedrock._retry_converse_without_env_credentials(
                region=region,
                tls_verify=tls_verify,
                model_id=model_id,
                prompt=prompt,
                explicit_credentials=explicit_credentials,
            )
        else:
            raise

    text = response["output"]["message"]["content"][0].get("text", "")
    parsed = bedrock._try_parse_json_summary(text)
    if not parsed:
        raise ValueError("Bedrock interpretation did not return valid JSON")
    return parsed


def _normalize_tasks(task_list: List[Dict[str, Any]]) -> List[InterpretedTask]:
    normalized: List[InterpretedTask] = []
    for idx, task in enumerate(task_list, start=1):
        description = str(task.get("task_description") or task.get("description") or f"Collect audit evidence task {idx}")
        priority_raw = task.get("priority", idx)
        try:
            priority = max(1, min(5, int(priority_raw)))
        except (TypeError, ValueError):
            priority = min(idx, 5)

        evidence_types = task.get("required_evidence_types") or task.get("evidence_types") or ["documentation"]
        if not isinstance(evidence_types, list):
            evidence_types = [str(evidence_types)]

        keywords = task.get("keywords") or []
        if not isinstance(keywords, list):
            keywords = [str(keywords)]

        normalized.append(
            InterpretedTask(
                task_id=f"TASK-{uuid4().hex[:8].upper()}",
                task_description=description,
                priority=priority,
                required_evidence_types=[str(item) for item in evidence_types[:8]],
                keywords=[str(item) for item in keywords[:12]],
            )
        )

    if normalized:
        return normalized

    return [
        InterpretedTask(
            task_id=f"TASK-{uuid4().hex[:8].upper()}",
            task_description="Collect evidence relevant to the submitted audit request",
            priority=3,
            required_evidence_types=["documentation", "reports"],
            keywords=["audit", "evidence"],
        )
    ]


def interpret_audit_request_ai(audit_request: str) -> Dict[str, Any]:
    prompt = (
        "You are a senior audit AI agent trained in ISA and PCAOB standards.\n"
        "Read the auditor's request below and produce a structured audit interpretation.\n\n"
        "NON-HALLUCINATION RULES:\n"
        "- Use only information explicitly present in the audit request text.\n"
        "- Do not invent entities, systems, periods, controls, filenames, IDs, or evidence artifacts not supported by the request.\n"
        "- If detail is missing, keep outputs generic and note uncertainty instead of guessing.\n"
        "- Keep confidence conservative when the request is ambiguous.\n\n"
        f"Audit request:\n{audit_request}\n\n"
        "Analyse the request and identify:\n"
        "  1. The specific audit objective (what control, process, or assertion is being tested)\n"
        "  2. The relevant audit area (e.g. revenue, payroll, accounts payable, bank reconciliation, IT controls)\n"
        "  3. The types of documentary evidence that would satisfy this audit procedure\n"
        "  4. Short filename keywords likely to appear in the actual evidence files\n\n"
        "Return JSON only with these keys:\n"
        "  tasks: array of task objects, each with:\n"
        "    - task_description: clear description of the evidence to collect and why it satisfies the audit objective\n"
        "    - priority: integer 1 (most critical) to 5 (least critical)\n"
        "    - required_evidence_types: array of evidence labels in audit terms\n"
        "      (e.g. 'bank reconciliation', 'approved invoice', 'GL extract', 'payroll register', 'board minutes')\n"
        "    - keywords: array of short strings likely to appear in relevant audit document file names\n"
        "      (e.g. 'recon', 'invoice', 'approval', 'payroll', 'bank_stmt', 'GL', 'journal')\n"
        "  confidence: decimal 0.0-1.0 - how well the request maps to known audit procedures\n"
        "  data_sources: array containing exactly [\"/audit/evidence\"]\n"
        "  notes: one sentence describing the primary control assertion being tested\n"
        "  identified_keywords: array of key audit terms extracted from the request"
    )

    parsed = _invoke_bedrock_json(prompt)
    tasks = _normalize_tasks(parsed.get("tasks") if isinstance(parsed.get("tasks"), list) else [])

    confidence_raw = parsed.get("confidence", 0.8)
    try:
        confidence = float(confidence_raw)
    except (TypeError, ValueError):
        confidence = 0.8
    confidence = max(0.0, min(1.0, confidence))

    data_sources = parsed.get("data_sources") if isinstance(parsed.get("data_sources"), list) else []
    if not data_sources:
        data_sources = ["/audit/evidence"]

    identified_keywords = parsed.get("identified_keywords") if isinstance(parsed.get("identified_keywords"), list) else []

    return {
        "tasks": tasks,
        "confidence": confidence,
        "data_sources": [str(item) for item in data_sources],
        "notes": str(parsed.get("notes") or "Generated by Bedrock interpretation agent."),
        "identified_keywords": [str(item) for item in identified_keywords],
    }
