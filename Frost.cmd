@echo off
rem Builds and installs Frost, then creates Start menu and Desktop shortcuts you can pin.
rem   Frost.cmd            build + install
rem   Frost.cmd -Update    git pull first
rem   Frost.cmd -Launch    start Frost when done
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-frost.ps1" %*
if errorlevel 1 pause
