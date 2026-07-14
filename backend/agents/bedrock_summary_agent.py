import os
import sys
import json
import re
import ssl
import atexit
import importlib
import tempfile
from typing import Any, Dict, List

# Inject the OS trust store so all SSL (including boto3) uses Windows certs.
try:
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass  # not installed; _resolve_tls_verify() will use the manual bundle

try:
    # Supports enterprise cert chains on Windows corp networks.
    import certifi_win32  # noqa: F401
except ImportError:
    certifi_win32 = None


# Import get_bedrock_client from test_bedrock.py
sys.path.append(os.path.join(os.path.dirname(__file__), '..'))
try:
    from test_bedrock import get_bedrock_client
except ImportError:
    get_bedrock_client = None
try:
    import boto3
except ImportError:
    boto3 = None

try:
    import certifi
except ImportError:
    certifi = None

DEFAULT_MODEL_ID = "nvidia.nemotron-nano-12b-v2"
MAX_DOC_CHARS = 3000
MAX_DOCS = 6
_AWS_ENV_CREDENTIAL_KEYS = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
)

_PLACEHOLDER_CREDENTIAL_MARKERS = (
    "your_key",
    "your_secret",
    "replace_me",
    "placeholder",
    "changeme",
    "example",
    "dummy",
    "test",
)

# Module-level cache so the Windows bundle is only built once per process.
_win_ca_bundle_path: str | None = None
_win_ca_bundle_attempted: bool = False


def _build_windows_ca_bundle() -> str | None:
    """
    Extract certificates from the Windows trust store and merge with certifi
    into a single PEM temp file.  Returns the path, or None if not possible.
    """
    global _win_ca_bundle_path, _win_ca_bundle_attempted
    if _win_ca_bundle_attempted:
        return _win_ca_bundle_path
    _win_ca_bundle_attempted = True

    # Prefer the bundle already exported by start_backend.ps1 — it uses
    # PowerShell's cert export which is more reliable than ssl.enum_certificates.
    ps_bundle = os.path.join(os.path.dirname(__file__), "..", ".system", "windows_ca_bundle.pem")
    ps_bundle = os.path.normpath(ps_bundle)
    if os.path.isfile(ps_bundle) and os.path.getsize(ps_bundle) > 0:
        _win_ca_bundle_path = ps_bundle
        return _win_ca_bundle_path

    try:
        pem_parts: list[str] = []

        for store in ("CA", "ROOT", "AuthRoot", "MY", "TrustedPublisher"):
            try:
                for cert_data, encoding, _trust in ssl.enum_certificates(store):
                    if encoding == "x509_asn":
                        try:
                            pem_parts.append(ssl.DER_cert_to_PEM_cert(cert_data))
                        except Exception:
                            pass
            except (AttributeError, OSError):
                # ssl.enum_certificates is Windows-only; skip gracefully on Linux/Mac.
                break

        if not pem_parts:
            return None

        # Prepend certifi's well-known bundle so public CAs are also trusted.
        if certifi is not None:
            try:
                with open(certifi.where(), "r", encoding="utf-8", errors="ignore") as fh:
                    pem_parts.insert(0, fh.read())
            except Exception:
                pass

        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".pem", prefix="evidex_ca_", delete=False
        )
        tmp.write("\n".join(pem_parts))
        tmp.flush()
        tmp.close()

        atexit.register(
            lambda p=tmp.name: os.unlink(p) if os.path.exists(p) else None
        )

        _win_ca_bundle_path = tmp.name
        return _win_ca_bundle_path
    except Exception:
        return None


def _to_bool(raw: str, default: bool = False) -> bool:
    value = (raw or "").strip().lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "on"}


def _bedrock_enabled() -> bool:
    raw = os.getenv("BEDROCK_ENABLED", "true").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _resolve_tls_verify() -> Any:
    """
    Resolve TLS verification mode/path for boto3 Bedrock client.

    Priority:
    1) BEDROCK_TLS_SKIP_VERIFY=true -> False
    2) AWS_CA_BUNDLE
    3) REQUESTS_CA_BUNDLE
    4) SSL_CERT_FILE
    5) certifi.where() if available
    6) True (system trust store)
    """
    if _to_bool(os.getenv("BEDROCK_TLS_SKIP_VERIFY", "false"), default=False):
        return False

    for env_name in ("AWS_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE"):
        candidate = (os.getenv(env_name) or "").strip()
        if candidate:
            return candidate

    # Try extracting the Windows system trust store first — it includes corporate
    # CA certs (e.g. Deloitte proxy) that certifi alone does not carry.
    # _build_windows_ca_bundle() also merges certifi's public CA bundle in.
    win_bundle = _build_windows_ca_bundle()
    if win_bundle:
        return win_bundle

    if certifi is not None:
        try:
            return certifi.where()
        except Exception:
            pass

    return True


