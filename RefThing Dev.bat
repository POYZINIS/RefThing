@echo off
:: Start RefThing in the Tauri dev window (hot reload, uses the repo's .\data).
:: Close this console window to stop it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\refthing.ps1" -Mode dev
