from __future__ import annotations

import hashlib
import json
import math
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html import unescape
from threading import Event, Lock, Thread
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote_plus, urlparse
from urllib.request import Request, urlopen


_CACHE_LOCK = Lock()
_CACHE_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", ".system", "knowledge_base")
)
_CACHE_PATH = os.path.join(_CACHE_DIR, "professional_standards_cache.json")
_DEFAULT_TTL_DAYS = 7
_DEFAULT_REFRESH_INTERVAL_HOURS = 24
_EXTERNAL_SEARCH_TTL_DAYS = 3
_CHUNK_CHAR_LIMIT = 900
_CHUNK_OVERLAP = 160
_MIN_EXTERNAL_SEARCH_SCORE = 0.22

_REFRESH_STOP_EVENT = Event()
_REFRESH_THREAD: Optional[Thread] = None

_STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "if", "in", "into",
    "is", "it", "of", "on", "or", "that", "the", "their", "then", "there", "these", "this", "to",
    "was", "were", "when", "with", "within", "using", "use", "used", "under", "over", "than", "via",
    "your", "you", "we", "our", "they", "them", "those", "such", "can", "could", "should", "would",
}


@dataclass(frozen=True)
class StandardsSource:
    source_id: str
    authority: str
    standard_code: str
    title: str
    category: str
    url: str
    summary: str
    keywords: List[str]


