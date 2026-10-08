@echo off
setlocal
title Weiwu - local web app
pushd "%~dp0"
if errorlevel 1 exit /b 1

where node.exe >nul 2>nul
if errorlevel 1 goto :nodeMissing
where npm.cmd >nul 2>nul
if errorlevel 1 goto :npmMissing

node.exe -e "const [major, minor] = process.versions.node.split('.').map(Number); if (!((major === 22 && minor >= 19) || major >= 24)) { console.error('Unsupported Node.js ' + process.versions.node + '; install Node.js 22.19+ in the 22.x line, or 24+.'); process.exit(1); }"
set "localLaunchExit=%errorlevel%"
if not "%localLaunchExit%"=="0" goto :nodeInvalid

for %%D in ("node_modules\@electric-sql\pglite\package.json" "node_modules\@electric-sql\pglite-pgvector\package.json" "node_modules\@electric-sql\pglite-socket\package.json" "node_modules\tsx\package.json" "node_modules\typescript\bin\tsc" "node_modules\vite\bin\vite.js" "node_modules\express\package.json") do if not exist "%%~D" goto :projectDependenciesMissing
for %%D in ("services\agent-runtime\node_modules\@deepseek-ai\dsh\package.json" "services\agent-runtime\node_modules\@nanmicoder\dsh-agent-teams\package.json") do if not exist "%%~D" goto :runtimeDependenciesMissing

echo Building the web app. No model requests are sent by this build.
call npm run build
set "localLaunchExit=%errorlevel%"
if not "%localLaunchExit%"=="0" goto :buildFailed

echo Starting Weiwu at http://127.0.0.1:4310/ unless --web-port is provided.
echo Keep this window open. Use Ctrl+C to stop the service.
node scripts/local.mjs --production %*
set "localLaunchExit=%errorlevel%"
if not "%localLaunchExit%"=="0" echo The service exited with code %localLaunchExit%. See the error above.
goto :finish

:nodeMissing
echo Node.js is missing from PATH. Install Node.js with npm, then reopen this window.
echo Required: Node.js 22.19 or later in the 22.x line, or 24 and later.
set "localLaunchExit=1"
goto :finish

:npmMissing
echo npm is missing from PATH. Repair the Node.js installation with npm enabled.
echo Then reopen this window and run the installation commands in docs/mvp-quickstart.md.
set "localLaunchExit=1"
goto :finish

:nodeInvalid
echo Node.js could not run, or its version is unsupported. See the error above.
goto :finish

:projectDependenciesMissing
echo Project dependencies are missing. Open PowerShell in this folder and run:
echo   npm ci
echo Also install the separate employee runtime before starting:
echo   npm --prefix services/agent-runtime ci
set "localLaunchExit=1"
goto :finish

:runtimeDependenciesMissing
echo Employee runtime dependencies are missing. Open PowerShell in this folder and run:
echo   npm --prefix services/agent-runtime ci
set "localLaunchExit=1"
goto :finish

:buildFailed
echo Build failed with code %localLaunchExit%. The service was not started.
echo Fix the build error shown above, then run this launcher again.
goto :finish

:finish
popd
pause
exit /b %localLaunchExit%
