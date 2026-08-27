@echo off
rem Double-click entry point. With no argument it asks which project; with one it goes straight there.
rem The experimental-feature warning from node:sqlite is suppressed so the list stays readable.
node --no-warnings=ExperimentalWarning "%~dp0open-project-lanes.mjs" %*
echo.
pause
