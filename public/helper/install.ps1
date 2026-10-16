# fetch helper setup for Windows. Run from the fetch helper page:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://coffee.ystmk1.workers.dev/helper/install.ps1 | iex"
# What it does: writes server.ps1, host.ps1 and host.bat into %LOCALAPPDATA%\FetchHelper, registers the
# native messaging host com.fetch.helper for Chrome, Edge and Brave (current user only), and starts the
# local server on localhost:47321. Nothing else is installed or changed.
$ErrorActionPreference = 'Stop'
try { $Host.UI.RawUI.WindowTitle = 'fetch helper setup' } catch {}
$dir = Join-Path $env:LOCALAPPDATA 'FetchHelper'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
# Stop an older server so the new version takes over
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*FetchHelper*server.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$enc = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $dir 'server.ps1'), @'
# Fetch helper: a tiny HTTP server on localhost that hands saved images to the Figma plugin.
# Plain TCP (no HTTP.sys), so it needs no admin rights or URL reservations.
#   POST /push   {folder,name,path}   only from the Fetch extension; path must be an image inside Downloads
#   POST /push   {folder,name,data}   same, with PNG bytes (base64), e.g. a video frame; kept in .\cache for a day
#   GET  /items?after=N               new items for the Figma plugin
#   GET  /file?id=N                   image bytes of a pushed item
#   GET  /ping, POST /quit
$ErrorActionPreference = 'Stop'
$Port = 47321
$Version = '1.2.0'
# The unpacked (developer) copy and the Chrome Web Store copy have different IDs; build-store.mjs adds the store one.
$ExtOrigins = @('chrome-extension://hkhnbfjdbacffnoomhaoclfcjnpdjgla')
$IdleExitSeconds = 6 * 3600

try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
} catch {
    exit 0   # already running
}

$downloads = $null
try { $downloads = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path } catch {}
if (-not $downloads) { $downloads = Join-Path $env:USERPROFILE 'Downloads' }
$downloads = [IO.Path]::GetFullPath($downloads).TrimEnd('\') + '\'

$cache = Join-Path $PSScriptRoot 'cache'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
Get-ChildItem -LiteralPath $cache -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } | Remove-Item -Force -ErrorAction SilentlyContinue

$items = New-Object System.Collections.ArrayList
$nextId = 1
$lastSeen = Get-Date
$mime = @{ '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.gif' = 'image/gif' }

function Send-Response($stream, [int]$code, [string]$type, [byte[]]$body, [string]$origin) {
    $reason = @{ 200 = 'OK'; 204 = 'No Content'; 400 = 'Bad Request'; 403 = 'Forbidden'; 404 = 'Not Found' }[$code]
    $h = "HTTP/1.1 $code $reason`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nConnection: close`r`nCache-Control: no-store`r`n"
    if ($origin) {
        $h += "Access-Control-Allow-Origin: $origin`r`nAccess-Control-Allow-Methods: GET, POST, OPTIONS`r`nAccess-Control-Allow-Headers: content-type, x-fetch`r`nAccess-Control-Allow-Private-Network: true`r`n"
    }
    $hb = [Text.Encoding]::ASCII.GetBytes($h + "`r`n")
    $stream.Write($hb, 0, $hb.Length)
    if ($body.Length) { $stream.Write($body, 0, $body.Length) }
}
function Json($obj) { [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 4)) }

function Read-Request($stream) {
    $buf = New-Object byte[] 65536
    $ms = New-Object IO.MemoryStream
    $headerEnd = -1
    while ($headerEnd -lt 0) {
        $n = $stream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { return $null }
        $ms.Write($buf, 0, $n)
        $all = $ms.ToArray()
        for ($i = [Math]::Max(0, $all.Length - $n - 3); $i -le $all.Length - 4; $i++) {
            if ($all[$i] -eq 13 -and $all[$i + 1] -eq 10 -and $all[$i + 2] -eq 13 -and $all[$i + 3] -eq 10) { $headerEnd = $i; break }
        }
        if ($ms.Length -gt 1MB) { return $null }
    }
    $all = $ms.ToArray()
    $head = [Text.Encoding]::ASCII.GetString($all, 0, $headerEnd)
    $lines = $head -split "`r`n"
    $parts = $lines[0] -split ' '
    $headers = @{}
    foreach ($l in $lines[1..($lines.Length - 1)]) {
        $k = $l.IndexOf(':')
        if ($k -gt 0) { $headers[$l.Substring(0, $k).Trim().ToLower()] = $l.Substring($k + 1).Trim() }
    }
    $len = 0
    if ($headers['content-length']) { $len = [int]$headers['content-length'] }
    if ($len -gt 48MB) { return $null }
    $body = New-Object IO.MemoryStream
    $have = $all.Length - ($headerEnd + 4)
    if ($have -gt 0) { $body.Write($all, $headerEnd + 4, $have) }
    while ($body.Length -lt $len) {
        $n = $stream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $body.Write($buf, 0, $n)
    }
    return @{ Method = $parts[0]; Target = $parts[1]; Headers = $headers; Body = [Text.Encoding]::UTF8.GetString($body.ToArray()) }
}

