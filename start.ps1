# ROM editor - local startup
#
# Usage (from the project root):
#   .\start.ps1
#
# Optional: override the backend port with $env:PORT before running, e.g.
#   $env:PORT = "9000"; .\start.ps1
#
# This is a thin wrapper around scripts\start.mjs. The Node script does the
# real work (npm install if needed, build shared, start backend, wait for
# health, start frontend, open the browser, clean up on Ctrl+C).

$ErrorActionPreference = "Stop"

$nodeCheck = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCheck) {
    Write-Host "node is not on PATH. Install Node.js 22 LTS from https://nodejs.org and re-run." -ForegroundColor Red
    exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $scriptDir "scripts\start.mjs")
