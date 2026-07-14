# start_backend.ps1 - Export Windows trust store to PEM, load Bedrock credentials, then launch uvicorn.

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$BundlePath = Join-Path $ScriptDir ".system\windows_ca_bundle.pem"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$PreferredPython = Join-Path $RepoRoot ".venv-1\Scripts\python.exe"

if (Test-Path $PreferredPython) {
	$PythonExe = $PreferredPython
} else {
	throw "No Python executable found. Expected $PreferredPython"
}

Write-Host "[start_backend] Using Python: $PythonExe"

function Resolve-SofficePath() {
	if (-not [string]::IsNullOrWhiteSpace($env:SOFFICE_PATH) -and (Test-Path $env:SOFFICE_PATH)) {
		return $env:SOFFICE_PATH
	}

	$cmd = Get-Command soffice -ErrorAction SilentlyContinue
	if ($cmd -and -not [string]::IsNullOrWhiteSpace($cmd.Source)) {
		return $cmd.Source
	}

	foreach ($candidate in @(
		"C:\Program Files\LibreOffice\program\soffice.exe",
		"C:\Program Files (x86)\LibreOffice\program\soffice.exe"
	)) {
		if (Test-Path $candidate) {
			return $candidate
		}
	}

	return $null
}

function Test-IsPlaceholder([string]$value) {
	if ([string]::IsNullOrWhiteSpace($value)) { return $true }
	$lower = $value.Trim().ToLowerInvariant()
	return (
		$lower.Contains("your_key") -or
		$lower.Contains("your_secret") -or
		$lower.Contains("placeholder") -or
		$lower.Contains("replace_me") -or
		$lower.Contains("changeme") -or
		$lower.Contains("dummy") -or
		$lower.Contains("example")
	)
}

# Ensure .system directory exists
$null = New-Item -ItemType Directory -Force -Path (Split-Path $BundlePath)

Write-Host "[start_backend] Exporting Windows trust store to: $BundlePath"

# Export all certs from ROOT, CA, AuthRoot, and TrustedPublisher stores as PEM
$pemContent = ""
foreach ($store in @("Root", "CA", "AuthRoot", "TrustedPublisher")) {
	try {
		$certs = Get-ChildItem -Path "Cert:\LocalMachine\$store" -ErrorAction SilentlyContinue
		foreach ($cert in $certs) {
			try {
				$der = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
				$b64 = [System.Convert]::ToBase64String($der, [System.Base64FormattingOptions]::InsertLineBreaks)
				$pemContent += "-----BEGIN CERTIFICATE-----`n$b64`n-----END CERTIFICATE-----`n"
			} catch {}
		}
	} catch {}
}

if ($pemContent.Length -gt 0) {
	# Prepend certifi bundle if available
	try {
		$certifiPath = & $PythonExe -c "import certifi; print(certifi.where())" 2>$null
		if ($certifiPath -and (Test-Path $certifiPath)) {
			$certifiContent = Get-Content $certifiPath -Raw
			$pemContent = $certifiContent + "`n" + $pemContent
		}
	} catch {}

	[System.IO.File]::WriteAllText($BundlePath, $pemContent, [System.Text.Encoding]::UTF8)
	$certCount = ([regex]::Matches($pemContent, "-----BEGIN CERTIFICATE-----")).Count
	Write-Host "[start_backend] Bundle written: $certCount certs"
	$env:AWS_CA_BUNDLE = $BundlePath
	$env:REQUESTS_CA_BUNDLE = $BundlePath
	Write-Host "[start_backend] AWS_CA_BUNDLE=$env:AWS_CA_BUNDLE"
} else {
	Write-Host "[start_backend] WARNING: No certs exported - skipping AWS_CA_BUNDLE"
}

$resolvedSoffice = Resolve-SofficePath
if (-not [string]::IsNullOrWhiteSpace($resolvedSoffice)) {
	$env:SOFFICE_PATH = $resolvedSoffice
	Write-Host "[start_backend] SOFFICE_PATH=$env:SOFFICE_PATH"
} else {
	Write-Host "[start_backend] WARNING: LibreOffice (soffice) not found. Office preview conversion will return HTTP 503 until installed/configured."
}

# Extract Bedrock credentials from test_bedrock.py if present
$TestBedrockPath = Join-Path $RepoRoot "EviDex Code\test_bedrock.py"
if (Test-Path $TestBedrockPath) {
	try {
		$content = Get-Content $TestBedrockPath -Raw
		$doubleQuotedPattern = '"([^\"]+)"'
		$singleQuotedPattern = "'([^']+)'"

		if ($content -match "AWS_ACCESS_KEY_ID\s*=\s*$doubleQuotedPattern" -or $content -match "AWS_ACCESS_KEY_ID\s*=\s*$singleQuotedPattern") {
			$env:BEDROCK_AWS_ACCESS_KEY_ID = $matches[1]
			Write-Host "[start_backend] Loaded AWS_ACCESS_KEY_ID from test_bedrock.py"
		}

		if ($content -match "AWS_SECRET_ACCESS_KEY\s*=\s*$doubleQuotedPattern" -or $content -match "AWS_SECRET_ACCESS_KEY\s*=\s*$singleQuotedPattern") {
			$env:BEDROCK_AWS_SECRET_ACCESS_KEY = $matches[1]
			Write-Host "[start_backend] Loaded AWS_SECRET_ACCESS_KEY from test_bedrock.py"
		}

		if ($content -match "AWS_REGION\s*=\s*$doubleQuotedPattern" -or $content -match "AWS_REGION\s*=\s*$singleQuotedPattern") {
			$env:BEDROCK_AWS_REGION = $matches[1]
			Write-Host "[start_backend] Loaded AWS_REGION=$($matches[1]) from test_bedrock.py"
		}

		# Configure standard AWS_* vars when currently empty/placeholder.
		if (-not (Test-IsPlaceholder $env:BEDROCK_AWS_ACCESS_KEY_ID) -and -not (Test-IsPlaceholder $env:BEDROCK_AWS_SECRET_ACCESS_KEY)) {
			if (Test-IsPlaceholder $env:AWS_ACCESS_KEY_ID) {
				$env:AWS_ACCESS_KEY_ID = $env:BEDROCK_AWS_ACCESS_KEY_ID
				Write-Host "[start_backend] Set AWS_ACCESS_KEY_ID from BEDROCK_AWS_ACCESS_KEY_ID"
			}
			if (Test-IsPlaceholder $env:AWS_SECRET_ACCESS_KEY) {
				$env:AWS_SECRET_ACCESS_KEY = $env:BEDROCK_AWS_SECRET_ACCESS_KEY
				Write-Host "[start_backend] Set AWS_SECRET_ACCESS_KEY from BEDROCK_AWS_SECRET_ACCESS_KEY"
			}
			if ([string]::IsNullOrWhiteSpace($env:AWS_REGION) -and -not [string]::IsNullOrWhiteSpace($env:BEDROCK_AWS_REGION)) {
				$env:AWS_REGION = $env:BEDROCK_AWS_REGION
				Write-Host "[start_backend] Set AWS_REGION from BEDROCK_AWS_REGION"
			}
		}
	} catch {
		Write-Host "[start_backend] WARNING: Failed to extract credentials from test_bedrock.py"
	}
} else {
	Write-Host "[start_backend] INFO: test_bedrock.py not found; credentials must be set via environment or AWS profiles"
}

Write-Host "[start_backend] Starting uvicorn on port 8000..."
& $PythonExe -m uvicorn app:app --reload --port 8000

