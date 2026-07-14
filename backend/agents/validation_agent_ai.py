import importlib
import os
from datetime import datetime
from itertools import combinations
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

import agents.bedrock_summary_agent as bedrock
from agents.reasoning_logger import log_step
from agents.standards_knowledge_base import build_standards_prompt_context
from models.schemas import EvidenceValidationResult, ValidationStatus


DEFAULT_MAX_VALIDATION_PROMPT_CHARS = 120000
DEFAULT_COMPACT_VALIDATION_PROMPT_CHARS = 45000
DEFAULT_MAX_VALIDATION_ITEMS = 160
DEFAULT_MAX_INTERPRETATION_CHARS = 4000
SUFFICIENT_THRESHOLD = 0.85


def _safe_int_env(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        parsed = int(raw)
        return parsed if parsed > 0 else default
    except ValueError:
        return default


def _truncate_text(value: Any, limit: int) -> str:
    text = str(value or "")
    if limit <= 0 or len(text) <= limit:
        return text
    return text[: max(0, limit - 3)] + "..."


def _is_context_overflow_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return "maximum context length" in message or "input_tokens" in message


def _derive_request_text(request_text: Optional[str], interpretation: Optional[Any]) -> str:
    normalized = str(request_text or "").strip()
    if normalized:
        return normalized

    if interpretation is None:
        return ""

    original_request = getattr(interpretation, "original_request", None)
    if original_request:
        return str(original_request)

    if isinstance(interpretation, dict):
        return str(interpretation.get("original_request") or interpretation.get("request_text") or "")

    return ""


def _build_validation_prompt(
    request_id: str,
    interpretation: Optional[Any],
    evidence_inventory: List[Dict[str, Any]],
    request_text: Optional[str],
    *,
    max_prompt_chars: int,
    max_items: int,
    max_interpretation_chars: int,
    compact: bool = False,
) -> Tuple[str, Dict[str, int]]:
    if interpretation is not None:
        if hasattr(interpretation, "model_dump"):
            interpretation_brief = str(interpretation.model_dump(mode="json"))
        else:
            interpretation_brief = str(interpretation)
    else:
        interpretation_brief = ""

    interpretation_brief = _truncate_text(interpretation_brief, max_interpretation_chars)
    applicable_request_text = _derive_request_text(request_text, interpretation)
    standards_context = build_standards_prompt_context(applicable_request_text, max_items=6)

    prompt_prefix = (
        "You are a senior audit validation agent trained in ISA and PCAOB standards.\n"
        "Assess each evidence item below against the audit objective described in the interpretation context.\n\n"
        "PRIMARY PROFESSIONAL REFERENCE:\n"
        f"{standards_context}\n\n"
        "NON-HALLUCINATION RULES:\n"
        "- Use only the evidence items and fields provided in this prompt.\n"
        "- Do not invent filenames, evidence IDs, controls, dates, scores, or findings that are not present.\n"
        "- If information is missing for a decision, mark the item as partial/insufficient and explain the missing information.\n"
        "- Keep confidence and sufficiency conservative when data is incomplete or ambiguous.\n\n"
        f"Request ID: {request_id}\n"
        f"Audit request text: {applicable_request_text}\n"
        f"Audit interpretation context: {interpretation_brief}\n\n"
        "Evidence items submitted for review:\n"
    )

    prompt_suffix = (
        "\n\n"
        "For each item, assess: (1) direct relevance to the audit objective, "
        "(2) completeness and reliability as audit evidence, "
        "(3) sufficiency in covering the control or assertion being tested.\n"
        "Then assess the evidence set collectively and determine whether a multiple combination "
        "of the submitted items is sufficient when considered together, even if some "
        "individual items are only partial on a standalone basis.\n\n"
        "Write all narrative fields in polished professional English with correct grammar, precise punctuation, and context-appropriate audit terminology.\n\n"
        "Return JSON only with these keys:\n"
        "  overall_sufficiency_score: decimal 0.0-1.0 representing overall evidence sufficiency "
        "(e.g. 0.85 means the evidence is 85% sufficient — do NOT return values above 1.0). "
        "This score must reflect both item-level quality and the combined coverage achieved "
        "across the evidence set.\n"
        "  confidence: decimal 0.0-1.0 representing your confidence in this assessment\n"
        "  overall_validation_status: one of 'sufficient', 'partial', or 'insufficient'\n"
        "  gap_recommendations: array of strings describing what additional evidence is needed\n"
        "  evidence: array of per-item objects, each with:\n"
        "    filename (string), relevance_score (decimal 0.0-1.0), sufficiency_score (decimal 0.0-1.0),\n"
        "    status ('sufficient'|'partial'|'insufficient'), validation_notes (string)"
    )

    max_prompt_chars = max(12000, max_prompt_chars)
    header_size = len(prompt_prefix) + len(prompt_suffix)
    evidence_budget = max(2000, max_prompt_chars - header_size)

    effective_max_items = max(1, min(max_items, len(evidence_inventory)))
    min_per_item_chars = 180 if compact else 280
    preview_limit = 120 if compact else 280
    extracted_limit = 320 if compact else 700

    snippets: List[str] = []
    used = 0
    included = 0
    truncated_items = 0

    for idx, item in enumerate(evidence_inventory[:effective_max_items], start=1):
        remaining_items = effective_max_items - included
        remaining_budget = evidence_budget - used
        if remaining_budget < min_per_item_chars:
            break

        per_item_budget = max(min_per_item_chars, remaining_budget // max(1, remaining_items))

        preview_text = _truncate_text(item.get("content_preview") or "", preview_limit)
        extracted_text = _truncate_text(item.get("extracted_text") or "", extracted_limit)

        raw_snippet = (
            f"Evidence {idx}: {item.get('filename', f'Document {idx}')}\n"
            f"Type: {item.get('file_type', 'unknown')}\n"
            f"Source: {item.get('source', 'unknown')}\n"
            f"Preview: {preview_text}\n"
            f"Extracted: {extracted_text}"
        )

        final_snippet = _truncate_text(raw_snippet, per_item_budget)
        if len(final_snippet) < len(raw_snippet):
            truncated_items += 1

        snippet_size = len(final_snippet) + 2
        if used + snippet_size > evidence_budget and included > 0:
            break

        snippets.append(final_snippet)
        used += snippet_size
        included += 1

    omitted = len(evidence_inventory) - included
    if omitted > 0:
        omitted_note = (
            f"[System note] {omitted} additional evidence file(s) were omitted from prompt details due to "
            "context budget. Prioritize coverage-level recommendations for missing or weak evidence areas."
        )
        if used + len(omitted_note) + 2 <= evidence_budget:
            snippets.append(omitted_note)
        else:
            snippets.append(_truncate_text(omitted_note, max(80, evidence_budget - used)))

    evidence_joined = "\n\n".join(snippets) if snippets else "(no evidence items submitted)"
    prompt = f"{prompt_prefix}{evidence_joined}{prompt_suffix}"

    return prompt, {
        "included_items": included,
        "omitted_items": max(0, omitted),
        "truncated_items": truncated_items,
        "prompt_chars": len(prompt),
    }


def _invoke_bedrock_json(prompt: str) -> Dict[str, Any]:
    if not bedrock._bedrock_enabled():
        raise RuntimeError("Bedrock is disabled. Set BEDROCK_ENABLED=true.")

    if bedrock.boto3 is None:
        try:
            bedrock.boto3 = importlib.import_module("boto3")
        except Exception as exc:
            raise RuntimeError("boto3 is not installed; Bedrock validation unavailable") from exc

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
        raise ValueError("Bedrock validation did not return valid JSON")
    return parsed


def _status_from_text(raw: Any) -> ValidationStatus:
    value = str(raw or "").strip().lower()
    if value == ValidationStatus.SUFFICIENT.value:
        return ValidationStatus.SUFFICIENT
    if value == ValidationStatus.PARTIAL.value:
        return ValidationStatus.PARTIAL
    return ValidationStatus.INSUFFICIENT


def _status_from_sufficiency(score: float) -> ValidationStatus:
    """Normalize status directly from numeric sufficiency score."""
    if score >= SUFFICIENT_THRESHOLD:
        return ValidationStatus.SUFFICIENT
    if score >= 0.5:
        return ValidationStatus.PARTIAL
    return ValidationStatus.INSUFFICIENT


def _build_sufficiency_conclusion(
    overall_status: ValidationStatus,
    overall_sufficiency: float,
    selected_items: List[Dict[str, Any]],
    total_count: int,
) -> str:
    if overall_status == ValidationStatus.SUFFICIENT:
        selected_names = [str(item.get("filename") or "unknown") for item in selected_items[:3]]
        selected_label = ", ".join(selected_names) if selected_names else "submitted evidence"
        return (
            f"Sufficient: overall sufficiency is {overall_sufficiency * 100:.1f}% (>= {SUFFICIENT_THRESHOLD * 100:.0f}%) "
            f"based on the strongest {len(selected_items)}/{total_count} evidence item(s), including {selected_label}. "
            "These items collectively provide enough relevance, completeness, and corroboration for the audit objective."
        )

    if overall_status == ValidationStatus.PARTIAL:
        return (
            f"Partially sufficient: overall sufficiency is {overall_sufficiency * 100:.1f}%, which is below "
            f"the {SUFFICIENT_THRESHOLD * 100:.0f}% sufficiency threshold. Additional corroborating evidence is needed."
        )

    return (
        f"Insufficient: overall sufficiency is {overall_sufficiency * 100:.1f}%, below minimum acceptance criteria. "
        "Submitted evidence does not yet provide adequate objective coverage and support."
    )


def _merge_improvement_recommendations(base: List[str], overall_sufficiency: float) -> List[str]:
    """Always provide practical next steps to improve sufficiency quality/coverage."""
    normalized = [str(item).strip() for item in base if str(item).strip()]

    improvement_actions = [
        "Map each submitted document to a specific interpreted task/control assertion and document that mapping explicitly.",
        "Add period-spanning evidence (start, middle, end of audit window) to strengthen coverage completeness.",
        "Include independently reviewable artifacts (approvals, logs, exception handling records) for each key control step.",
    ]

    if overall_sufficiency >= 0.8:
        improvement_actions.insert(
            0,
            "Evidence is sufficient; improve confidence further by adding one corroborating artifact for each major finding.",
        )

    existing_lower = {item.lower() for item in normalized}
    for action in improvement_actions:
        if action.lower() not in existing_lower:
            normalized.append(action)

    return normalized


def _short_file_list(items: List[Dict[str, Any]], max_names: int = 5) -> str:
    names = [str(item.get("filename") or "unknown") for item in items]
    if len(names) <= max_names:
        return ", ".join(names) if names else "none"
    head = ", ".join(names[:max_names])
    return f"{head}, +{len(names) - max_names} more"


def _derive_exclusion_reason(item: Dict[str, Any]) -> str:
    relevance = float(item.get("relevance_score") or 0.0)
    sufficiency = float(item.get("sufficiency_score") or 0.0)

    if relevance < 0.5 and sufficiency < 0.5:
        return "Low relevance to the interpreted audit objective and weak standalone support."
    if relevance < 0.5:
        return "Only partially relevant to the interpreted audit objective."
    if sufficiency < 0.5:
        return "Relevant, but lacks enough corroboration/detail to support sufficiency."
    return "Not required in the minimum sufficient subset based on comparative contribution."


def _choose_sufficient_subset(
    validated_items: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], float, float]:
    if not validated_items:
        return [], [], 0.0, 0.0

    def _item_contribution(item: Dict[str, Any]) -> float:
        suff = max(0.0, min(1.0, float(item.get("sufficiency_score") or 0.0)))
        rel = max(0.0, min(1.0, float(item.get("relevance_score") or 0.0)))
        # Blend quality and relevance into a single additive contribution signal.
        return max(0.0, min(1.0, (suff * 0.75) + (rel * 0.25)))

    ranked = sorted(validated_items, key=_item_contribution, reverse=True)

    total_count = len(ranked)
    # Use the same sufficiency threshold for subset selection as final status assignment.
    target_sufficiency = SUFFICIENT_THRESHOLD
    # Bound combination search to keep runtime predictable on very large uploads.
    max_combination_candidates = 12

    def _combined_sufficiency(items: List[Dict[str, Any]]) -> float:
        # Model combined evidence power using cumulative residual-risk reduction:
        # combined = 1 - Π(1 - contribution_i)
        residual = 1.0
        for item in items:
            residual *= 1.0 - _item_contribution(item)
        return 1.0 - residual

    def _best_subset_by_combinations(
        items: List[Dict[str, Any]],
        min_size: int,
    ) -> Tuple[Optional[List[Dict[str, Any]]], List[Dict[str, Any]]]:
        candidates = items[:max_combination_candidates]
        if not candidates:
            return None, []

        best_subset: List[Dict[str, Any]] = []
        best_score = -1.0

        start_size = max(1, min_size)
        for size in range(start_size, len(candidates) + 1):
            found_sufficient: Optional[List[Dict[str, Any]]] = None
            found_sufficient_score = -1.0

            for combo in combinations(candidates, size):
                subset = list(combo)
                score = _combined_sufficiency(subset)

                if score > best_score:
                    best_score = score
                    best_subset = subset

                if score >= target_sufficiency and score > found_sufficient_score:
                    found_sufficient = subset
                    found_sufficient_score = score

            # Return the smallest sufficient subset; break as soon as one size qualifies.
            if found_sufficient is not None:
                return found_sufficient, best_subset

        return None, best_subset

    # Case 1: detect single-file sufficiency (standalone file is enough).
    single_file_candidates = [item for item in ranked if _item_contribution(item) >= target_sufficiency]
    best_single = single_file_candidates[0] if single_file_candidates else None

    selected: List[Dict[str, Any]]
    if best_single is not None:
        # Default to single-file sufficiency selection.
        selected = [best_single]

        # Case 3: if a separate multi-file set is also sufficient, use the combined relevant set.
        # "Separate" means at least two files and excludes the standalone sufficient file.
        remaining = [item for item in ranked if item is not best_single]
        multi_sufficient_subset, _ = _best_subset_by_combinations(remaining, min_size=2)
        if multi_sufficient_subset:
            selected_refs = {id(item) for item in [best_single] + multi_sufficient_subset}
            selected = [
                item
                for item in ranked
                if id(item) in selected_refs
            ]
    else:
        # Case 2: single file is not sufficient; find sufficient multi-file combination.
        if total_count == 1:
            selected = ranked[:1]
        else:
            multi_sufficient_subset, best_multi_subset = _best_subset_by_combinations(ranked, min_size=2)
            selected = multi_sufficient_subset if multi_sufficient_subset is not None else best_multi_subset

    selected_refs = {id(item) for item in selected}
    excluded = [
        item
        for item in ranked
        if id(item) not in selected_refs
    ]

    # Derive a consistent subset score from selected files only.
    selected_avg_sufficiency = _combined_sufficiency(selected)

    selected_avg_relevance = (
        sum(max(0.0, min(1.0, float(item.get("relevance_score") or 0.0))) for item in selected) / len(selected)
        if selected
        else 0.0
    )

    return selected, excluded, selected_avg_sufficiency, selected_avg_relevance


def _build_selection_recommendations(
    selected_items: List[Dict[str, Any]],
    excluded_items: List[Dict[str, Any]],
    total_count: int,
) -> List[str]:
    recommendations: List[str] = []

    if selected_items:
        recommendations.append(
            f"Selected evidence set for sufficiency assessment: {len(selected_items)}/{total_count} file(s) -> {_short_file_list(selected_items)}."
        )

    if excluded_items:
        recommendations.append(
            f"Excluded from minimum sufficient set: {len(excluded_items)} file(s) -> {_short_file_list(excluded_items)}."
        )
        for item in excluded_items[:5]:
            filename = str(item.get("filename") or "unknown")
            reason = str(item.get("exclusion_reason") or _derive_exclusion_reason(item))
            recommendations.append(f"{filename}: {reason}")
        recommendations.append(
            "Improvement suggestion: strengthen excluded files by adding explicit control mapping, date coverage, approver/system identifiers, and independent corroborating references."
        )

    return recommendations


def validate_evidence_ai(
    request_id: str,
    evidence_inventory: List[Dict[str, Any]],
    interpretation: Optional[Any] = None,
    request_text: Optional[str] = None,
) -> Dict[str, Any]:
    validation_id = f"VAL-{uuid4().hex[:12].upper()}"
    total_count = len(evidence_inventory)

    max_prompt_chars = _safe_int_env("VALIDATION_MAX_PROMPT_CHARS", DEFAULT_MAX_VALIDATION_PROMPT_CHARS)
    compact_prompt_chars = _safe_int_env("VALIDATION_COMPACT_MAX_PROMPT_CHARS", DEFAULT_COMPACT_VALIDATION_PROMPT_CHARS)
    max_items = _safe_int_env("VALIDATION_MAX_ITEMS", DEFAULT_MAX_VALIDATION_ITEMS)
    max_interpretation_chars = _safe_int_env("VALIDATION_MAX_INTERPRETATION_CHARS", DEFAULT_MAX_INTERPRETATION_CHARS)


    import time
    timings = {}

    start = time.perf_counter()
    prompt, prompt_stats = _build_validation_prompt(
        request_id=request_id,
        interpretation=interpretation,
        evidence_inventory=evidence_inventory,
        request_text=request_text,
        max_prompt_chars=max_prompt_chars,
        max_items=max_items,
        max_interpretation_chars=max_interpretation_chars,
        compact=False,
    )
    timings["prompt_build"] = time.perf_counter() - start

    try:
        start = time.perf_counter()
        parsed = _invoke_bedrock_json(prompt)
        timings["llm_call"] = time.perf_counter() - start
    except Exception as exc:
        if not _is_context_overflow_error(exc):
            raise

        start = time.perf_counter()
        compact_prompt, compact_stats = _build_validation_prompt(
            request_id=request_id,
            interpretation=interpretation,
            evidence_inventory=evidence_inventory,
            request_text=request_text,
            max_prompt_chars=compact_prompt_chars,
            max_items=max(10, max_items // 2),
            max_interpretation_chars=max(1000, max_interpretation_chars // 2),
            compact=True,
        )
        timings["prompt_build_compact"] = time.perf_counter() - start
        start = time.perf_counter()
        parsed = _invoke_bedrock_json(compact_prompt)
        timings["llm_call_compact"] = time.perf_counter() - start
        prompt_stats = compact_stats

    start = time.perf_counter()
    # ...existing code...
    overall_sufficiency_raw = parsed.get("overall_sufficiency_score", 0.0)
    confidence_raw = parsed.get("confidence", 0.0)
    try:
        overall_sufficiency = max(0.0, min(1.0, float(overall_sufficiency_raw)))
    except (TypeError, ValueError):
        overall_sufficiency = 0.0
    try:
        avg_confidence = max(0.0, min(1.0, float(confidence_raw)))
    except (TypeError, ValueError):
        avg_confidence = 0.0

    bedrock_evidence = parsed.get("evidence") if isinstance(parsed.get("evidence"), list) else []
    by_filename: Dict[str, Dict[str, Any]] = {}
    for item in bedrock_evidence:
        if isinstance(item, dict) and item.get("filename"):
            by_filename[str(item["filename"]).lower()] = item

    validated_items: List[Dict[str, Any]] = []

    for idx, original in enumerate(evidence_inventory):
        candidate = None
        if idx < len(bedrock_evidence) and isinstance(bedrock_evidence[idx], dict):
            candidate = bedrock_evidence[idx]
        if candidate is None:
            candidate = by_filename.get(str(original.get("filename", "")).lower(), {})

        try:
            relevance_score = max(0.0, min(1.0, float(candidate.get("relevance_score", original.get("relevance_score", 0.0)))))
        except (TypeError, ValueError):
            relevance_score = 0.0

        try:
            sufficiency_score = max(0.0, min(1.0, float(candidate.get("sufficiency_score", 0.0))))
        except (TypeError, ValueError):
            sufficiency_score = 0.0

        item_status = _status_from_text(candidate.get("status"))

        validated_items.append(
            {
                "evidence_id": original.get("evidence_id", f"EV-{uuid4().hex[:8].upper()}"),
                "filename": original.get("filename", "unknown"),
                "storage_path": original.get("storage_path", ""),
                "file_type": original.get("file_type", "unknown"),
                "file_size_bytes": original.get("file_size_bytes", 0),
                "source": original.get("source", "upload"),
                "upload_timestamp": original.get("upload_timestamp", datetime.utcnow().isoformat()),
                "relevance_score": relevance_score,
                "sufficiency_score": sufficiency_score,
                "validation_status": item_status.value,
                "validation_notes": str(candidate.get("validation_notes") or "Validated by Bedrock AI."),
                "content_preview": original.get("content_preview", ""),
                "key_findings": original.get("key_findings", []),
                "parser_metadata": original.get("parser_metadata", {}),
                "parsing_strategy": original.get("parsing_strategy", "bedrock_ai_validation"),
            }
        )

    selected_items, excluded_items, selected_sufficiency, selected_relevance = _choose_sufficient_subset(validated_items)
    selected_ids = {str(item.get("evidence_id") or "") for item in selected_items}

    for item in validated_items:
        included = str(item.get("evidence_id") or "") in selected_ids
        item["included_in_sufficiency_set"] = included
        if included:
            item["exclusion_reason"] = ""
        else:
            item["exclusion_reason"] = _derive_exclusion_reason(item)

    sufficient_count = len(selected_items)
    insufficient_count = max(0, total_count - sufficient_count)

    overall_sufficiency = max(0.0, min(1.0, float(selected_sufficiency if selected_items else overall_sufficiency)))
    overall_status = _status_from_sufficiency(overall_sufficiency)

    recommendations_raw = parsed.get("gap_recommendations") if isinstance(parsed.get("gap_recommendations"), list) else []
    selection_recommendations = _build_selection_recommendations(selected_items, excluded_items, total_count)
    sufficiency_conclusion = _build_sufficiency_conclusion(
        overall_status=overall_status,
        overall_sufficiency=overall_sufficiency,
        selected_items=selected_items,
        total_count=total_count,
    )
    recommendations = _merge_improvement_recommendations(
        [sufficiency_conclusion, *[str(item) for item in selection_recommendations + recommendations_raw]],
        overall_sufficiency,
    )

    validation_result = EvidenceValidationResult(
        validation_id=validation_id,
        request_id=request_id,
        timestamp=datetime.utcnow(),
        total_evidence_items=total_count,
        sufficient_items=sufficient_count,
        insufficient_items=insufficient_count,
        overall_sufficiency_score=overall_sufficiency,
        overall_validation_status=overall_status,
        evidence_items=[],
        gap_recommendations=[str(item) for item in recommendations],
        average_confidence_score=avg_confidence,
    )

    timings["post_processing"] = time.perf_counter() - start
    print(f"[validate_evidence_ai] timings: {timings}")

    logs = [
        log_step(
            agent="validation_agent_ai",
            request_id=request_id,
            message=(
                f"Bedrock validation completed over {total_count} evidence item(s). "
                f"Selected subset: {sufficient_count}/{total_count}. Overall status: {overall_status.value}. "
                f"Prompt items included: {prompt_stats.get('included_items', 0)}/{total_count}; "
                f"omitted: {prompt_stats.get('omitted_items', 0)}; "
                f"prompt chars: {prompt_stats.get('prompt_chars', 0)}. "
                f"Timings: {timings}"
            ),
        )
    ]

    return {
        "validation_id": validation_id,
        "sufficient": overall_status == ValidationStatus.SUFFICIENT,
        "overall_sufficiency_score": overall_sufficiency,
        "sufficiency_conclusion": sufficiency_conclusion,
        "confidence": avg_confidence,
        "timings": timings,
        "evidence": [
            {
                "evidence_id": item.get("evidence_id"),
                "filename": item.get("filename"),
                "sufficiency_score": item.get("sufficiency_score"),
                "status": item.get("validation_status"),
                "included_in_sufficiency_set": item.get("included_in_sufficiency_set", False),
                "exclusion_reason": item.get("exclusion_reason", ""),
            }
            for item in validated_items
        ],
        "selected_evidence": [
            {
                "evidence_id": item.get("evidence_id"),
                "filename": item.get("filename"),
                "relevance_score": item.get("relevance_score"),
                "sufficiency_score": item.get("sufficiency_score"),
            }
            for item in selected_items
        ],
        "selected_validated_items": selected_items,
        "excluded_evidence": [
            {
                "evidence_id": item.get("evidence_id"),
                "filename": item.get("filename"),
                "relevance_score": item.get("relevance_score"),
                "sufficiency_score": item.get("sufficiency_score"),
                "reason": item.get("exclusion_reason", ""),
            }
            for item in excluded_items
        ],
        "selection_summary": {
            "selected_count": len(selected_items),
            "excluded_count": len(excluded_items),
            "selected_average_relevance": selected_relevance,
            "selected_average_sufficiency": selected_sufficiency,
        },
        "validated_items": validated_items,
        "gap_recommendations": [str(item) for item in recommendations],
        "logs": logs,
        "validation_result": validation_result,
    }
