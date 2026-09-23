$ErrorActionPreference = 'Stop'
$radioRoot = Split-Path -Parent $PSScriptRoot
$radioShell = New-Object -ComObject WScript.Shell
$radioIcon = Join-Path $radioRoot 'public\maestro-radio.ico'
$radioLocations = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'Maestro Radio'))
foreach ($radioLocation in $radioLocations) {
    New-Item -ItemType Directory -Force -Path $radioLocation | Out-Null
    $radioLink = $radioShell.CreateShortcut((Join-Path $radioLocation 'Maestro Radio.lnk'))
    $radioLink.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $radioLink.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'Launch-MaestroRadio.ps1') + '"'
    $radioLink.WorkingDirectory = $radioRoot
    $radioLink.Description = 'Start Maestro Radio and open the listening app'
    if (Test-Path -LiteralPath $radioIcon) { $radioLink.IconLocation = $radioIcon }
    $radioLink.WindowStyle = 7
    $radioLink.Hotkey = 'CTRL+ALT+M'
    $radioLink.Save()
    Write-Output (Join-Path $radioLocation 'Maestro Radio.lnk')
}
