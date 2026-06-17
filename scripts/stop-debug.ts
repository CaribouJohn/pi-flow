// Stop the dashboard dev:debug app cleanly. Electrobun's launcher → bun →
// WebView2 is a DETACHED process tree: killing the `electrobun dev` shell leaves
// bun + msedgewebview2 orphaned, holding the CDP port — which segfaults the NEXT
// launch. So this:
//   1. sends WM_CLOSE to the app window (the graceful "click the ✕" path),
//   2. then force-kills any leftover dev-build app procs and frees the port.
// Windows/WebView2 only. Idempotent — safe to run before a launch (pre-clean)
// and after a session (teardown). Mirrors Hiss's scripts/stop-debug.ts; the
// command-line match is keyed to the dashboard app's dev-build paths
// (flowd-dashboard / dev-win-x64).
import { spawnSync } from "node:child_process";

const port = process.env.CDP_PORT ?? "9222";
const ps = `
$ErrorActionPreference = 'SilentlyContinue'
# Graceful: find the dev-build app's bun process (by command line, not a guessable
# window title) and send WM_CLOSE — the same as clicking the window's close button.
$appBun = Get-CimInstance Win32_Process -Filter "name='bun.exe'" |
  Where-Object { $_.CommandLine -match 'flowd-dashboard|dev-win-x64' } | Select-Object -First 1
if ($appBun) {
  $p = Get-Process -Id $appBun.ProcessId -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) {
    [void]$p.CloseMainWindow()
    for ($i = 0; $i -lt 8; $i++) { Start-Sleep -Seconds 1; if ($p.HasExited) { break } }
  }
}
# Fallback: force-kill any lingering dev-build app process tree.
Get-CimInstance Win32_Process -Filter "name='bun.exe' OR name='msedgewebview2.exe' OR name='launcher.exe'" |
  Where-Object { $_.CommandLine -match 'flowd-dashboard|dev-win-x64|remote-debugging-port' } |
  ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }
# Ensure the CDP port is free (kill whatever still holds it).
$held = Get-NetTCPConnection -LocalPort ${port} -State Listen
if ($held) { $held | ForEach-Object { taskkill /PID $_.OwningProcess /T /F 2>$null | Out-Null } }
if (Get-NetTCPConnection -LocalPort ${port} -State Listen) {
  Write-Output 'stop:debug — WARNING: :${port} still held'
} else {
  Write-Output 'stop:debug — clean (:${port} free, no orphans)'
}
`;
const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
  stdio: "inherit",
});
process.exit(r.status ?? 0);
