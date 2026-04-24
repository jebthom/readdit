@echo off
cd /d "C:\Users\freez\Readdit"
start "" python -m http.server 8000 --directory .