_SOURCE_REGISTRY: List[StandardsSource] = [
    StandardsSource(
        source_id="isa-200",
        authority="IAASB",
        standard_code="ISA 200",
        title="Overall Objectives of the Independent Auditor and the Conduct of an Audit in Accordance with International Standards on Auditing",
        category="external_audit",
        url="https://www.iaasb.org/publications/international-standard-auditing-isa-200-overall-objectives-independent-auditor-and-conduct-audit",
        summary="Use when the request requires overall audit objectives, professional scepticism, judgment, and reasonable assurance framing.",
        keywords=["audit objective", "reasonable assurance", "professional judgement", "skepticism", "external audit"],
    ),
    StandardsSource(
        source_id="isa-230",
        authority="IAASB",
        standard_code="ISA 230",
        title="Audit Documentation",
        category="documentation",
        url="https://www.iaasb.org/publications/international-standard-auditing-isa-230-audit-documentation",
        summary="Use when the request requires documentation quality, traceability, retention, and support for significant judgments.",
        keywords=["documentation", "audit trail", "retention", "working papers", "traceability"],
    ),
    StandardsSource(
        source_id="isa-315",
        authority="IAASB",
        standard_code="ISA 315",
        title="Identifying and Assessing the Risks of Material Misstatement",
        category="risk_assessment",
        url="https://www.iaasb.org/publications/international-standard-auditing-isa-315-revised-2019-identifying-and-assessing-risks-material",
        summary="Use when the request requires risk assessment, controls understanding, walkthroughs, and risk-response alignment.",
        keywords=["risk", "risk assessment", "control", "walkthrough", "material misstatement", "entity level"],
    ),
    StandardsSource(
        source_id="isa-330",
        authority="IAASB",
        standard_code="ISA 330",
        title="The Auditor's Responses to Assessed Risks",
        category="risk_response",
        url="https://www.iaasb.org/publications/international-standard-auditing-isa-330-auditors-responses-assessed-risks",
        summary="Use when the request requires linking audit procedures and evidence sufficiency to assessed risks and control reliance.",
        keywords=["response to risk", "test of controls", "substantive", "assessed risk", "control reliance"],
    ),
    StandardsSource(
        source_id="isa-500",
        authority="IAASB",
        standard_code="ISA 500",
        title="Audit Evidence",
        category="audit_evidence",
        url="https://www.iaasb.org/publications/international-standard-auditing-isa-500-audit-evidence",
        summary="Primary reference for evidence relevance, reliability, sufficiency, corroboration, and source quality.",
        keywords=["audit evidence", "relevance", "reliability", "sufficiency", "appropriateness", "corroboration"],
    ),
    StandardsSource(
        source_id="isa-520",
        authority="IAASB",
        standard_code="ISA 520",
        title="Analytical Procedures",
        category="audit_procedures",
        url="https://www.iaasb.org/publications/international-standard-auditing-isa-520-analytical-procedures",
        summary="Use when the request depends on trend analysis, ratio review, expected relationships, or anomaly follow-up.",
        keywords=["analytical procedures", "trend", "ratio", "expectation", "variance", "anomaly"],
    ),
    StandardsSource(
        source_id="isa-530",
        authority="IAASB",
        standard_code="ISA 530",
        title="Audit Sampling",
        category="sampling",
        url="https://www.iaasb.org/publications/international-standard-auditing-isa-530-audit-sampling",
        summary="Use when the request requires sample design, representativeness, and evaluating selected items.",
        keywords=["sampling", "sample", "population", "representative", "selection"],
    ),
    StandardsSource(
        source_id="isa-580",
        authority="IAASB",
        standard_code="ISA 580",
        title="Written Representations",
        category="audit_evidence",
        url="https://www.iaasb.org/publications/international-standard-auditing-isa-580-written-representations",
        summary="Use when representations, management confirmations, or limitations of representation evidence are relevant.",
        keywords=["representation", "management representation", "confirmation", "written representation"],
    ),
    StandardsSource(
        source_id="pcaob-as1105",
        authority="PCAOB",
        standard_code="AS 1105",
        title="Audit Evidence",
        category="audit_evidence",
        url="https://pcaobus.org/oversight/standards/auditing-standards/details/AS1105",
        summary="Primary PCAOB reference for evidence persuasiveness, relevance, reliability, and corroborative support.",
        keywords=["pcaob", "audit evidence", "persuasive", "relevance", "reliability", "corroboration"],
    ),
    StandardsSource(
        source_id="pcaob-as1215",
        authority="PCAOB",
        standard_code="AS 1215",
        title="Audit Documentation",
        category="documentation",
        url="https://pcaobus.org/oversight/standards/auditing-standards/details/AS1215",
        summary="Use when the request requires documentation completeness, reviewability, and retention support.",
        keywords=["documentation", "work papers", "retention", "audit trail", "pcaob"],
    ),
    StandardsSource(
        source_id="pcaob-as2110",
        authority="PCAOB",
        standard_code="AS 2110",
        title="Identifying and Assessing Risks of Material Misstatement",
        category="risk_assessment",
        url="https://pcaobus.org/oversight/standards/auditing-standards/details/AS2110",
        summary="Use when the request requires risk identification, control understanding, and linkage between risks and testing.",
        keywords=["risk", "material misstatement", "control understanding", "risk assessment", "pcaob"],
    ),
    StandardsSource(
        source_id="pcaob-as2201",
        authority="PCAOB",
        standard_code="AS 2201",
        title="An Audit of Internal Control Over Financial Reporting That Is Integrated with An Audit of Financial Statements",
        category="controls",
        url="https://pcaobus.org/oversight/standards/auditing-standards/details/AS2201",
        summary="Use when the request concerns internal controls, control design, operating effectiveness, and integrated audit conclusions.",
        keywords=["internal control", "icfr", "control design", "operating effectiveness", "control testing"],
    ),
    StandardsSource(
        source_id="iia-giastandards",
        authority="IIA",
        standard_code="Global Internal Audit Standards",
        title="Global Internal Audit Standards",
        category="internal_audit",
        url="https://www.theiia.org/en/standards/2024-global-internal-audit-standards/",
        summary="Primary reference for internal audit quality, independence, documentation, communication, and engagement performance.",
        keywords=["internal audit", "iia", "engagement performance", "documentation", "communication", "quality"],
    ),
    StandardsSource(
        source_id="isaca-cobit",
        authority="ISACA",
        standard_code="COBIT",
        title="COBIT Framework",
        category="it_controls",
        url="https://www.isaca.org/resources/cobit",
        summary="Use when the request concerns governance of enterprise IT, control objectives, process capability, and technology assurance.",
        keywords=["cobit", "it governance", "it controls", "technology assurance", "process capability", "igtc", "gitc"],
    ),
    StandardsSource(
        source_id="nist-csf-2",
        authority="NIST",
        standard_code="NIST CSF 2.0",
        title="Cybersecurity Framework 2.0",
        category="it_controls",
        url="https://www.nist.gov/cyberframework",
        summary="Use when the request involves cybersecurity governance, control environments, IT general controls, and compliance alignment.",
        keywords=["itgc", "gitc", "igtc", "cybersecurity", "technology control", "governance", "compliance"],
    ),
    StandardsSource(
        source_id="nist-800-53",
        authority="NIST",
        standard_code="SP 800-53",
        title="Security and Privacy Controls for Information Systems and Organizations",
        category="it_controls",
        url="https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final",
        summary="Use when the request concerns control activities, logical access, change management, operations, monitoring, and compliance controls.",
        keywords=["logical access", "change management", "operations", "monitoring", "security control", "it general control"],
    ),
    StandardsSource(
        source_id="coso-ic",
        authority="COSO",
        standard_code="COSO Internal Control",
        title="Internal Control - Integrated Framework",
        category="controls",
        url="https://www.coso.org/internal-control-integrated-framework",
        summary="Use when the request requires internal control principles, control environment, risk assessment, control activities, information, and monitoring.",
        keywords=["coso", "internal control", "control environment", "monitoring", "control activity", "compliance"],
    ),
]

