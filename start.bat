@echo off
REM ROM editor - local startup (cmd / double-click wrapper).
REM See start.ps1 for the PowerShell equivalent; both call scripts\start.mjs.

where node >nul 2>&1
if errorlevel 1 (
    echo node is not on PATH. Install Node.js 22 LTS from https://nodejs.org and re-run.
    exit /b 1
)

node "%~dp0scripts\start.mjs"
