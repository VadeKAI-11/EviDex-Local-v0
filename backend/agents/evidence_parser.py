import csv
import json
import os
import re
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from xml.etree import ElementTree as ET

try:
    import boto3
except ImportError:
    boto3 = None


SUPPORTED_FORMATS = {
    "documents": ["pdf", "docx", "txt", "msg"],
    "data": ["csv", "xlsx", "json", "xml"],
    "images": ["png", "jpg", "jpeg"],
    "archives": ["zip"],
}

FORMAT_PROCESSING_MAP = {
    "pdf": {
        "category": "documents",
        "pipeline": ["textract_ocr", "pdf_text_fallback", "validation"],
        "description": "Run Amazon Textract first, then fall back to basic PDF text extraction.",
    },
    "docx": {
        "category": "documents",
        "pipeline": ["ooxml_text_extraction", "validation"],
        "description": "Extract paragraphs from the Word OOXML document.xml payload.",
    },
    "txt": {
        "category": "documents",
        "pipeline": ["text_decode", "validation"],
        "description": "Read as UTF-8 text with permissive fallback handling.",
    },
    "msg": {
        "category": "documents",
        "pipeline": ["email_text_extraction", "validation"],
        "description": "Extract readable Outlook email content using available metadata and text fallbacks.",
    },
    "csv": {
        "category": "data",
        "pipeline": ["tabular_parse", "validation"],
        "description": "Parse rows/headers and convert them to normalized text.",
    },
    "xlsx": {
        "category": "data",
        "pipeline": ["ooxml_sheet_parse", "validation"],
        "description": "Read workbook XML parts and flatten sheets into evidence text.",
    },
    "json": {
        "category": "data",
        "pipeline": ["json_parse", "validation"],
        "description": "Parse JSON and normalize nested structures for preview and scoring.",
    },
    "xml": {
        "category": "data",
        "pipeline": ["xml_parse", "validation"],
        "description": "Parse XML tree and flatten tags/values into searchable text.",
    },
    "png": {
        "category": "images",
        "pipeline": ["textract_ocr", "validation"],
        "description": "Run Amazon Textract OCR on the image payload.",
    },
    "jpg": {
        "category": "images",
        "pipeline": ["textract_ocr", "validation"],
        "description": "Run Amazon Textract OCR on the image payload.",
    },
    "jpeg": {
        "category": "images",
        "pipeline": ["textract_ocr", "validation"],
        "description": "Run Amazon Textract OCR on the image payload.",
    },
    "zip": {
        "category": "archives",
        "pipeline": ["archive_expansion", "recursive_parse", "validation"],
        "description": "Expand bulk uploads, filter supported members, and parse each extracted file.",
    },
}

SUPPORTED_EXTENSIONS = {
    extension
    for extensions in SUPPORTED_FORMATS.values()
    for extension in extensions
}


def get_extension(filename: str) -> str:
    return Path(filename).suffix.lower().lstrip(".")


def is_supported_file(filename: str) -> bool:
    return get_extension(filename) in SUPPORTED_EXTENSIONS


def describe_processing_strategy(file_type: str) -> Dict[str, Any]:
    return FORMAT_PROCESSING_MAP.get(
        file_type,
        {
            "category": "unknown",
            "pipeline": ["unsupported"],
            "description": "Unsupported format",
        },
    )


