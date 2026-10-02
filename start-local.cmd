@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.19 or 24+ first.
  pause
  exit /b 1
)
if not exist "node_modules\@electric-sql\pglite" (
  echo Run npm ci and npm --prefix services/agent-runtime ci first.
  pause
  exit /b 1
)
node scripts/local.mjs
pause
