# tinySAmomo - PowerShell launcher
# WebSerial requires http://localhost (or https://). file:// is not supported.

$Port = 8765
Set-Location -LiteralPath $PSScriptRoot

Start-Job -ScriptBlock {
  Start-Sleep -Seconds 1
  Start-Process "http://localhost:$using:Port/index.html"
} | Out-Null

Write-Host "Starting tinySAmomo on http://localhost:$Port"
Write-Host "Press Ctrl+C to stop."
python -m http.server $Port
