import importlib
import os
from typing import Any, Dict, List, Optional

import agents.bedrock_summary_agent as bedrock
from agents.standards_knowledge_base import build_standards_prompt_context


SUFFICIENT_THRESHOLD = 0.85


def _coerce_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _compute_score_baseline(evidence_items: List[Dict[str, Any]]) -> Dict[str, float]:
    if not evidence_items:
        return {"confidence": 0.0, "coverage": 0.0}

    normalized: List[Dict[str, float]] = []
    for item in evidence_items:
        relevance = max(0.0, min(1.0, _coerce_float(item.get("relevance_score"), 0.0)))
        sufficiency = max(0.0, min(1.0, _coerce_float(item.get("sufficiency_score"), 0.0)))
        status_value = str(item.get("validation_status") or item.get("status") or "").lower()

        # If scores are missing/zero, infer a weak but non-zero signal from
        # available validation status and content presence.
        has_content_signal = bool(item.get("content_preview") or item.get("extracted_text"))
        if relevance == 0.0:
            if has_content_signal:
                relevance = 0.35
            elif status_value in {"partial", "insufficient", "sufficient"}:
                relevance = 0.2
        if sufficiency == 0.0:
            if status_value == "sufficient":
                sufficiency = 0.5
            elif status_value == "partial":
                sufficiency = 0.35
            elif status_value == "insufficient":
                sufficiency = 0.2

        normalized.append({"relevance": relevance, "sufficiency": sufficiency})

    if not normalized:
        return {"confidence": 0.0, "coverage": 0.0}

    # File-level sufficient subset (for partial/insufficient scenarios when only
    # a portion of files meet the sufficiency criteria individually).
    sufficient_files = [
        item for item in normalized if item["sufficiency"] >= SUFFICIENT_THRESHOLD
    ]
    # If no individually sufficient file exists, score from the strongest
    # available subset instead of defaulting to zero.
    if sufficient_files:
        scoring_set = sufficient_files
    else:
        ranked = sorted(
            normalized,
            key=lambda item: (item["sufficiency"] * 0.7) + (item["relevance"] * 0.3),
            reverse=True,
        )
        scoring_set = ranked[: min(3, len(ranked))]

    avg_sufficiency = sum(item["sufficiency"] for item in scoring_set) / len(scoring_set)
    avg_relevance = sum(item["relevance"] for item in scoring_set) / len(scoring_set)

    confidence = max(0.0, min(1.0, (avg_sufficiency * 0.7) + (avg_relevance * 0.3)))
    coverage = max(0.0, min(100.0, avg_relevance * 100.0))

    # Keep low but meaningful scores when evidence exists but is weak.
    if confidence == 0.0 and evidence_items:
        confidence = 0.2
    if coverage == 0.0 and evidence_items:
        coverage = 15.0

    return {"confidence": confidence, "coverage": coverage}


def _invoke_bedrock_json(prompt: str) -> Dict[str, Any]:
    if not bedrock._bedrock_enabled():
        raise RuntimeError("Bedrock is disabled. Set BEDROCK_ENABLED=true.")

    if bedrock.boto3 is None:
        try:
            bedrock.boto3 = importlib.import_module("boto3")
        except Exception as exc:
            raise RuntimeError("boto3 is not installed; Bedrock summarization unavailable") from exc

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
        raise ValueError("Bedrock summarization did not return valid JSON")
    return parsed


