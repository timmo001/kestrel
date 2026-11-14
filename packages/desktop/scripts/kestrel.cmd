@echo off
rem The one `kestrel` command, from inside the app's bundle. With nothing
rem after it, it opens the desktop app; `kestrel serve` runs the server with
rem no window, and anything else is the CLI, on the bundle's own Bun.
setlocal
set "app=%~dp0"
set "bundle=%app%..\.."

if "%~1"=="" (
  start "" "%bundle%\bin\launcher.exe"
  exit /b 0
)

if /i "%~1"=="serve" (
  if not defined KESTREL_WEB set "KESTREL_WEB=%app%web"
  if not defined KESTREL_GO2RTC set "KESTREL_GO2RTC=%app%go2rtc\go2rtc.exe"
  if not defined KESTREL_YT_DLP set "KESTREL_YT_DLP=%app%yt-dlp\yt-dlp.exe"
  if not defined KESTREL_NODE set "KESTREL_NODE=%app%node\node.exe"
)

rem Settings come from the config folder and the environment, never from a
rem .env or bunfig.toml wherever kestrel happens to be run
"%bundle%\bin\bun.exe" --no-env-file --config="%app%cli\bunfig.toml" "%app%cli\kestrel.js" %*
exit /b %errorlevel%