while ($true) {
    if (-not $listener.Pending()) {
        if (((Get-Date) - $lastSeen).TotalSeconds -gt $IdleExitSeconds) { break }
        Start-Sleep -Milliseconds 40
        continue
    }
    $client = $listener.AcceptTcpClient()
    $client.ReceiveTimeout = 5000
    $client.SendTimeout = 15000
    $stream = $client.GetStream()
    $quit = $false
    try {
        $req = Read-Request $stream
        if (-not $req) { continue }
        $lastSeen = Get-Date
        $origin = $req.Headers['origin']
        # Figma plugin UIs run with an opaque ("null") origin; the extension has its own origin.
        $fromExt = $ExtOrigins -contains $origin
        $fromPlugin = ($origin -eq 'null') -or ($origin -match '^https://([a-z0-9-]+\.)*figma\.com$')
        $cors = if ($fromExt -or $fromPlugin) { $origin } else { $null }
        $path, $query = $req.Target -split '\?', 2
        $q = @{}
        if ($query) { foreach ($kv in $query -split '&') { $a, $b = $kv -split '=', 2; $q[$a] = [Uri]::UnescapeDataString([string]$b) } }

        if ($req.Method -eq 'OPTIONS') { Send-Response $stream 204 'text/plain' ([byte[]]@()) $cors; continue }

        switch ($path) {
            '/ping' { Send-Response $stream 200 'application/json' (Json @{ ok = $true; version = $Version; items = $items.Count }) $cors }
            '/push' {
                if ($req.Method -ne 'POST' -or -not $fromExt -or $req.Headers['x-fetch'] -ne '1') { Send-Response $stream 403 'text/plain' ([byte[]]@()) $null; break }
                $m = $req.Body | ConvertFrom-Json
                if ($m.data) {
                    # PNG bytes from the extension: store them in our cache and serve from there
                    $bytes = [Convert]::FromBase64String([string]$m.data)
                    if ($bytes.Length -lt 8 -or $bytes[0] -ne 0x89 -or $bytes[1] -ne 0x50) { Send-Response $stream 400 'application/json' (Json @{ ok = $false; error = 'not a PNG' }) $cors; break }
                    $full = Join-Path $cache ("{0}.png" -f [Guid]::NewGuid().ToString('N'))
                    [IO.File]::WriteAllBytes($full, $bytes)
                    $item = @{ id = $nextId; folder = [string]$m.folder; name = [string]$m.name; path = $full; type = 'image/png'; t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
                    $nextId++
                    [void]$items.Add($item)
                    while ($items.Count -gt 500) { $items.RemoveAt(0) }
                    Send-Response $stream 200 'application/json' (Json @{ ok = $true; id = $item.id }) $cors
                    break
                }
                $full = [IO.Path]::GetFullPath([string]$m.path)
                $ext = [IO.Path]::GetExtension($full).ToLower()
                if (-not $full.StartsWith($downloads, [StringComparison]::OrdinalIgnoreCase) -or -not $mime.ContainsKey($ext) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
                    Send-Response $stream 400 'application/json' (Json @{ ok = $false; error = 'not an image inside Downloads' }) $cors; break
                }
                $item = @{ id = $nextId; folder = [string]$m.folder; name = [string]$m.name; path = $full; type = $mime[$ext]; t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
                $nextId++
                [void]$items.Add($item)
                while ($items.Count -gt 500) { $items.RemoveAt(0) }
                Send-Response $stream 200 'application/json' (Json @{ ok = $true; id = $item.id }) $cors
            }
            '/items' {
                if (-not ($fromPlugin -or $fromExt)) { Send-Response $stream 403 'text/plain' ([byte[]]@()) $null; break }
                $after = 0; if ($q['after']) { $after = [int]$q['after'] }
                $list = @($items | Where-Object { $_.id -gt $after } | ForEach-Object { @{ id = $_.id; folder = $_.folder; name = $_.name; t = $_.t } })
                Send-Response $stream 200 'application/json' (Json @{ latest = ($nextId - 1); items = $list }) $cors
            }
            '/file' {
                if (-not ($fromPlugin -or $fromExt)) { Send-Response $stream 403 'text/plain' ([byte[]]@()) $null; break }
                $id = [int]$q['id']
                $it = $items | Where-Object { $_.id -eq $id } | Select-Object -First 1
                if (-not $it -or -not (Test-Path -LiteralPath $it.path)) { Send-Response $stream 404 'text/plain' ([byte[]]@()) $cors; break }
                Send-Response $stream 200 $it.type ([IO.File]::ReadAllBytes($it.path)) $cors
            }
            '/quit' {
                if (-not $fromExt) { Send-Response $stream 403 'text/plain' ([byte[]]@()) $null; break }
                Send-Response $stream 200 'application/json' (Json @{ ok = $true }) $cors
                $quit = $true
            }
            default { Send-Response $stream 404 'text/plain' ([byte[]]@()) $cors }
        }
    } catch {
        try { Send-Response $stream 400 'text/plain' ([Text.Encoding]::UTF8.GetBytes($_.Exception.Message)) $null } catch {}
    } finally {
        try { $stream.Flush(); $client.Close() } catch {}
    }
    if ($quit) { break }
}
$listener.Stop()

'@, $enc)
[IO.File]::WriteAllText((Join-Path $dir 'host.ps1'), @'
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

'@, $enc)
[IO.File]::WriteAllText((Join-Path $dir 'host.bat'), "@echo off`r`npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"%~dp0host.ps1`"`r`n", $enc)
$manifest = [ordered]@{ name = 'com.fetch.helper'; description = 'fetch helper'; path = (Join-Path $dir 'host.bat'); type = 'stdio'; allowed_origins = @('chrome-extension://hkhnbfjdbacffnoomhaoclfcjnpdjgla/') } | ConvertTo-Json
$mpath = Join-Path $dir 'com.fetch.helper.json'
[IO.File]::WriteAllText($mpath, $manifest, $enc)
foreach ($k in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.fetch.helper', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.fetch.helper', 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.fetch.helper')) {
  New-Item -Path $k -Force | Out-Null
  Set-Item -Path $k -Value $mpath
}
Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + (Join-Path $dir 'server.ps1') + '"'))
Write-Host ''
Write-Host '  fetch helper installed. Go back to Chrome. This window closes by itself.'
Start-Sleep -Seconds 2
