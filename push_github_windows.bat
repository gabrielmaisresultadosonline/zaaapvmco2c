@echo off
setlocal
cd /d "%~dp0"

set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if exist "%BASH%" goto run

set "BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if exist "%BASH%" goto run

echo Git Bash nao encontrado. Instale o Git for Windows.
pause
exit /b 1

:run
"%BASH%" -lc "./push_github_gitbash.sh"
pause