def parse_evidence_file(file_path: str, source: str = "direct_upload") -> Dict[str, Any]:
    file_type = get_extension(file_path)
    if file_type not in SUPPORTED_EXTENSIONS - {"zip"}:
        raise ValueError(f"Unsupported evidence format: .{file_type}")

    strategy = describe_processing_strategy(file_type)
    extracted_text = ""
    parser_metadata: Dict[str, Any] = {
        "format_category": strategy["category"],
        "processing_pipeline": strategy["pipeline"],
        "processing_description": strategy["description"],
        "ocr_provider": None,
        "ocr_used": False,
        "warnings": [],
    }

    if file_type in {"png", "jpg", "jpeg", "pdf"}:
        extracted_text, textract_meta = _extract_with_textract(file_path)
        parser_metadata.update(textract_meta)
        if not extracted_text and file_type == "pdf":
            extracted_text = _extract_pdf_fallback(file_path)
            if extracted_text:
                parser_metadata["warnings"].append(
                    "Amazon Textract unavailable; used PDF fallback parser."
                )
    elif file_type == "docx":
        extracted_text = _extract_docx_text(file_path)
    elif file_type == "txt":
        extracted_text = _extract_text_file(file_path)
    elif file_type == "msg":
        extracted_text = _extract_msg_text(file_path)
    elif file_type == "csv":
        extracted_text = _extract_csv_text(file_path)
    elif file_type == "xlsx":
        extracted_text = _extract_xlsx_text(file_path)
    elif file_type == "json":
        extracted_text = _extract_json_text(file_path)
    elif file_type == "xml":
        extracted_text = _extract_xml_text(file_path)

    if not extracted_text:
        parser_metadata["warnings"].append(
            "No textual content extracted; validation will rely on filename and metadata."
        )

    preview = extracted_text[:500].strip()
    keyword_hits = _extract_audit_keywords(extracted_text)

    return {
        "filename": os.path.basename(file_path),
        "storage_path": file_path,
        "file_type": file_type,
        "file_size_bytes": os.path.getsize(file_path),
        "source": source,
        "upload_timestamp": datetime.utcnow().isoformat(),
        "content_preview": preview,
        "extracted_text": extracted_text,
        "key_findings": keyword_hits,
        "parser_metadata": parser_metadata,
        "parsing_strategy": strategy["description"],
        "relevance_score": _estimate_relevance(file_type, extracted_text, keyword_hits),
    }


def extract_archive(
    archive_path: str,
    request_id: str,
    extract_root: str,
) -> Tuple[List[Dict[str, Any]], List[str]]:
    extracted_items: List[Dict[str, Any]] = []
    skipped_members: List[str] = []

    with zipfile.ZipFile(archive_path, "r") as archive:
        for member in archive.infolist():
            if member.is_dir():
                continue

            member_name = Path(member.filename).name
            if not member_name:
                continue

            extension = get_extension(member_name)
            if extension not in SUPPORTED_EXTENSIONS - {"zip"}:
                skipped_members.append(member.filename)
                continue

            destination_dir = os.path.join(extract_root, Path(archive_path).stem)
            os.makedirs(destination_dir, exist_ok=True)
            destination_path = os.path.join(destination_dir, member_name)

            with archive.open(member, "r") as source_file, open(destination_path, "wb") as target_file:
                target_file.write(source_file.read())

            parsed_member = parse_evidence_file(destination_path, source="archive_upload")
            parsed_member["request_id"] = request_id
            parsed_member["parent_archive"] = os.path.basename(archive_path)
            extracted_items.append(parsed_member)

    return extracted_items, skipped_members


def _extract_with_textract(file_path: str) -> Tuple[str, Dict[str, Any]]:
    metadata = {
        "ocr_provider": None,
        "ocr_used": False,
        "warnings": [],
    }

    if boto3 is None:
        metadata["warnings"].append("boto3 is not installed; Textract OCR skipped.")
        return "", metadata

    try:
        client = boto3.client("textract", region_name=os.getenv("AWS_REGION"))
        with open(file_path, "rb") as file_handle:
            response = client.detect_document_text(Document={"Bytes": file_handle.read()})
        lines = [
            block.get("Text", "")
            for block in response.get("Blocks", [])
            if block.get("BlockType") == "LINE"
        ]
        text = "\n".join(line for line in lines if line).strip()
        if text:
            metadata["ocr_provider"] = "amazon_textract"
            metadata["ocr_used"] = True
        return text, metadata
    except Exception as exc:
        metadata["warnings"].append(f"Amazon Textract unavailable: {exc}")
        return "", metadata


def _extract_text_file(file_path: str) -> str:
    with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
        return handle.read().strip()


