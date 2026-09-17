@echo off
rem ============================================================
rem  Create "My Notes" desktop shortcuts (with custom icon)
rem  Adds: My Notes (online) / offline single file / help page
rem  Writes only to your Desktop. Nothing else on the system.
rem ============================================================
title Create desktop shortcut - My Notes
echo.
echo   Creating desktop shortcuts for "My Notes" ...
echo.
cscript //nologo "%~dp0create-shortcut.vbs"
if errorlevel 1 (
  echo.
  echo   If it failed, do it manually:
  echo   1^) Copy  my-notes.ico  to your Desktop
  echo   2^) Right-click Desktop ^> New ^> Shortcut
  echo   3^) Paste:  https://ogurioguricap.github.io/my-notes/
  echo   4^) Then right-click the shortcut ^> Properties ^> Change Icon
  echo.
  pause
)