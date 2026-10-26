@echo off
rem Sidequest: study overlay. Starts the panel + engine and closes this window.
rem (VS Code terminals set ELECTRON_RUN_AS_NODE, which turns Electron into plain Node.)
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
