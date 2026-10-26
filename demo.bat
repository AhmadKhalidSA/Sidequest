@echo off
rem Replays a scripted lesson so you can see and position the board. No AI, no audio.
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --demo
