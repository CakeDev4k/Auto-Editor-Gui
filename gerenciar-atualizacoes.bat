@echo off
rem Menu para gerenciar as atualizacoes do PrimeTrim (auto-update via GitHub).
rem Fluxo completo: [2] lanca a versao -> a action cria um RASCUNHO de release
rem -> [3] abre o rascunho para conferir e clicar em "Publish release".
rem Nada chega aos usuarios antes desse clique.
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "REPO=CakeDev4k/Auto-Editor-Gui"
set "CHAVE=%USERPROFILE%\.tauri\primetrim.key"

where git >nul 2>&1 || (echo [erro] git nao encontrado. & pause & exit /b 1)
where npm >nul 2>&1 || (echo [erro] Node.js/npm nao encontrado. & pause & exit /b 1)

:menu
cls
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "VERSAO=%%v"
for /f "usebackq delims=" %%b in (`git rev-parse --abbrev-ref HEAD`) do set "BRANCH=%%b"
echo ============================================
echo   PrimeTrim - atualizacoes
echo   versao atual: !VERSAO!    branch: !BRANCH!
echo ============================================
echo.
echo   [1] Ver releases e status da ultima build
echo   [2] Lancar nova versao (gera rascunho no GitHub)
echo   [3] Abrir releases no GitHub (publicar rascunho)
echo   [4] Build local assinado (so testa, nao publica)
echo   [5] Configurar chave de assinatura no GitHub
echo   [0] Sair
echo.
set "OP="
set /p "OP=Escolha: "
if "%OP%"=="1" goto ver
if "%OP%"=="2" goto lancar
if "%OP%"=="3" goto abrir
if "%OP%"=="4" goto build
if "%OP%"=="5" goto chave
if "%OP%"=="0" exit /b 0
goto menu

rem ------------------------------------------------------------------ [1]
:ver
call :precisa_gh || goto menu
echo.
echo --- Releases (rascunhos aparecem como Draft) ---
gh release list --repo %REPO% --limit 8
echo.
echo --- Ultimas execucoes da action de release ---
gh run list --repo %REPO% --workflow release.yml --limit 5
echo.
pause
goto menu

rem ------------------------------------------------------------------ [2]
:lancar
echo.
git diff --quiet && git diff --cached --quiet
if errorlevel 1 (
  echo [erro] Ha mudancas nao commitadas. Commite ou descarte antes de lancar.
  echo.
  git status --short
  pause
  goto menu
)
echo Versao atual: !VERSAO!
echo Digite a nova versao ^(ex.: 0.2.0^), ou patch / minor / major:
set "NOVA="
set /p "NOVA=Nova versao: "
if "!NOVA!"=="" goto menu
call npm version !NOVA! --no-git-tag-version >nul || (echo [erro] versao invalida. & pause & goto menu)
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "NOVA=%%v"

git rev-parse -q --verify "refs/tags/v!NOVA!" >nul 2>&1
if not errorlevel 1 (
  echo [erro] A tag v!NOVA! ja existe.
  git checkout -- package.json package-lock.json
  pause
  goto menu
)

echo.
echo Vai acontecer:
echo   - package.json: !VERSAO! -^> !NOVA!
echo   - commit "release: v!NOVA!" na branch !BRANCH!
echo   - tag v!NOVA! e push da branch e da tag para o GitHub
echo   - a action compila e cria um RASCUNHO de release ^(nao publica^)
echo.
set "OK="
set /p "OK=Confirmar? (s/n): "
if /i not "!OK!"=="s" (
  git checkout -- package.json package-lock.json
  echo Cancelado. Nada foi alterado.
  pause
  goto menu
)

git add package.json package-lock.json
git commit -m "release: v!NOVA!" || (pause & goto menu)
git tag -a "v!NOVA!" -m "PrimeTrim v!NOVA!" || (pause & goto menu)
git push origin HEAD || (echo [erro] push da branch falhou. & pause & goto menu)
git push origin "v!NOVA!" || (echo [erro] push da tag falhou. & pause & goto menu)
echo.
echo Pronto. A build leva uns minutos. Acompanhe com a opcao [1] e,
echo quando terminar, use [3] para conferir e publicar o rascunho.
pause
goto menu

rem ------------------------------------------------------------------ [3]
:abrir
start "" "https://github.com/%REPO%/releases"
goto menu

rem ------------------------------------------------------------------ [4]
:build
if not exist "%CHAVE%" (
  echo [erro] Chave nao encontrada em %CHAVE%
  pause
  goto menu
)
where cargo >nul 2>&1 || (echo [erro] Rust/cargo nao encontrado. & pause & goto menu)
if not exist node_modules call npm install
for /f "usebackq delims=" %%k in (`powershell -NoProfile -Command "(Get-Content -Raw '%CHAVE%').Trim()"`) do set "TAURI_SIGNING_PRIVATE_KEY=%%k"
set "TAURI_SIGNING_PRIVATE_KEY_PASSWORD="
call npx tauri build --bundles nsis
if errorlevel 1 (
  echo [erro] build falhou.
) else (
  echo.
  echo Instalador e assinatura em src-tauri\target\release\bundle\nsis\
  start "" "src-tauri\target\release\bundle\nsis"
)
set "TAURI_SIGNING_PRIVATE_KEY="
pause
goto menu

rem ------------------------------------------------------------------ [5]
:chave
call :precisa_gh || goto menu
if not exist "%CHAVE%" (
  echo [erro] Chave nao encontrada em %CHAVE%
  pause
  goto menu
)
echo.
echo Isto envia a chave PRIVADA de %CHAVE%
echo para os segredos do repositorio %REPO% ^(so a action consegue ler^).
echo Necessario uma vez, antes do primeiro lancamento.
set "OK="
set /p "OK=Confirmar? (s/n): "
if /i not "!OK!"=="s" goto menu
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo %REPO% < "%CHAVE%" || (pause & goto menu)
rem A chave foi gerada sem senha: o segredo TAURI_SIGNING_PRIVATE_KEY_PASSWORD
rem pode ficar sem cadastro, a action le vazio.
echo Segredos configurados.
pause
goto menu

rem ------------------------------------------------------------------ util
:precisa_gh
where gh >nul 2>&1 || (
  echo [erro] GitHub CLI ^(gh^) nao encontrado. Instale em https://cli.github.com
  pause
  exit /b 1
)
gh auth status >nul 2>&1 || (
  echo [erro] gh nao esta logado. Rode: gh auth login
  pause
  exit /b 1
)
exit /b 0
