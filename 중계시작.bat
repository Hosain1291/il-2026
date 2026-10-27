@echo off
chcp 65001 >nul
title 이스라엘 총선 개표 중계
cd /d "%~dp0"
python scripts\relay.py %*
if errorlevel 9009 py scripts\relay.py %*
pause
