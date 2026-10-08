@echo off
setlocal enabledelayedexpansion
title Mistloop Launcher

REM ============================================================
REM  MISTLOOP - one click launcher
REM
REM  READ BEFORE EDITING THIS FILE
REM
REM  1) This file must stay PURE ASCII. No Chinese, no accented
REM     characters, no emoji. Reason: if a .bat contains multi-byte
REM     characters, cmd.exe miscounts byte offsets when seeking code
REM     positions, and starts executing from the middle of a line.
REM     Symptoms are bizarre errors like  'et'  'EADY'  '{'  'top)'.
REM     Do NOT "fix" this by adding chcp 65001 - that is what causes it.
REM     All Chinese documentation lives in README.md instead.
REM
REM  2) Never use goto to jump across lines. Same offset problem.
REM     Use call :SUB and for /l loops instead.
REM
REM  3) Do not write  start "title" cmd /k "cd /d "path" && npm run dev"
REM     Nested double quotes break cmd parsing. Use start's /D flag.
REM
REM  4) Quote paths that contain spaces as "path". Never nest quotes
REM     on the same line.
REM ============================================================

set "ROOT=%~dp0code"
if not exist "%ROOT%\package.json" set "ROOT=%~dp0"

if not exist "%ROOT%\package.json" (
	echo [X] Cannot find package.json
	echo     Put this script in E:\AiStudy\silentHill\ or E:\AiStudy\silentHill\code\
	echo     Current dir: %~dp0
	pause
	exit /b 1
)

echo ============================================
echo   MISTLOOP  -  Launcher
echo ============================================
echo   Project: %ROOT%
echo.

call :FIND_NPM
if "!NPM!"=="" (
	echo [X] npm not found.
	echo     Please install Node.js 18+ from https://nodejs.org/
	pause
	exit /b 1
)
echo [1/4] npm: !NPM!

if exist "%ROOT%\node_modules" (
	echo [2/4] Dependencies present, skipping install.
	call :LAUNCH
	exit /b 0
)

echo [2/4] First run: installing dependencies via npmmirror (~1 min)...
if not exist "%ROOT%\.npmrc" (
	>"%ROOT%\.npmrc" echo registry=https://registry.npmmirror.com
	>>"%ROOT%\.npmrc" echo fund=false
	>>"%ROOT%\.npmrc" echo audit=false
)
pushd "%ROOT%"
call "!NPM!" install --no-audit --no-fund
set "INSTALL_RC=%ERRORLEVEL%"
popd
if not "%INSTALL_RC%"=="0" (
	echo [X] Install failed with code %INSTALL_RC%
	pause
	exit /b 1
)

call :LAUNCH
exit /b 0


:FIND_NPM
set "NPM="
set "NODEDIR="
set "WBV=%USERPROFILE%\.workbuddy\binaries\node\versions"

REM Priority 1: the "current" pointer file. This is authoritative - it holds
REM the active version string, so it survives version upgrades. Do not guess
REM by sorting directory names: the versions folder also contains ".locks"
REM and "current", so a naive newest-first sort picks the wrong entry.
if exist "%WBV%\current" (
	set /p CV=<"%WBV%\current"
	if exist "%WBV%\!CV!\npm.cmd" (
		set "NPM=%WBV%\!CV!\npm.cmd"
		set "NODEDIR=%WBV%\!CV!"
	)
)

REM Priority 2: any version dir that actually contains npm.cmd
if "!NPM!"=="" (
	for /f "delims=" %%V in ('dir /b /ad "%WBV%" 2^>nul') do (
		if "!NPM!"=="" if exist "%WBV%\%%V\npm.cmd" (
			set "NPM=%WBV%\%%V\npm.cmd"
			set "NODEDIR=%WBV%\%%V"
		)
	)
)

REM Priority 3: a system-wide Node install
if "!NPM!"=="" (
	if exist "F:\software\nodejs\npm.cmd" (
		set "NPM=F:\software\nodejs\npm.cmd"
		set "NODEDIR=F:\software\nodejs"
	)
)
if "!NPM!"=="" (
	if exist "C:\Program Files\nodejs\npm.cmd" (
		set "NPM=C:\Program Files\nodejs\npm.cmd"
		set "NODEDIR=C:\Program Files\nodejs"
	)
)

REM Priority 4: whatever is on PATH
if "!NPM!"=="" (
	for /f "delims=" %%P in ('where npm.cmd 2^>nul') do (
		if "!NPM!"=="" set "NPM=%%P"
	)
)
exit /b 0


:LAUNCH
echo [3/4] Starting dev server window "Mistloop server" ...
start "Mistloop server" /D "%ROOT%" cmd /k ""!NPM!" run dev"

echo [4/4] Waiting for the server to become ready ...
set "URL=http://127.0.0.1:5199/"
set "OK=0"

for /l %%I in (1,1,20) do (
	if "!OK!"=="0" (
		powershell -NoProfile -Command "try { [void](Invoke-WebRequest -Uri '%URL%' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop); exit 0 } catch { exit 1 }" >nul 2>&1
		if !errorlevel! equ 0 (
			set "OK=1"
		) else (
			timeout /t 2 /nobreak >nul
		)
	)
)

if "!OK!"=="0" (
	echo.
	echo [!] Server did not come up within 40 seconds.
	echo     Check the "Mistloop server" window for errors.
	pause
	exit /b 1
)

call :OPEN_BROWSER
exit /b 0


:OPEN_BROWSER
echo.
echo ============================================
echo   Ready. Opening browser at:
echo   %URL%
echo ============================================
echo.
echo   Controls
echo     Click the entry button to start (audio needs this click)
echo     Click the scene again to lock the mouse
echo       W A S D   move
echo       hold W    auto-jog after a moment (drains stamina)
echo       Shift     sneak (slow, nearly silent)
echo       Ctrl      crouch (slowest, stalker barely hears you)
echo       Space     jump (landing can be heard)
echo       E         toggle flashlight
echo       F         first / third person camera
echo       F1        help
echo       Esc       release mouse / pause
echo   Headphones recommended.
echo.
echo   Close the "Mistloop server" window to stop the game.
echo.

set "CHROME="
for %%P in (
	"C:\Program Files\Google\Chrome\Application\chrome.exe"
	"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
	"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
	"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
	"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) do (
	if "!CHROME!"=="" if exist %%P set "CHROME=%%~P"
)

if not "!CHROME!"=="" (
	start "" "!CHROME!" "%URL%"
) else (
	echo [!] Chrome/Edge not found. Open this URL manually:
	echo     %URL%
	start "" "%URL%"
)

echo   You can close this window now.
timeout /t 6 /nobreak >nul
exit /b 0