def generate_audit_conclusion_ai(
    validation_result: Any,
    evidence_items: List[Dict[str, Any]],
    interpretation: Optional[Any] = None,
    request_text: Optional[str] = None,
) -> Dict[str, Any]:
    if hasattr(validation_result, "model_dump"):
        validation_payload = validation_result.model_dump(mode="json")
    elif isinstance(validation_result, dict):
        validation_payload = validation_result
    else:
        validation_payload = {"value": str(validation_result)}

    interpretation_payload: Any
    if interpretation is None:
        interpretation_payload = {}
    elif hasattr(interpretation, "model_dump"):
        interpretation_payload = interpretation.model_dump(mode="json")
    else:
        interpretation_payload = interpretation

    # Strip internal task_id fields so they are never echoed in model-generated narrative.
    if isinstance(interpretation_payload, dict):
        tasks = interpretation_payload.get("tasks")
        if isinstance(tasks, list):
            for task in tasks:
                if isinstance(task, dict):
                    task.pop("task_id", None)

    applicable_request_text = str(request_text or "").strip()
    if not applicable_request_text and isinstance(interpretation_payload, dict):
        applicable_request_text = str(
            interpretation_payload.get("original_request")
            or interpretation_payload.get("request_text")
            or ""
        ).strip()

    standards_context = build_standards_prompt_context(applicable_request_text, max_items=6)

    related_evidence_items: List[Dict[str, Any]] = []
    for item in evidence_items:
        try:
            relevance = float(item.get("relevance_score", 0.0))
        except (TypeError, ValueError):
            relevance = 0.0

        # "In no way related" documents are excluded from coverage metrics.
        # Keep documents with at least minimal relevance signal.
        if relevance > 0.2:
            related_evidence_items.append(item)

    baseline_scores = _compute_score_baseline(related_evidence_items or evidence_items)

    snippets: List[str] = []
    for idx, item in enumerate(related_evidence_items[:8], start=1):
        snippets.append(
            f"Evidence {idx}: {item.get('filename', f'Document {idx}')} | "
            f"Status={item.get('validation_status', 'unknown')} | "
            f"Relevance={item.get('relevance_score', 0)} | "
            f"Sufficiency={item.get('sufficiency_score', 0)} | "
            f"Preview={(item.get('content_preview') or '')[:400]}"
        )

    # Extract join expression to avoid backslash-in-fstring SyntaxError (Python < 3.12)
    snippet_joined = "\n".join(snippets) if snippets else "(no evidence items)"

    no_evidence_instruction = ""
    if not evidence_items:
        no_evidence_instruction = (
            "\nCRITICAL: No evidence files were found. "
            "Your overall_assessment MUST conclude with: \"There is no evidence file to validate. Kindly upload evidence file(s).\"\n"
        )

    prompt = (
        "You are an expert audit summarization agent trained in ISA and PCAOB standards.\n"
        "Produce an approval-ready audit conclusion from the validated evidence below.\n"
        "IMPORTANT: Do NOT mention, reference, or reproduce any internal system identifiers, "
        "request IDs, task IDs, step IDs, or UUID-style tokens (e.g. TASK-XXXXXXXX, STEP-XXXX) anywhere in your output. "
        "Write exclusively in professional audit language.\n\n"
        "PRIMARY PROFESSIONAL REFERENCE:\n"
        f"{standards_context}\n\n"
        "NON-HALLUCINATION RULES:\n"
        "- Use only the supplied validation summary, interpretation, and evidence highlights.\n"
        "- Do not invent controls, entities, dates, procedures, filenames, metrics, or conclusions not supported by the provided inputs.\n"
        "- Do not include a procedures-performed section in reports, emails, or narrative outputs.\n"
        "- If support is limited, explicitly state limitations and reduce confidence/coverage accordingly.\n"
        "- Do not claim completion of tests that are not evidenced in the provided inputs.\n\n"
        f"Audit request text:\n{applicable_request_text}\n\n"
        f"Validation summary:\n{validation_payload}\n\n"
        f"Audit interpretation (objective):\n{interpretation_payload}\n\n"
        "Evidence highlights:\n"
        f"{snippet_joined}\n"
        f"{no_evidence_instruction}\n"
        f"Baseline metrics from scoring subset (for consistency checks): confidence~{baseline_scores['confidence']:.2f}, coverage~{baseline_scores['coverage']:.1f}.\n"
        "If overall validation is partial or insufficient, compute confidence and coverage using only the file-level sufficient evidence items first; "
        "if none are file-level sufficient, use the strongest available relevant subset instead of defaulting to zero.\n"
        "Write all narrative fields in polished professional English with correct grammar, correct punctuation, and context-appropriate audit terminology.\n"
        "Produce a professional audit conclusion covering all control assertions tested.\n\n"
        "Return JSON only with these keys:\n"
        "  key_findings: array of objects, each with: title (string), description (string), severity ('critical'|'high'|'medium'|'low')\n"
        "  overall_assessment: string - professional narrative summarising the audit conclusion and evidence quality\n"
        "  confidence: decimal 0.0 to 1.0 - your confidence in the conclusion (e.g. 0.90 = 90% confidence; do NOT exceed 1.0)\n"
        "  coverage: number 0 to 100 - percentage of the audit objective covered by available evidence (e.g. 85 means 85%; do NOT use decimals here). "
        "Coverage MUST be computed only from related documents; ignore unrelated submissions.\n"
        "  recommendations: array of strings - specific recommended next steps or remediation actions\n"
        "  status: 'ready_for_approval' if evidence is sufficient, otherwise 'requires_additional_evidence'\n"
        "  report_sections: object with keys:\n"
        "    engagement_context (string, 1-2 professional sentences),\n"
        "    review_procedures (string, MUST be empty),\n"
        "    review_highlights (string, paragraph),\n"
        "    conclusion (string, paragraph)"
    )

    parsed = _invoke_bedrock_json(prompt)

    key_findings_raw = parsed.get("key_findings") if isinstance(parsed.get("key_findings"), list) else []
    key_findings: List[Dict[str, Any]] = []
    for idx, finding in enumerate(key_findings_raw, start=1):
        if not isinstance(finding, dict):
            continue
        key_findings.append(
            {
                "title": str(finding.get("title") or f"Finding {idx}"),
                "description": str(finding.get("description") or "No description provided"),
                "severity": str(finding.get("severity") or "medium"),
            }
        )

    confidence_raw = parsed.get("confidence", 0.0)
    coverage_raw = parsed.get("coverage", 0.0)

    try:
        confidence = max(0.0, min(1.0, float(confidence_raw)))
    except (TypeError, ValueError):
        confidence = baseline_scores["confidence"]

    try:
        coverage = max(0.0, min(100.0, float(coverage_raw)))
    except (TypeError, ValueError):
        coverage = baseline_scores["coverage"]

    # Prevent zeroed metrics when scoring evidence exists.
    if (related_evidence_items or evidence_items) and confidence == 0.0:
        confidence = baseline_scores["confidence"]
    if (related_evidence_items or evidence_items) and coverage == 0.0:
        coverage = baseline_scores["coverage"]

    recommendations_raw = parsed.get("recommendations") if isinstance(parsed.get("recommendations"), list) else []

    report_sections_raw = parsed.get("report_sections") if isinstance(parsed.get("report_sections"), dict) else {}
    report_sections = {
        "engagement_context": str(report_sections_raw.get("engagement_context") or "").strip(),
        "review_procedures": "",
        "review_highlights": str(report_sections_raw.get("review_highlights") or "").strip(),
        "conclusion": str(report_sections_raw.get("conclusion") or "").strip(),
    }

    status_raw = str(parsed.get("status") or "ready_for_approval").strip().lower()
    if status_raw not in {"ready_for_approval", "requires_additional_evidence"}:
        status_raw = "ready_for_approval" if confidence >= SUFFICIENT_THRESHOLD else "requires_additional_evidence"

    return {
        "key_findings": key_findings,
        "overall_assessment": str(parsed.get("overall_assessment") or "Audit conclusion unavailable"),
        "confidence": confidence,
        "coverage": coverage,
        "recommendations": [str(item) for item in recommendations_raw],
        "status": status_raw,
        "report_sections": report_sections,
    }
