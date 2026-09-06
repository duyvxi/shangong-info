[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

function Read-SecretText {
    param([Parameter(Mandatory = $true)][string]$Prompt)

    $secureValue = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try {
        $plainValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ([string]::IsNullOrWhiteSpace($plainValue)) {
            throw 'The secret cannot be empty.'
        }
        return $plainValue
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

try {
    Set-Location -LiteralPath $projectRoot

    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        throw 'Node.js was not found. Install or repair Node.js first.'
    }

    Write-Host ''
    Write-Host 'Campus AI knowledge vector setup' -ForegroundColor Cyan
    Write-Host 'The keys you enter are hidden and are not written to a file.'
    Write-Host ''

    $env:SUPABASE_URL = 'https://hadujcmbmgkypdqgulyh.supabase.co'
    $env:SUPABASE_SECRET_KEY = Read-SecretText 'Paste the Supabase Secret key'
    $env:AI_EMBEDDING_MODEL = 'text-embedding-v4'
    $env:AI_EMBEDDING_DIMENSIONS = '1024'

    Write-Host ''
    Write-Host '[1/2] Checking document chunking without generating vectors...' -ForegroundColor Yellow
    & node.exe '.\scripts\reindex_knowledge.mjs' '--dry-run'
    if ($LASTEXITCODE -ne 0) {
        throw 'The document check failed. Read the error above.'
    }

    Write-Host ''
    $confirmation = Read-Host 'The check passed. Enter Y to generate and upload vectors'
    if ($confirmation -cnotin @('Y', 'y')) {
        Write-Host 'Cancelled. No vectors were generated.' -ForegroundColor Yellow
        exit 0
    }

    $env:AI_EMBEDDING_API_KEY = Read-SecretText 'Paste the Bailian API key used by the AI assistant'
    $env:AI_EMBEDDING_API_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

    Write-Host ''
    Write-Host '[2/2] Generating and uploading vectors...' -ForegroundColor Yellow
    & node.exe '.\scripts\reindex_knowledge.mjs'
    if ($LASTEXITCODE -ne 0) {
        throw 'Vector generation failed. Read the error above.'
    }

    Write-Host ''
    Write-Host 'SUCCESS: Knowledge vectors are ready.' -ForegroundColor Green
}
catch {
    Write-Host ''
    Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    Remove-Item Env:SUPABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:SUPABASE_SECRET_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:AI_EMBEDDING_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:AI_EMBEDDING_API_BASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:AI_EMBEDDING_MODEL -ErrorAction SilentlyContinue
    Remove-Item Env:AI_EMBEDDING_DIMENSIONS -ErrorAction SilentlyContinue
}
