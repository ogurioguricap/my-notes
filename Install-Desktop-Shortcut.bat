@echo off
rem ============================================================
rem  Create "My Notes" desktop shortcut (with custom icon)
rem  Adds:  My Notes (online) / offline single-file / help page
rem  Only writes to the Desktop; nothing else on the system.
rem ============================================================
title Create desktop shortcut - My Notes
echo.
echo   Creating desktop shortcuts for "My Notes" ...
echo.
cscript //nologo "%~dp0create-shortcut.vbs" 2>nul
if errorlevel 1 (
  echo   [fallback] trying the PowerShell version ...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1"
)
if errorlevel 1 (
  echo.
  echo   Failed. Do it manually:
  echo   1^) Open this folder: %~dp0
  echo   2^) Drag any shortcut below onto your Desktop
  echo.
  pause
)
