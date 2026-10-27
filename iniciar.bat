@echo off
rem Abre o PrimeTrim em modo de desenvolvimento (Vite + Tauri).
chcp 65001 >nul
cd /d "%~dp0"

where npm >nul 2>&1 || (
  echo [erro] Node.js/npm nao encontrado. Instale em https://nodejs.org
  pause
  exit /b 1
)
where cargo >nul 2>&1 || (
  echo [erro] Rust/cargo nao encontrado. Instale em https://rustup.rs
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instalando dependencias...
  call npm install || (pause & exit /b 1)
)

call npm run tauri dev
if errorlevel 1 pause
