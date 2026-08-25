[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string] $Distro,
    [string] $TaskName = 'OpenClaw Personal Assistant WSL Keepalive'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($TaskName -ne 'OpenClaw Personal Assistant WSL Keepalive') {
    throw 'task_name_invalid: only the exact managed task name is allowed'
}

$wslPath = Join-Path -Path $env:SystemRoot -ChildPath 'System32\wsl.exe'
if (-not (Test-Path -LiteralPath $wslPath -PathType Leaf)) {
    throw 'wsl_not_found: wsl.exe is unavailable'
}

$availableDistros = @(& $wslPath --list --quiet) | ForEach-Object { ([string] $_).Trim([char]0).Trim() } | Where-Object { $_ }
if ($availableDistros -notcontains $Distro) {
    throw "wsl_distro_not_found: the explicit distro is not registered for the current user"
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$owner = $identity.Name
if (-not $owner -or $identity.User.Value -eq 'S-1-5-18' -or $owner -match '(?i)\\SYSTEM$') {
    throw 'owner_principal_invalid: task installation is restricted to the current interactive user'
}

$actionArguments = '-d "{0}" --exec /bin/sleep infinity' -f $Distro
$action = New-ScheduledTaskAction -Execute $wslPath -Argument $actionArguments
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $owner -LogonType Password -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
$RestartIntervalIso8601 = 'PT1M'

$plan = [ordered]@{
    taskName = $TaskName
    principal = $owner
    principalSid = $identity.User.Value
    logonType = 'Password (run whether user is logged on or not)'
    trigger = 'AtStartup'
    executable = $wslPath
    arguments = $actionArguments
    restartInterval = $RestartIntervalIso8601
}

if ($PSCmdlet.ShouldProcess($TaskName, 'Register or update the exact owner-scoped startup task')) {
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
    $credential = Get-Credential -UserName $owner -Message 'Enter the current Windows user password for the startup task. It is not logged or accepted as a script argument.'
    if ($credential.UserName -ne $owner) {
        throw 'owner_credential_mismatch: credentials must belong to the current interactive user'
    }
    $taskPassword = $credential.GetNetworkCredential().Password
    try {
        Register-ScheduledTask -TaskName $TaskName -InputObject $task -User $owner -Password $taskPassword -Force | Out-Null
    }
    finally {
        $taskPassword = $null
        $credential = $null
    }
}

$plan | ConvertTo-Json -Compress
