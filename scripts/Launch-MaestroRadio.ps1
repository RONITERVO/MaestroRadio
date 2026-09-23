$ErrorActionPreference = 'Stop'
$radioRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $radioRoot
$radioUrl = 'http://127.0.0.1:4317'
function Test-Radio { try { return (Invoke-RestMethod "$radioUrl/api/health" -TimeoutSec 1).ok -eq $true } catch { return $false } }
if (-not (Test-Radio)) {
    $radioNode = (Get-Command node.exe -ErrorAction Stop).Source
    if (-not (Test-Path -LiteralPath "$radioRoot/node_modules/tsx/dist/cli.mjs")) { throw 'Run npm ci in the MaestroRadio folder first.' }
    $radioArguments = @('--import', 'tsx', 'server/index.ts')
    if (Test-Path -LiteralPath "$radioRoot/dist/index.html") { $radioArguments += '--production' }
    Start-Process -FilePath $radioNode -ArgumentList $radioArguments -WorkingDirectory $radioRoot -WindowStyle Hidden
    $radioReady = $false
    for ($radioAttempt = 0; $radioAttempt -lt 40; $radioAttempt++) {
        if (Test-Radio) { $radioReady = $true; break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $radioReady) { throw 'Maestro Radio did not start. Run npm start in the project folder to see the error.' }
}
Start-Process $radioUrl