def get_bedrock_tls_debug_info() -> Dict[str, Any]:
    """Return Bedrock TLS verification source details for startup diagnostics."""
    if _to_bool(os.getenv("BEDROCK_TLS_SKIP_VERIFY", "false"), default=False):
        return {
            "verify": False,
            "source": "BEDROCK_TLS_SKIP_VERIFY",
            "value": "false (verification disabled)",
        }

    for env_name in ("AWS_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE"):
        candidate = (os.getenv(env_name) or "").strip()
        if candidate:
            return {
                "verify": candidate,
                "source": env_name,
                "value": candidate,
            }

    win_bundle = _build_windows_ca_bundle()
    if win_bundle:
        return {
            "verify": win_bundle,
            "source": "windows_trust_store",
            "value": win_bundle,
        }

    if certifi is not None:
        try:
            certifi_path = certifi.where()
            return {
                "verify": certifi_path,
                "source": "certifi",
                "value": certifi_path,
            }
        except Exception:
            pass

    return {
        "verify": True,
        "source": "system_trust_store",
        "value": "system default",
    }


def _try_parse_json_summary(text: str) -> Dict[str, Any]:
    candidate = (text or "").strip()
    if not candidate:
        return {}

    # First try direct JSON.
    try:
        parsed = json.loads(candidate)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass

    # Then try fenced blocks or embedded JSON object fallback.
    fenced = re.search(r"```(?:json)?\s*(\{[\s\S]*\})\s*```", candidate, re.IGNORECASE)
    if fenced:
        try:
            parsed = json.loads(fenced.group(1))
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass

    start = candidate.find("{")
    end = candidate.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            parsed = json.loads(candidate[start : end + 1])
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass

    # Recovery path for non-compliant model output where JSON snippets and
    # prose are mixed (for example one JSON object per line + recommendations).
    key_findings: List[str] = []
    recommendations: List[str] = []
    executive_lines: List[str] = []
    sufficiency_assessment: str | None = None

    in_recommendations = False
    for raw_line in candidate.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        if line.lower().startswith("recommendations"):
            in_recommendations = True
            continue

        # Try parsing single-line JSON objects.
        if line.startswith("{") and line.endswith("}"):
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    finding = str(obj.get("finding") or obj.get("title") or "").strip()
                    details = str(
                        obj.get("details")
                        or obj.get("description")
                        or obj.get("rationale")
                        or ""
                    ).strip()

                    if finding or details:
                        formatted = ": ".join([part for part in [finding, details] if part])
                        key_findings.append(formatted)
                        continue

                    # Generic object fallback.
                    key_findings.append(json.dumps(obj, ensure_ascii=True))
                    continue
            except Exception:
                pass

        if in_recommendations:
            recommendations.append(line)
            if sufficiency_assessment is None and (
                "evidence reviewed" in line.lower()
                or "sufficient" in line.lower()
                or "insufficient" in line.lower()
            ):
                sufficiency_assessment = line
        else:
            executive_lines.append(line)

    if key_findings or recommendations or executive_lines:
        return {
            "executive_summary": " ".join(executive_lines)[:1200] if executive_lines else "",
            "key_findings": key_findings,
            "sufficiency_assessment": sufficiency_assessment or "",
            "risks": key_findings,
            "recommended_next_steps": recommendations,
        }

    return {}


def _build_evidence_block(evidence_items: List[Dict[str, Any]]) -> str:
    blocks: List[str] = []

    for index, item in enumerate(evidence_items[:MAX_DOCS], start=1):
        filename = item.get("filename", f"Document {index}")
        file_type = item.get("file_type", "unknown")
        extracted_text = (item.get("extracted_text") or "").strip()
        preview = (item.get("content_preview") or "").strip()
        content = extracted_text or preview
        if not content:
            content = "No text was extracted from this document."

        blocks.append(
            f"Document {index}: {filename} ({file_type})\n"
            f"{content[:MAX_DOC_CHARS]}"
        )

    return "\n\n".join(blocks)


