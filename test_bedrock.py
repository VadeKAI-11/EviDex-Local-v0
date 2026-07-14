import os
import sys

try:
    import boto3
except ImportError:
    print("boto3 is not installed. Please install it to test Bedrock integration.")
    sys.exit(1)

# AWS Bedrock credentials - replace with your actual credentials
AWS_ACCESS_KEY_ID = #"AKIAUJ4SBCSGVK37XLBX"
AWS_SECRET_ACCESS_KEY = #"QX6orppTMPPgAMxFv0BTAq0JIxerqXObGD8pcqSp"
AWS_REGION = "us-east-1"

def get_bedrock_client():
    # Use credentials defined above or fall back to environment variables
    aws_access_key_id = os.getenv("AWS_ACCESS_KEY_ID", AWS_ACCESS_KEY_ID)
    aws_secret_access_key = os.getenv("AWS_SECRET_ACCESS_KEY", AWS_SECRET_ACCESS_KEY)
    aws_session_token = os.getenv("AWS_SESSION_TOKEN")  # Optional for temporary credentials
    region = os.getenv("AWS_REGION", AWS_REGION)

    client = boto3.client(
        "bedrock-runtime",
        region_name=region,
        aws_access_key_id=aws_access_key_id,
        aws_secret_access_key=aws_secret_access_key,
        aws_session_token=aws_session_token if aws_session_token else None,
    )
    return client


def test_bedrock():
    try:
        client = get_bedrock_client()
        print("Successfully created Bedrock client.")
        # Optionally, make a simple call to verify connection
        # response = client.list_foundation_models()
        # print("Models:", response)
    except Exception as e:
        print(f"Error creating Bedrock client: {e}")


if __name__ == "__main__":
    test_bedrock()
