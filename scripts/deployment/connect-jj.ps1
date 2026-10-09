param(
    [ValidatePattern('^[a-zA-Z0-9._-]+$')][string]$ComputerAlias = 'jj',
    [ValidateRange(1024,65535)][int]$LocalPort = 4312,
    [ValidateRange(1024,65535)][int]$RemotePort = 4310
)
$ErrorActionPreference = 'Stop'
$sshProgram = Get-Command ssh -CommandType Application -ErrorAction Stop
if (Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction SilentlyContinue) {
    throw "本机端口 $LocalPort 已被使用。保留已有进程；请指定其他 -LocalPort。"
}
$arguments = @('-N', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
    '-L', "127.0.0.1:${LocalPort}:127.0.0.1:${RemotePort}", $ComputerAlias)
$tunnelProcess = Start-Process -FilePath $sshProgram.Source -ArgumentList $arguments -WindowStyle Hidden -PassThru
$url = "http://127.0.0.1:$LocalPort/"
try {
    $connected = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $tunnelProcess.Refresh()
        if ($tunnelProcess.HasExited) { throw "SSH 隧道已退出：$($tunnelProcess.ExitCode)。请检查 ssh $ComputerAlias。" }
        try {
            $reply = Invoke-WebRequest -Uri "$($url)api/health" -TimeoutSec 2 -UseBasicParsing
            $health = $reply.Content | ConvertFrom-Json
            if ($reply.StatusCode -eq 200 -and $health.database -eq 'connected' -and $health.workspace.kind -eq 'local') {
                $connected = $true
                break
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $connected) { throw 'SSH 隧道未能连接到为伍，请检查 JJ 上的 weiwu-jj.service。' }
    $record = [ordered]@{ url=$url; tunnelPid=$tunnelProcess.Id; processStartedAt=$tunnelProcess.StartTime.ToUniversalTime().ToString('o'); computerAlias=$ComputerAlias; localPort=$LocalPort; remotePort=$RemotePort; database=$health.database }
    $record | ConvertTo-Json
    Write-Host "网页地址：$url"
    Write-Host "本次隧道 PID：$($tunnelProcess.Id)。关闭该 PID 的 SSH 进程即可断开；JJ 服务继续运行。"
} catch {
    # This handle identifies only the tunnel created above, never other SSH processes.
    if (-not $tunnelProcess.HasExited) { $tunnelProcess.Kill() }
    throw
}