_AUTHORITATIVE_DOMAINS = sorted(
    {
        urlparse(source.url).netloc.lower().replace("www.", "")
        for source in _SOURCE_REGISTRY
    }
)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def _strip_html(value: str) -> str:
    text = re.sub(r"<script[\s\S]*?</script>", " ", value, flags=re.IGNORECASE)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", unescape(text)).strip()


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def _cache_expired(last_refreshed_at: Optional[str], ttl_days: int) -> bool:
    parsed = _parse_iso(last_refreshed_at)
    if parsed is None:
        return True
    return parsed < (_utc_now() - timedelta(days=max(1, ttl_days)))


def _query_cache_expired(retrieved_at: Optional[str], ttl_days: int) -> bool:
    return _cache_expired(retrieved_at, ttl_days)


def _get_env_int(name: str, default: int, *, minimum: int = 1) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return max(minimum, int(str(raw).strip()))
    except (TypeError, ValueError):
        return default


def get_refresh_configuration() -> Dict[str, int]:
    ttl_days = _get_env_int("EVIDEX_STANDARDS_TTL_DAYS", _DEFAULT_TTL_DAYS)
    interval_hours = _get_env_int(
        "EVIDEX_STANDARDS_REFRESH_INTERVAL_HOURS",
        _DEFAULT_REFRESH_INTERVAL_HOURS,
    )
    return {
        "ttl_days": ttl_days,
        "refresh_interval_hours": interval_hours,
        "external_search_ttl_days": _EXTERNAL_SEARCH_TTL_DAYS,
    }


def _ensure_cache_defaults(payload: Dict[str, Any]) -> Dict[str, Any]:
    payload.setdefault("sources", {})
    payload.setdefault("chunks", [])
    payload.setdefault("index", {"idf": {}, "chunk_count": 0})
    payload.setdefault("external_search_cache", {})
    return payload


