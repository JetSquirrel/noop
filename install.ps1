# Noop installer (Windows):  irm https://raw.githubusercontent.com/JetSquirrel/noop/main/install.ps1 | iex
# The first machine, once:   $env:NOOP_INIT_ARGS = "--primary"; irm <same url> | iex
# A guest on a shared machine: $env:NOOP_GUEST = "<noop-url> <code>"; irm <same url> | iex
#                              (the line `noop guest invite <label>` prints; no login, no machine key)
$ErrorActionPreference = "Stop"
$HomeDir = if ($env:NOOP_HOME) { $env:NOOP_HOME } elseif ((Test-Path "$HOME\.agent-hub") -and -not (Test-Path "$HOME\.noop")) { "$HOME\.agent-hub" } else { "$HOME\.noop" }
$App = "$HomeDir\app"
$Log = "$HomeDir\install.log"
$Repo = if ($env:NOOP_REPO) { $env:NOOP_REPO } else { "https://github.com/JetSquirrel/noop.git" }
New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
Set-Content -Path $Log -Value "" -Encoding utf8

function Step($name) { Write-Host ("  {0,-30}" -f $name) -NoNewline -ForegroundColor DarkGray }
function Ok($msg = "") { Write-Host "$([char]0x2713) $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "! $msg" -ForegroundColor Yellow }
# Details go to the log as plain UTF-8. Windows PowerShell 5.1 turns anything a program writes to stderr into an error
# record once it is redirected, which "Stop" would treat as fatal, and many tools print progress there. Callers check
# $LASTEXITCODE for real failures.
function Run { param([scriptblock]$b) $ErrorActionPreference = "Continue"; & $b *>&1 | ForEach-Object { "$_" } | Out-File -Append -Encoding utf8 $Log }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }

trap {
  Write-Host ([char]0x2717) -ForegroundColor Red
  Write-Host "`n  Something went wrong: $_`n  Asking the AI medic to fix it (details: $Log)`n"
  if ((Get-Command bun -ErrorAction SilentlyContinue) -and (Test-Path "$App\src\cli.ts")) { bun "$App\src\cli.ts" fix "install.ps1 failed: $_ . Log: $Log" }
  elseif (Get-Command claude -ErrorAction SilentlyContinue) { claude -p "Noop install.ps1 failed on Windows: $_ . Read $Log, fix the cause, then rerun the installer." }
  break
}

Write-Host "`nNoop - your own AI team`n"
if (Test-Path "$HOME\.bun\bin\bun.exe") { $env:Path += ";$HOME\.bun\bin" }  # installed earlier, this window just predates its PATH entry
Step "bun"
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  # bun's installer sets "Stop" itself, so it gets a PowerShell of its own where nothing redirects its curl.exe.
  Run { powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex" }
  $env:Path += ";$HOME\.bun\bin"
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw "bun did not install (see $Log)" }
} else { Run { bun upgrade } }  # an old bun cannot read a newer bun.lock
Ok (bun --version)
Step "Noop"
if (Test-Path "$App\.git") { Run { git -C $App remote set-url origin $Repo; git -C $App pull -q --ff-only }; Check "git pull" } else { Run { git clone -q $Repo $App }; Check "git clone" }
Push-Location $App; Run { bun install --frozen-lockfile }; $deps = $LASTEXITCODE; Pop-Location
if ($deps -ne 0) { throw "bun install failed (exit $deps)" }
# the noop command: bin\noop.cmd, on the user's PATH from the next terminal on and in this one now
$Bin = "$App\bin"
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($UserPath -split ";") -contains $Bin)) { [Environment]::SetEnvironmentVariable("Path", (@($UserPath, $Bin) | Where-Object { $_ }) -join ";", "User") }
if (-not (($env:Path -split ";") -contains $Bin)) { $env:Path += ";$Bin" }
Ok (git -C $App rev-parse --short HEAD)

if ($env:NOOP_GUEST) {
  # A guest gets its own revocable token and nothing else: no init, no owner login, no fleet data, no service.
  $Guest = $env:NOOP_GUEST -split "\s+" | Where-Object { $_ }
  Remove-Item Env:NOOP_GUEST
  if ($Guest.Count -ne 2) { throw "NOOP_GUEST must be `"<noop-url> <code>`", as printed by noop guest invite" }
  Step "AI tools"
  $have = @("claude", "codex") | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue }
  if ($have) { Ok ($have -join ", ") } else { Write-Host "! install claude (or codex) and log in; the guest runs tasks with this account's own login" -ForegroundColor Yellow }
  Step "guest"
  Run { bun "$App\src\cli.ts" guest join $Guest[0] $Guest[1] }; Check "guest join"
  Ok
  Step "background service"; Run { bun "$App\src\cli.ts" guest install }; Check "guest install"; Ok
  Write-Host "`n  The guest now runs in the background and at every login of this account (log: ~\.noop-guest\guest.log).`n  Stop it with: noop guest uninstall`n"
  return
}

Step "AI tools"
$missing = @("claude", "codex", "gh") | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
if ($missing) { Warn "missing: $($missing -join ', ') (install and log in for full capability)" } else { Ok "claude, codex, gh" }
Write-Host ""

$env:NOOP_HOME = $HomeDir
# piped into iex, a script gets no arguments; NOOP_INIT_ARGS carries them
$InitArgs = if ($args.Count) { $args } elseif ($env:NOOP_INIT_ARGS) { $env:NOOP_INIT_ARGS -split "\s+" } else { @() }
bun "$App\src\cli.ts" init @InitArgs
if ($LASTEXITCODE -ne 0) {  # a wrong code or URL needs the owner, not the medic
  Write-Host "`n  This machine has not joined your Noop. Fix the problem above and run the installer again." -ForegroundColor Yellow
  return
}
Step "background service"
Run { bun "$App\src\cli.ts" install }
if ($LASTEXITCODE -eq 0) { Ok } else { Warn "not installed, see $Log. Details: noop doctor" }
Run { powercfg /change standby-timeout-ac 0 }
Write-Host ""
bun "$App\src\cli.ts" status --brief
Write-Host ""
