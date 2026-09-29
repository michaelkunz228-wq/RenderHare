@echo off
rem Render Hare installer for Windows.
rem Put this file in the same folder as RenderHare-<version>.zxp and double-click it.
rem It runs Adobe's own plugin installer (UPIA), which comes with Creative Cloud.
setlocal
set "UPIA=%CommonProgramFiles%\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"

set "ZXP="
for %%F in ("%~dp0RenderHare-*.zxp") do set "ZXP=%%~fF"
if not defined ZXP (
  echo Couldn't find RenderHare-^<version^>.zxp next to this installer.
  echo Download it from the Releases page and put it in this folder.
  pause
  exit /b 1
)
if not exist "%UPIA%" (
  echo Adobe's plugin installer wasn't found. Is Creative Cloud installed?
  echo You can also install "%ZXP%" with a ZXP installer app instead.
  pause
  exit /b 1
)

echo Installing %ZXP% ...
"%UPIA%" /install "%ZXP%"
if errorlevel 1 (
  echo.
  echo The install didn't succeed. Close Premiere Pro and try again.
  pause
  exit /b 1
)
echo.
echo Done. Restart Premiere Pro, then open Window ^> Extensions ^> Render Hare.
pause