def _extract_msg_text(file_path: str) -> str:
    try:
        import extract_msg  # type: ignore

        message = extract_msg.Message(file_path)
        parts = [
            f"Subject: {message.subject}" if getattr(message, "subject", None) else "",
            f"From: {message.sender}" if getattr(message, "sender", None) else "",
            f"To: {message.to}" if getattr(message, "to", None) else "",
            f"Date: {message.date}" if getattr(message, "date", None) else "",
            "",
            str(getattr(message, "body", "") or "").strip(),
        ]
        text = "\n".join(part for part in parts if part is not None).strip()
        if text:
            return text
    except Exception:
        pass

    with open(file_path, "rb") as handle:
        payload = handle.read()

    utf16_text = payload.decode("utf-16le", errors="ignore")
    utf8_text = payload.decode("utf-8", errors="ignore")
    segments = _extract_printable_segments(utf16_text) + _extract_printable_segments(utf8_text)

    seen: set[str] = set()
    ordered_segments: List[str] = []
    for segment in segments:
        normalized = re.sub(r"\s+", " ", segment).strip()
        if len(normalized) < 8:
            continue
        lower = normalized.lower()
        if lower in seen:
            continue
        seen.add(lower)
        ordered_segments.append(normalized)

    return "\n".join(ordered_segments[:80]).strip()


def _extract_printable_segments(text: str) -> List[str]:
    return re.findall(r"[A-Za-z0-9][^\x00-\x08\x0B\x0C\x0E-\x1F]{7,}", text)


def _extract_json_text(file_path: str) -> str:
    with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
        data = json.load(handle)
    return json.dumps(data, indent=2, ensure_ascii=True)


def _extract_xml_text(file_path: str) -> str:
    tree = ET.parse(file_path)
    root = tree.getroot()
    parts: List[str] = []
    for element in root.iter():
        text = (element.text or "").strip()
        if text:
            parts.append(f"{element.tag}: {text}")
    return "\n".join(parts)


def _extract_csv_text(file_path: str) -> str:
    rows: List[str] = []
    with open(file_path, "r", encoding="utf-8", errors="ignore", newline="") as handle:
        reader = csv.reader(handle)
        for index, row in enumerate(reader):
            rows.append(", ".join(cell.strip() for cell in row if cell is not None))
            if index >= 50:
                break
    return "\n".join(row for row in rows if row)


def _extract_docx_text(file_path: str) -> str:
    with zipfile.ZipFile(file_path, "r") as archive:
        xml_payload = archive.read("word/document.xml")
    root = ET.fromstring(xml_payload)
    texts = [node.text for node in root.iter() if node.text]
    return " ".join(texts).strip()


def _extract_xlsx_text(file_path: str) -> str:
    with zipfile.ZipFile(file_path, "r") as archive:
        shared_strings: List[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared_strings = [node.text or "" for node in shared_root.iter() if node.text]

        sheet_rows: List[str] = []
        worksheet_names = [name for name in archive.namelist() if name.startswith("xl/worksheets/") and name.endswith(".xml")]
        for worksheet_name in worksheet_names:
            root = ET.fromstring(archive.read(worksheet_name))
            values: List[str] = []
            for cell in root.iter():
                if cell.tag.endswith("}v") and cell.text:
                    values.append(cell.text)
            resolved = []
            for value in values:
                if value.isdigit() and shared_strings and int(value) < len(shared_strings):
                    resolved.append(shared_strings[int(value)])
                else:
                    resolved.append(value)
            if resolved:
                sheet_rows.append(f"{Path(worksheet_name).stem}: " + ", ".join(resolved[:100]))
        return "\n".join(sheet_rows)


def _extract_pdf_fallback(file_path: str) -> str:
    with open(file_path, "rb") as handle:
        payload = handle.read().decode("latin-1", errors="ignore")
    matches = re.findall(r"\(([^()]*)\)", payload)
    cleaned = [re.sub(r"\\[nrt]", " ", match) for match in matches]
    return " ".join(cleaned).strip()


def _extract_audit_keywords(text: str) -> List[str]:
    keywords = [
        "approval",
        "review",
        "control",
        "exception",
        "reconciliation",
        "evidence",
        "policy",
        "invoice",
        "testing",
        "sign-off",
    ]
    text_lower = text.lower()
    return [keyword for keyword in keywords if keyword in text_lower]


def _estimate_relevance(file_type: str, extracted_text: str, keyword_hits: List[str]) -> float:
    base_score = 0.45
    if file_type in {"pdf", "docx", "msg", "xlsx", "csv"}:
        base_score += 0.1
    if extracted_text:
        base_score += min(len(extracted_text.split()) / 500.0, 0.25)
    if keyword_hits:
        base_score += min(len(keyword_hits) * 0.05, 0.2)
    return min(base_score, 1.0)
