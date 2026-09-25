@echo off
:: Start the standalone RefThing desktop app.
:: Rebuilds it first if any source changed since the last build.
:: Add  -Rebuild  after the script path below to force a fresh build.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\refthing.ps1" -Mode app
