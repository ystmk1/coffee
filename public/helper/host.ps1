# Fetch helper launcher (Chrome native messaging host). Chrome starts this on demand; it makes sure
# the local server (server.ps1) is running, then exits. One request per launch:
# 4-byte little-endian length + UTF-8 JSON in, same format out.
$ErrorActionPreference = 'Stop'
$Version = '1.2.0'
$Port = 47321
$Dir = $PSScriptRoot
$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Read-Exact([int]$n) {
    $buf = New-Object byte[] $n
    $got = 0
    while ($got -lt $n) {
        $r = $stdin.Read($buf, $got, $n - $got)
        if ($r -le 0) { exit 0 }
        $got += $r
    }
    return ,$buf
}
function Send($obj) {
    $b = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
    $stdout.Write([BitConverter]::GetBytes([int]$b.Length), 0, 4)
    $stdout.Write($b, 0, $b.Length)
    $stdout.Flush()
}
function Test-Server {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $ok = $c.ConnectAsync('127.0.0.1', $Port).Wait(400)
        $c.Close()
        return $ok
    } catch { return $false }
}

try {
    $len = [BitConverter]::ToInt32((Read-Exact 4), 0)
    $msg = [Text.Encoding]::UTF8.GetString((Read-Exact $len)) | ConvertFrom-Json
    switch ($msg.action) {
        'ping' { Send @{ ok = $true; version = $Version; running = (Test-Server) } }
        'ensure' {
            $started = $false
            if (-not (Test-Server)) {
                Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$Dir\server.ps1`"")
                $started = $true
                for ($i = 0; $i -lt 30 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 100 }
            }
            Send @{ ok = (Test-Server); started = $started; version = $Version }
        }
        'uninstall' {
            foreach ($k in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.fetch.helper',
                             'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.fetch.helper',
                             'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.fetch.helper')) {
                if (Test-Path $k) { Remove-Item $k -Force }
            }
            Send @{ ok = $true }
            # Remove our own folder once this process has exited.
            Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList @('/c', "timeout /t 2 >nul & rmdir /s /q `"$Dir`"")
        }
        default { Send @{ ok = $false; error = "unknown action: $($msg.action)" } }
    }
} catch {
    Send @{ ok = $false; error = $_.Exception.Message }
}
