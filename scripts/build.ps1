$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$distPath = Join-Path $projectRoot "dist"
$distSrcPath = Join-Path $distPath "src"

New-Item -ItemType Directory -Force -Path $distPath | Out-Null
New-Item -ItemType Directory -Force -Path $distSrcPath | Out-Null

Copy-Item -Path (Join-Path $projectRoot "manifest.json") -Destination (Join-Path $distPath "manifest.json") -Force
Copy-Item -Path (Join-Path $projectRoot "popup.html") -Destination (Join-Path $distPath "popup.html") -Force
Copy-Item -Path (Join-Path $projectRoot "src\*.js") -Destination $distSrcPath -Force
Copy-Item -Path (Join-Path $projectRoot "src\*.css") -Destination $distSrcPath -Force

Write-Output "Built extension into $distPath"