def _profile_name() -> str | None:
    explicit = (os.getenv("BEDROCK_AWS_PROFILE") or "").strip()
    if explicit:
        return explicit
    default_profile = (os.getenv("AWS_PROFILE") or "").strip()
    return default_profile or None


def _is_placeholder_credential(value: str | None) -> bool:
    raw = (value or "").strip()
    if not raw:
        return True
    lowered = raw.lower()
    return any(marker in lowered for marker in _PLACEHOLDER_CREDENTIAL_MARKERS)


def _parse_test_bedrock_credentials() -> Dict[str, str]:
    """
    Read optional fallback credentials from ../test_bedrock.py.

    This is intended for local development only when credentials have been placed
    there explicitly and env/profile credentials are unavailable.
    """
    result: Dict[str, str] = {}
    try:
        root_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
        test_file = os.path.join(root_dir, "test_bedrock.py")
        if not os.path.isfile(test_file):
            return result

        with open(test_file, "r", encoding="utf-8", errors="ignore") as fh:
            content = fh.read()

        patterns = {
            "aws_access_key_id": r'AWS_ACCESS_KEY_ID\s*=\s*["\']([^"\']+)["\']',
            "aws_secret_access_key": r'AWS_SECRET_ACCESS_KEY\s*=\s*["\']([^"\']+)["\']',
            "aws_session_token": r'AWS_SESSION_TOKEN\s*=\s*["\']([^"\']+)["\']',
            "region_name": r'AWS_REGION\s*=\s*["\']([^"\']+)["\']',
        }
        for key, pattern in patterns.items():
            match = re.search(pattern, content)
            if match and match.group(1).strip():
                result[key] = match.group(1).strip()
    except Exception:
        return {}
    return result


def _resolve_explicit_credentials(region: str) -> Dict[str, str]:
    """Resolve explicit boto3 credential kwargs from env, then test_bedrock.py."""
    kwargs: Dict[str, str] = {}

    preferred_access_key = (os.getenv("BEDROCK_AWS_ACCESS_KEY_ID") or "").strip()
    preferred_secret_key = (os.getenv("BEDROCK_AWS_SECRET_ACCESS_KEY") or "").strip()
    fallback_access_key = (os.getenv("AWS_ACCESS_KEY_ID") or "").strip()
    fallback_secret_key = (os.getenv("AWS_SECRET_ACCESS_KEY") or "").strip()

    access_key = preferred_access_key
    secret_key = preferred_secret_key
    if not access_key and not _is_placeholder_credential(fallback_access_key):
        access_key = fallback_access_key
    if not secret_key and not _is_placeholder_credential(fallback_secret_key):
        secret_key = fallback_secret_key

    session_token = (os.getenv("BEDROCK_AWS_SESSION_TOKEN") or os.getenv("AWS_SESSION_TOKEN") or "").strip()
    region_override = (os.getenv("BEDROCK_AWS_REGION") or os.getenv("AWS_REGION") or "").strip()

    if access_key and secret_key:
        kwargs["aws_access_key_id"] = access_key
        kwargs["aws_secret_access_key"] = secret_key
        # Only include session token if it's not a placeholder
        if session_token and not _is_placeholder_credential(session_token):
            kwargs["aws_session_token"] = session_token
        if region_override:
            kwargs["region_name"] = region_override
        return kwargs

    parsed = _parse_test_bedrock_credentials()
    if parsed.get("aws_access_key_id") and parsed.get("aws_secret_access_key"):
        kwargs["aws_access_key_id"] = parsed["aws_access_key_id"]
        kwargs["aws_secret_access_key"] = parsed["aws_secret_access_key"]
        # Only include session token if it's not a placeholder
        parsed_token = parsed.get("aws_session_token")
        if parsed_token and not _is_placeholder_credential(parsed_token):
            kwargs["aws_session_token"] = parsed_token
        kwargs["region_name"] = parsed.get("region_name") or region_override or region

    return kwargs