def _load_cache() -> Dict[str, Any]:
    if not os.path.isfile(_CACHE_PATH):
        return _ensure_cache_defaults({})
    try:
        with open(_CACHE_PATH, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if isinstance(payload, dict):
            return _ensure_cache_defaults(payload)
    except Exception:
        pass
    return _ensure_cache_defaults({})


def _save_cache(payload: Dict[str, Any]) -> None:
    os.makedirs(_CACHE_DIR, exist_ok=True)
    with open(_CACHE_PATH, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=True)


def _tokenize(value: str) -> List[str]:
    tokens = re.findall(r"[a-z0-9]{2,}", _normalize_text(value))
    return [token for token in tokens if token not in _STOPWORDS]


def _keyword_overlap_score(keywords: Iterable[str], request_text: str) -> float:
    normalized = _normalize_text(request_text)
    if not normalized:
        return 0.0
    score = 0.0
    for keyword in keywords:
        keyword_norm = _normalize_text(keyword)
        if keyword_norm and keyword_norm in normalized:
            score += max(1.0, len(keyword_norm.split()) * 0.8)
    return score


def _extract_domain(url: str) -> str:
    return urlparse(url).netloc.lower().replace("www.", "")


def _is_authoritative_url(url: str) -> bool:
    domain = _extract_domain(url)
    return any(domain == allowed or domain.endswith(f".{allowed}") for allowed in _AUTHORITATIVE_DOMAINS)


def _sentence_chunks(text: str, *, chunk_chars: int, overlap_chars: int) -> List[str]:
    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    if not normalized:
        return []

    sentences = re.split(r"(?<=[.!?])\s+", normalized)
    chunks: List[str] = []
    current = ""

    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue

        candidate = sentence if not current else f"{current} {sentence}"
        if len(candidate) <= chunk_chars:
            current = candidate
            continue

        if current:
            chunks.append(current)
            overlap = current[-overlap_chars:].strip()
            current = f"{overlap} {sentence}".strip() if overlap else sentence
        else:
            chunks.append(sentence[:chunk_chars].strip())
            current = sentence[max(0, chunk_chars - overlap_chars):].strip()

    if current:
        chunks.append(current)

    deduped: List[str] = []
    seen: set[str] = set()
    for chunk in chunks:
        if chunk and chunk not in seen:
            seen.add(chunk)
            deduped.append(chunk)
    return deduped


def _fetch_page(url: str, timeout_seconds: int = 10) -> Dict[str, Optional[str]]:
    request = Request(
        url,
        headers={
            "User-Agent": "EviDex-StandardsKB/2.0 (+rag refresh)",
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8", errors="replace")
            final_url = response.geturl()
    except (HTTPError, URLError, TimeoutError, ValueError):
        return {
            "title": None,
            "body_text": None,
            "raw_html": None,
            "status": "unreachable",
            "final_url": url,
        }

    title_match = re.search(r"<title>(.*?)</title>", raw, flags=re.IGNORECASE | re.DOTALL)
    title = _strip_html(title_match.group(1)) if title_match else None
    body_text = _strip_html(raw)
    return {
        "title": title,
        "body_text": body_text,
        "raw_html": raw,
        "status": "refreshed",
        "final_url": final_url,
    }


def _build_index_chunks(source: StandardsSource, source_entry: Dict[str, Any]) -> List[Dict[str, Any]]:
    text_parts = [
        source.standard_code,
        source.title,
        source.summary,
        str(source_entry.get("page_excerpt") or ""),
        str(source_entry.get("full_text") or ""),
    ]
    base_text = " ".join(part for part in text_parts if part).strip()
    chunks = _sentence_chunks(
        base_text,
        chunk_chars=_CHUNK_CHAR_LIMIT,
        overlap_chars=_CHUNK_OVERLAP,
    )
    output: List[Dict[str, Any]] = []
    for index, chunk_text in enumerate(chunks, start=1):
        output.append(
            {
                "chunk_id": f"{source.source_id}-chunk-{index:03}",
                "source_id": source.source_id,
                "authority": source.authority,
                "standard_code": source.standard_code,
                "title": source_entry.get("title") or source.title,
                "category": source.category,
                "url": source_entry.get("url") or source.url,
                "summary": source.summary,
                "keywords": list(source.keywords),
                "text": chunk_text,
                "origin": "registry",
            }
        )
    return output


def _build_tfidf_index(chunks: List[Dict[str, Any]]) -> Dict[str, Any]:
    document_frequency: Dict[str, int] = {}
    tokenized_chunks: List[List[str]] = []

    for chunk in chunks:
        tokens = _tokenize(chunk.get("text", ""))
        tokenized_chunks.append(tokens)
        for token in set(tokens):
            document_frequency[token] = document_frequency.get(token, 0) + 1

    chunk_count = len(chunks)
    idf = {
        term: math.log((chunk_count + 1) / (freq + 1)) + 1.0
        for term, freq in document_frequency.items()
    }

    indexed_chunks: List[Dict[str, Any]] = []
    for chunk, tokens in zip(chunks, tokenized_chunks):
        term_counts: Dict[str, int] = {}
        for token in tokens:
            term_counts[token] = term_counts.get(token, 0) + 1

        vector: Dict[str, float] = {}
        for term, count in term_counts.items():
            vector[term] = (1.0 + math.log(count)) * idf.get(term, 1.0)

        norm = math.sqrt(sum(weight * weight for weight in vector.values())) or 1.0
        normalized_vector = {
            term: round(weight / norm, 6)
            for term, weight in sorted(vector.items(), key=lambda item: item[1], reverse=True)[:80]
        }

        enriched = dict(chunk)
        enriched["token_count"] = len(tokens)
        enriched["vector"] = normalized_vector
        indexed_chunks.append(enriched)

    return {
        "idf": {term: round(weight, 6) for term, weight in idf.items()},
        "chunk_count": chunk_count,
        "chunks": indexed_chunks,
    }


def _query_vector(request_text: str, idf: Dict[str, float]) -> Dict[str, float]:
    term_counts: Dict[str, int] = {}
    for token in _tokenize(request_text):
        term_counts[token] = term_counts.get(token, 0) + 1

    vector: Dict[str, float] = {}
    for term, count in term_counts.items():
        vector[term] = (1.0 + math.log(count)) * float(idf.get(term, 1.0))

    norm = math.sqrt(sum(weight * weight for weight in vector.values())) or 1.0
    return {term: weight / norm for term, weight in vector.items()}


def _score_chunk(chunk: Dict[str, Any], query_vector: Dict[str, float], request_text: str) -> float:
    vector = chunk.get("vector", {}) if isinstance(chunk.get("vector"), dict) else {}
    cosine = 0.0
    for term, weight in query_vector.items():
        cosine += weight * float(vector.get(term, 0.0) or 0.0)

    keyword_boost = _keyword_overlap_score(chunk.get("keywords", []), request_text) * 0.025
    category_boost = 0.08 if _normalize_text(chunk.get("category", "")).replace("_", " ") in _normalize_text(request_text) else 0.0
    authority_boost = 0.03 if _normalize_text(chunk.get("authority", "")) in _normalize_text(request_text) else 0.0
    title_text = f"{chunk.get('standard_code', '')} {chunk.get('title', '')}"
    title_boost = 0.06 if any(term in _normalize_text(title_text) for term in _tokenize(request_text)[:6]) else 0.0
    return cosine + keyword_boost + category_boost + authority_boost + title_boost


def _merge_ranked_chunks(primary: List[Dict[str, Any]], secondary: List[Dict[str, Any]], max_chunks: int) -> List[Dict[str, Any]]:
    merged: Dict[str, Dict[str, Any]] = {}
    for item in primary + secondary:
        chunk_id = str(item.get("chunk_id") or "")
        existing = merged.get(chunk_id)
        if existing is None or float(item.get("score", 0.0) or 0.0) > float(existing.get("score", 0.0) or 0.0):
            merged[chunk_id] = item
    return sorted(merged.values(), key=lambda item: float(item.get("score", 0.0) or 0.0), reverse=True)[:max_chunks]


def _rank_chunks(chunks: List[Dict[str, Any]], request_text: str, *, max_chunks: int) -> List[Dict[str, Any]]:
    if not chunks:
        return []

    index = _build_tfidf_index(chunks)
    query_vector = _query_vector(request_text, index.get("idf", {}))
    ranked: List[Dict[str, Any]] = []
    for chunk in index.get("chunks", []):
        score = _score_chunk(chunk, query_vector, request_text)
        if score <= 0:
            continue
        enriched = dict(chunk)
        enriched["score"] = round(score, 6)
        ranked.append(enriched)

    ranked.sort(key=lambda item: float(item.get("score", 0.0) or 0.0), reverse=True)
    return ranked[:max_chunks]


def _extract_duckduckgo_links(html_text: str) -> List[Tuple[str, str]]:
    matches = re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html_text, flags=re.IGNORECASE | re.DOTALL)
    results: List[Tuple[str, str]] = []
    seen: set[str] = set()
    for href, raw_title in matches:
        candidate = href.strip()
        if candidate.startswith("//"):
            candidate = f"https:{candidate}"
        parsed = urlparse(candidate)
        if "duckduckgo.com" in parsed.netloc and parsed.path.startswith("/l/"):
            redirected = parse_qs(parsed.query).get("uddg", [""])[0]
            if redirected:
                candidate = redirected
        if not candidate.startswith("http"):
            continue
        if not _is_authoritative_url(candidate):
            continue
        if candidate in seen:
            continue
        seen.add(candidate)
        title = _strip_html(raw_title)
        if title:
            results.append((candidate, title))
    return results


def _search_authoritative_web(request_text: str, max_results: int = 4) -> Dict[str, Any]:
    query = f"{request_text} ISA PCAOB internal audit ITGC controls compliance authoritative standard"
    url = f"https://duckduckgo.com/html/?q={quote_plus(query)}"
    fetched = _fetch_page(url, timeout_seconds=10)
    html_excerpt = str(fetched.get("raw_html") or "")
    links = _extract_duckduckgo_links(html_excerpt)
    results: List[Dict[str, Any]] = []
    for link, title in links[:max_results]:
        page = _fetch_page(link, timeout_seconds=10)
        body_text = str(page.get("body_text") or "")
        excerpt = body_text[:1200].strip()
        if not excerpt:
            continue
        results.append(
            {
                "url": link,
                "title": page.get("title") or title,
                "authority": _extract_domain(link),
                "excerpt": excerpt,
                "retrieved_at": _utc_now().isoformat(),
                "origin": "external_search",
            }
        )
    return {
        "query": query,
        "retrieved_at": _utc_now().isoformat(),
        "results": results,
    }


def _external_search_chunks(search_payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    chunks: List[Dict[str, Any]] = []
    for index, result in enumerate(search_payload.get("results", []), start=1):
        excerpt = str(result.get("excerpt") or "").strip()
        if not excerpt:
            continue
        title = str(result.get("title") or f"External source {index}")
        url = str(result.get("url") or "")
        domain = _extract_domain(url)
        for chunk_index, chunk_text in enumerate(
            _sentence_chunks(excerpt, chunk_chars=_CHUNK_CHAR_LIMIT, overlap_chars=_CHUNK_OVERLAP),
            start=1,
        ):
            chunks.append(
                {
                    "chunk_id": f"external-{index:02}-{chunk_index:02}",
                    "source_id": f"external-{index:02}",
                    "authority": domain,
                    "standard_code": domain,
                    "title": title,
                    "category": "external_search",
                    "url": url,
                    "summary": title,
                    "keywords": _tokenize(title),
                    "text": chunk_text,
                    "origin": "external_search",
                }
            )
    return chunks


def refresh_standards_knowledge_base(force: bool = False, ttl_days: Optional[int] = None) -> Dict[str, Any]:
    ttl_days = ttl_days or get_refresh_configuration()["ttl_days"]
    with _CACHE_LOCK:
        cache = _load_cache()
        sources_cache = cache.setdefault("sources", {})
        refreshed_any = False

        for source in _SOURCE_REGISTRY:
            existing = sources_cache.get(source.source_id, {}) if isinstance(sources_cache, dict) else {}
            should_refresh = force or _cache_expired(existing.get("last_refreshed_at"), ttl_days)
            if not should_refresh:
                continue

            fetched = _fetch_page(source.url)
            refreshed_at = _utc_now().isoformat()
            full_text = str(fetched.get("body_text") or "")[:24000]
            page_excerpt = full_text[:1800].strip() if full_text else source.summary

            sources_cache[source.source_id] = {
                "source_id": source.source_id,
                "authority": source.authority,
                "standard_code": source.standard_code,
                "title": fetched.get("title") or source.title,
                "category": source.category,
                "url": fetched.get("final_url") or source.url,
                "summary": source.summary,
                "keywords": list(source.keywords),
                "page_excerpt": page_excerpt,
                "full_text": full_text,
                "refresh_status": fetched.get("status") or "cached",
                "last_refreshed_at": refreshed_at,
            }
            refreshed_any = True

        if refreshed_any or not cache.get("chunks"):
            chunks: List[Dict[str, Any]] = []
            for source in _SOURCE_REGISTRY:
                source_entry = sources_cache.get(source.source_id, {}) if isinstance(sources_cache, dict) else {}
                chunks.extend(_build_index_chunks(source, source_entry))

            built_index = _build_tfidf_index(chunks)
            cache["chunks"] = built_index.get("chunks", [])
            cache["index"] = {
                "idf": built_index.get("idf", {}),
                "chunk_count": built_index.get("chunk_count", 0),
            }
            cache["updated_at"] = _utc_now().isoformat()
            _save_cache(cache)
        elif not os.path.isfile(_CACHE_PATH):
            cache["updated_at"] = _utc_now().isoformat()
            _save_cache(cache)

        return cache


def _source_to_dict(source: StandardsSource, cache_entry: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cache_entry = cache_entry or {}
    return {
        "source_id": source.source_id,
        "authority": source.authority,
        "standard_code": source.standard_code,
        "title": cache_entry.get("title") or source.title,
        "category": source.category,
        "url": cache_entry.get("url") or source.url,
        "summary": source.summary,
        "page_excerpt": cache_entry.get("page_excerpt") or source.summary,
        "keywords": list(source.keywords),
        "last_refreshed_at": cache_entry.get("last_refreshed_at"),
        "refresh_status": cache_entry.get("refresh_status") or "seeded",
    }


def _registry_source_map() -> Dict[str, StandardsSource]:
    return {source.source_id: source for source in _SOURCE_REGISTRY}


def _request_cache_key(request_text: str) -> str:
    normalized = _normalize_text(request_text)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _get_cached_external_results(request_text: str, cache: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    query_key = _request_cache_key(request_text)
    external_cache = cache.setdefault("external_search_cache", {})
    entry = external_cache.get(query_key)
    if isinstance(entry, dict) and not _query_cache_expired(entry.get("retrieved_at"), _EXTERNAL_SEARCH_TTL_DAYS):
        return entry
    return None


def _persist_external_results(request_text: str, cache: Dict[str, Any], search_payload: Dict[str, Any]) -> None:
    query_key = _request_cache_key(request_text)
    external_cache = cache.setdefault("external_search_cache", {})
    external_cache[query_key] = search_payload
    cache["updated_at"] = _utc_now().isoformat()
    _save_cache(cache)


def _retrieve_external_results(request_text: str, cache: Dict[str, Any], allow_external_search: bool) -> Optional[Dict[str, Any]]:
    cached = _get_cached_external_results(request_text, cache)
    if cached is not None:
        return cached
    if not allow_external_search:
        return None
    payload = _search_authoritative_web(request_text)
    _persist_external_results(request_text, cache, payload)
    return payload


def _aggregate_references(ranked_chunks: List[Dict[str, Any]], cache: Dict[str, Any]) -> List[Dict[str, Any]]:
    source_map = _registry_source_map()
    cache_sources = cache.get("sources", {}) if isinstance(cache, dict) else {}
    aggregated: Dict[str, Dict[str, Any]] = {}

    for chunk in ranked_chunks:
        source_id = str(chunk.get("source_id") or "")
        score = float(chunk.get("score", 0.0) or 0.0)
        existing = aggregated.get(source_id)
        if existing is None:
            if source_id in source_map:
                aggregated[source_id] = _source_to_dict(source_map[source_id], cache_sources.get(source_id))
            else:
                aggregated[source_id] = {
                    "source_id": source_id,
                    "authority": chunk.get("authority"),
                    "standard_code": chunk.get("standard_code"),
                    "title": chunk.get("title"),
                    "category": chunk.get("category"),
                    "url": chunk.get("url"),
                    "summary": chunk.get("summary") or chunk.get("title"),
                    "page_excerpt": chunk.get("text"),
                    "keywords": list(chunk.get("keywords", [])),
                    "refresh_status": chunk.get("origin"),
                    "last_refreshed_at": None,
                }
                existing = aggregated[source_id]
        aggregated[source_id]["retrieval_score"] = max(score, float(aggregated[source_id].get("retrieval_score", 0.0) or 0.0))

    return sorted(aggregated.values(), key=lambda item: float(item.get("retrieval_score", 0.0) or 0.0), reverse=True)


def get_applicable_standards(
    request_text: str,
    max_items: int = 6,
    *,
    max_citations: int = 8,
    allow_external_search: bool = True,
) -> Dict[str, Any]:
    cache = refresh_standards_knowledge_base(force=False)
    indexed_chunks = list(cache.get("chunks", []) or [])
    ranked_registry_chunks = _rank_chunks(indexed_chunks, request_text, max_chunks=max(max_citations * 2, 12))

    external_payload: Optional[Dict[str, Any]] = None
    top_score = float(ranked_registry_chunks[0].get("score", 0.0) or 0.0) if ranked_registry_chunks else 0.0
    unique_registry_sources = {str(item.get("source_id") or "") for item in ranked_registry_chunks[:max_citations]}

    if top_score < _MIN_EXTERNAL_SEARCH_SCORE or len(unique_registry_sources) < 2:
        external_payload = _retrieve_external_results(request_text, cache, allow_external_search)

    ranked_external_chunks: List[Dict[str, Any]] = []
    if external_payload:
        ranked_external_chunks = _rank_chunks(
            _external_search_chunks(external_payload),
            request_text,
            max_chunks=max(max_citations, 4),
        )

    ranked_chunks = _merge_ranked_chunks(ranked_registry_chunks, ranked_external_chunks, max_chunks=max_citations)
    references = _aggregate_references(ranked_chunks[:max_items * 2], cache)[: max(1, max_items)]

    citations: List[Dict[str, Any]] = []
    for rank, chunk in enumerate(ranked_chunks[:max_citations], start=1):
        citations.append(
            {
                "citation_id": f"STD-CIT-{rank:03}",
                "rank": rank,
                "score": float(chunk.get("score", 0.0) or 0.0),
                "source_id": chunk.get("source_id"),
                "authority": chunk.get("authority"),
                "standard_code": chunk.get("standard_code"),
                "title": chunk.get("title"),
                "url": chunk.get("url"),
                "excerpt": chunk.get("text"),
                "origin": chunk.get("origin", "registry"),
                "category": chunk.get("category"),
            }
        )

    summary_lines = [
        "Use the following authoritative standards and citations as the primary professional reference for validation and conclusion decisions:"
    ]
    for citation in citations:
        summary_lines.append(
            f"- [{citation['citation_id']}] {citation['standard_code']} ({citation['authority']}): {citation['excerpt']} Source: {citation['url']}"
        )

    if external_payload and external_payload.get("results"):
        summary_lines.append(
            "Additional authoritative web search results were incorporated because the request required broader or stronger professional coverage."
        )

    return {
        "request_text": request_text,
        "generated_at": _utc_now().isoformat(),
        "references": references,
        "citations": citations,
        "summary": "\n".join(summary_lines),
        "knowledge_base_updated_at": cache.get("updated_at") if isinstance(cache, dict) else None,
        "index": {
            "chunk_count": int(cache.get("index", {}).get("chunk_count", 0) or 0),
            "source_count": len(cache.get("sources", {}) if isinstance(cache, dict) else {}),
        },
        "refresh_config": get_refresh_configuration(),
        "external_search": {
            "used": bool(external_payload and external_payload.get("results")),
            "query": external_payload.get("query") if external_payload else None,
            "result_count": len(external_payload.get("results", [])) if external_payload else 0,
            "retrieved_at": external_payload.get("retrieved_at") if external_payload else None,
        },
    }


def build_standards_prompt_context(
    request_text: str,
    max_items: int = 6,
    *,
    allow_external_search: bool = True,
) -> str:
    guidance = get_applicable_standards(
        request_text=request_text,
        max_items=max_items,
        allow_external_search=allow_external_search,
    )
    return str(guidance.get("summary") or "")


def _background_refresh_loop(interval_hours: int, ttl_days: int) -> None:
    refresh_standards_knowledge_base(force=False, ttl_days=ttl_days)
    while not _REFRESH_STOP_EVENT.wait(max(1, interval_hours) * 3600):
        try:
            refresh_standards_knowledge_base(force=False, ttl_days=ttl_days)
        except Exception:
            continue


def start_background_refresh(
    interval_hours: Optional[int] = None,
    ttl_days: Optional[int] = None,
) -> None:
    global _REFRESH_THREAD
    config = get_refresh_configuration()
    resolved_interval_hours = interval_hours or config["refresh_interval_hours"]
    resolved_ttl_days = ttl_days or config["ttl_days"]
    with _CACHE_LOCK:
        if _REFRESH_THREAD and _REFRESH_THREAD.is_alive():
            return
        _REFRESH_STOP_EVENT.clear()
        _REFRESH_THREAD = Thread(
            target=_background_refresh_loop,
            args=(resolved_interval_hours, resolved_ttl_days),
            name="evidex-standards-refresh",
            daemon=True,
        )
        _REFRESH_THREAD.start()


def stop_background_refresh() -> None:
    global _REFRESH_THREAD
    _REFRESH_STOP_EVENT.set()
    if _REFRESH_THREAD and _REFRESH_THREAD.is_alive():
        _REFRESH_THREAD.join(timeout=2.0)
    _REFRESH_THREAD = None
