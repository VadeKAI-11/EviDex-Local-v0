from typing import List, Optional, Tuple

try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
except ImportError:
    boto3 = None

    class BotoCoreError(Exception):
        pass

    class ClientError(Exception):
        pass

from agents.reasoning_logger import log_step


def copy_inventory_to_s3(
    request_id: str,
    evidence_inventory: List[dict],
    bucket_name: str,
    region_name: Optional[str] = None,
) -> Tuple[list, list]:
    """
    Copies locally stored evidence files to S3 under request-specific keys.

    Object key pattern:
    <request_id>/<filename>

    Returns:
    - updated_inventory: original file metadata plus S3 metadata
    - logs: reasoning logs for each copied file
    """

    if boto3 is None:
        raise RuntimeError(
            "boto3 is not installed, so S3 evidence copy is unavailable in this environment."
        )

    client = boto3.client("s3", region_name=region_name) if region_name else boto3.client("s3")

    updated_inventory = []
    logs = []

    for item in evidence_inventory:
        object_key = f"{request_id}/{item['filename']}"
        local_path = item["storage_path"]

        try:
            client.upload_file(local_path, bucket_name, object_key)
        except (BotoCoreError, ClientError, FileNotFoundError) as exc:
            raise RuntimeError(
                f"Failed to copy '{item['filename']}' to S3 bucket '{bucket_name}': {exc}"
            ) from exc

        copied_item = dict(item)
        copied_item["s3_bucket"] = bucket_name
        copied_item["s3_key"] = object_key
        copied_item["s3_uri"] = f"s3://{bucket_name}/{object_key}"
        updated_inventory.append(copied_item)

        logs.append(
            log_step(
                agent="storage_agent",
                request_id=request_id,
                message=(
                    f"Copied evidence file '{item['filename']}' to "
                    f"s3://{bucket_name}/{object_key}"
                ),
            )
        )

    return updated_inventory, logs