def _invoke_bedrock_converse(client: Any, model_id: str, prompt: str) -> Dict[str, Any]:
    return client.converse(
        modelId=model_id,
        messages=[
            {
                "role": "user",
                "content": [{"text": prompt}],
            }
        ],
        system=[
            {
                "text": (
                    "Respond with valid JSON only. Keep content practical for audit teams, "
                    "grounded in provided evidence text."
                )
            }
        ],
    )


def _retry_converse_without_env_credentials(
    region: str,
    tls_verify: Any,
    model_id: str,
    prompt: str,
    explicit_credentials: Dict[str, str] | None = None,
) -> Dict[str, Any]:
    """
    Retry Bedrock with env credentials temporarily removed.

    This avoids stale AWS_* env credentials overriding valid shared profile
    credentials, which commonly triggers UnrecognizedClientException.
    """
    saved_values = {key: os.environ.get(key) for key in _AWS_ENV_CREDENTIAL_KEYS}
    try:
        for key in _AWS_ENV_CREDENTIAL_KEYS:
            os.environ.pop(key, None)

        profile = _profile_name()
        if profile:
            session = boto3.Session(profile_name=profile)
        else:
            session = boto3.Session()

        client_kwargs: Dict[str, Any] = {
            "region_name": region,
            "verify": tls_verify,
        }
        if explicit_credentials:
            client_kwargs.update(explicit_credentials)

        client = session.client("bedrock-runtime", **client_kwargs)
        return _invoke_bedrock_converse(client, model_id, prompt)
    finally:
        for key, value in saved_values.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def summarize_with_bedrock(
    request_id: str,
    request_text: str,
    evidence_items: List[Dict[str, Any]],
    validation_summary: Dict[str, Any],
    conclusion_summary: Dict[str, Any],
) -> Dict[str, Any]:
    """Generate an auditor-facing summary for uploaded evidence via Amazon Bedrock."""

    global boto3

    if not _bedrock_enabled():
        return {
            "enabled": False,
            "provider": "amazon_bedrock",
            "status": "disabled",
            "message": "Bedrock summary is disabled (BEDROCK_ENABLED=false).",
        }

    if boto3 is None:
        # Recover when boto3 is installed after the process starts.
        try:
            boto3 = importlib.import_module("boto3")
        except Exception:
            boto3 = None

    if boto3 is None:
        return {
            "enabled": False,
            "provider": "amazon_bedrock",
            "status": "unavailable",
            "message": "boto3 is not installed; Bedrock summary is unavailable.",
        }

    region = os.getenv("AWS_REGION", "us-east-1")
    model_id = os.getenv("BEDROCK_MODEL_ID", DEFAULT_MODEL_ID)
    tls_verify = _resolve_tls_verify()
    explicit_credentials = _resolve_explicit_credentials(region)

    evidence_block = _build_evidence_block(evidence_items)

    no_evidence_instruction = ""
    if not evidence_items:
        no_evidence_instruction = (
            "\nCRITICAL: No evidence files were found or provided. "
            "Your executive_summary MUST be exactly: \"There is no evidence file to validate. Kindly upload evidence file(s).\"\n"
               "Set calculated_validation_score to 0.0 and validation_status to 'insufficient'.\n"
        )


    prompt = (
            "You are a senior audit evidence analyst trained in ISA standards. "
            "Review the uploaded evidence and produce a structured summary for an auditor.\n\n"
            "NON-HALLUCINATION RULES:\n"
            "- Use only the request text, reference fields, and evidence documents provided below.\n"
            "- Do not invent filenames, controls, entities, dates, findings, or metrics not present in input.\n"
            "- If evidence is weak or incomplete, state limitations explicitly and keep validation status conservative.\n"
            "- Do not infer facts from absent evidence.\n\n"
        f"Request ID: {request_id}\n"
        f"Audit request: {request_text}\n"
            f"Reference validation score: {validation_summary.get('overall_sufficiency_score', 'N/A')}\n"
            f"Reference conclusion: {conclusion_summary.get('overall_assessment', 'N/A')}\n\n"
            "CRITICAL SCORING RULES:\n"
            "1. Calculate a validation_score (0.0-1.0) based on the QUALITY, COMPLETENESS, and RELEVANCE of evidence provided.\n"
            "2. Apply this threshold: If calculated_validation_score >= 0.85, the status is 'Sufficient'. If < 0.85, the status is 'Insufficient'.\n"
            "3. Your sufficiency_assessment MUST align with the calculated status:\n"
            "   - If status='Sufficient': Use positive language. Acknowledge evidence adequacy. Avoid 'insufficient', 'incomplete', 'lacks'.\n"
            "   - If status='Insufficient': Use negative language. Acknowledge gaps. Avoid 'adequate', 'demonstrates', 'comprehensive'.\n"
            "4. Your executive_summary and key_findings MUST also align with this calculated status.\n"
            "5. If no evidence files exist, set calculated_validation_score=0.0 and validation_status='insufficient'.\n\n"
        "Evidence documents:\n"
        f"{evidence_block}\n"
        f"{no_evidence_instruction}\n"
        "Return only valid JSON (no prose, no markdown fences, no headings) using this exact schema:\n"
        "{\n"
            "  \"calculated_validation_score\": decimal 0.0-1.0,\n"
            "  \"validation_status\": \"sufficient\" | \"insufficient\",\n"
        "  \"executive_summary\": string,\n"
        "  \"key_findings\": [string],\n"
        "  \"sufficiency_assessment\": string,\n"
        "  \"risks\": [string],\n"
        "  \"recommended_next_steps\": [string]\n"
        "}"
    )

    try:
        client_kwargs: Dict[str, Any] = {
            "region_name": region,
            "verify": tls_verify,
        }
        if explicit_credentials:
            client_kwargs.update(explicit_credentials)

        # Only use get_bedrock_client if explicit credentials are not already provided
        if get_bedrock_client is not None and not explicit_credentials:
            custom_client = get_bedrock_client()
            try:
                creds = custom_client._request_signer._credentials
                os.environ["AWS_ACCESS_KEY_ID"] = creds.access_key
                os.environ["AWS_SECRET_ACCESS_KEY"] = creds.secret_key
                if creds.token:
                    os.environ["AWS_SESSION_TOKEN"] = creds.token
            except Exception:
                pass
        client = boto3.client("bedrock-runtime", **client_kwargs)

        response = _invoke_bedrock_converse(client, model_id, prompt)

        content = response["output"]["message"]["content"][0].get("text", "")

        parsed_summary = _try_parse_json_summary(content)

        return {
            "enabled": True,
            "provider": "amazon_bedrock",
            "status": "ok",
            "model_id": model_id,
            "summary": content,
            "parsed_summary": parsed_summary,
        }
    except Exception as exc:
        error_text = str(exc)
        lower_error_text = error_text.lower()

        # If env credentials are stale/expired, retry once with shared profile/default chain.
        if (
            "unrecognizedclientexception" in lower_error_text
            or "security token included in the request is invalid" in lower_error_text
        ):
            try:
                retried = _retry_converse_without_env_credentials(
                    region=region,
                    tls_verify=tls_verify,
                    model_id=model_id,
                    prompt=prompt,
                    explicit_credentials=explicit_credentials,
                )
                retried_content = retried["output"]["message"]["content"][0].get("text", "")
                return {
                    "enabled": True,
                    "provider": "amazon_bedrock",
                    "status": "ok",
                    "model_id": model_id,
                    "summary": retried_content,
                    "parsed_summary": _try_parse_json_summary(retried_content),
                    "credential_strategy": "profile_fallback",
                }
            except Exception as retry_exc:
                profile = _profile_name() or "default"
                return {
                    "enabled": False,
                    "provider": "amazon_bedrock",
                    "status": "error",
                    "message": (
                        "Bedrock summary failed: invalid AWS token credentials and retry failed. "
                        f"Tried shared credentials/profile '{profile}'. "
                        "You can set BEDROCK_AWS_ACCESS_KEY_ID/BEDROCK_AWS_SECRET_ACCESS_KEY "
                        "or place local dev credentials in test_bedrock.py. "
                        f"Original error: {exc}. Retry error: {retry_exc}."
                    ),
                }

        hint = ""
        if "CERTIFICATE_VERIFY_FAILED" in error_text or "SSL validation failed" in error_text:
            hint = (
                " Configure a trusted CA bundle via AWS_CA_BUNDLE/REQUESTS_CA_BUNDLE/SSL_CERT_FILE"
                " or set BEDROCK_TLS_SKIP_VERIFY=true for non-production troubleshooting."
            )
        return {
            "enabled": False,
            "provider": "amazon_bedrock",
            "status": "error",
            "message": f"Bedrock summary failed: {exc}.{hint}".strip(),
        }
