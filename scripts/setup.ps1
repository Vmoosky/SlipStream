$ErrorActionPreference = 'Stop'

& node (Join-Path $PSScriptRoot 'develop.mjs') setup
exit $LASTEXITCODE
