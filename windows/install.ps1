[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [ValidateSet('Chrome', 'Edge')]
    [string]$Browser = 'Chrome',
    [string]$WorkspaceRoot = (Join-Path $HOME 'ChatGPTWorkspace')
)
$ErrorActionPreference = 'Stop'
$sourceHost = Join-Path $PSScriptRoot 'companion.py'
if (-not (Test-Path -LiteralPath $sourceHost -PathType Leaf)) { throw "Companion not found: $sourceHost" }
$pythonCmd = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $pythonCmd) { throw 'python.exe was not found on PATH. Install Python 3.10+ and reopen PowerShell.' }
$pythonPath = (Resolve-Path $pythonCmd.Source).Path
$base = Join-Path $env:LOCALAPPDATA 'ChatGPTWindowsBridge'
New-Item -ItemType Directory -Force -Path $base | Out-Null
$workspace = [System.IO.Path]::GetFullPath($WorkspaceRoot)
New-Item -ItemType Directory -Force -Path $workspace | Out-Null
$installedHost = Join-Path $base 'companion.py'
Copy-Item -LiteralPath $sourceHost -Destination $installedHost -Force

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$configText = @{ workspace_root = $workspace; protocol_version = 1 } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $base 'config.json'), $configText, $utf8NoBom)

$manifestPath = Join-Path $base 'com.chatgpt.windowsbridge.json'
$manifest = @{
    name = 'com.chatgpt.windowsbridge'
    description = 'Constrained local execution host for ChatGPT Windows Bridge'
    path = $pythonPath
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
    args = @($installedHost)
} | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $manifest, $utf8NoBom)

if ($Browser -eq 'Chrome') {
    $regPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.chatgpt.windowsbridge'
} else {
    $regPath = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.chatgpt.windowsbridge'
}
New-Item -Path $regPath -Force | Out-Null
Set-Item -Path $regPath -Value $manifestPath
Write-Host ''
Write-Host 'ChatGPT Windows Bridge native host installed for the current Windows user.'
Write-Host "Browser: $Browser"
Write-Host "Extension ID: $ExtensionId"
Write-Host "Workspace: $workspace"
Write-Host "Manifest: $manifestPath"
Write-Warning 'Prototype access includes constrained reads/writes and pytest in the selected workspace. Review source and use a disposable workspace first.'
