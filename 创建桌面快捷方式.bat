@echo off
chcp 65001 >nul
title 创建「我的笔记」桌面快捷方式
echo.
echo   正在为「我的笔记」创建桌面快捷方式...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0创建桌面快捷方式.ps1"
if errorlevel 1 (
  echo.
  echo   如果上面有报错，可以手动操作：
  echo   1^) 打开本文件夹
  echo   2^) 右键「我的笔记.url」-^> 发送到 -^> 桌面快捷方式
  echo.
  pause
)
