[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
    [string] $DirectoryPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolved = (Resolve-Path -LiteralPath $DirectoryPath).Path
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$administrators = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow

$acl = Get-Acl -LiteralPath $resolved
$ownerSid = ([System.Security.Principal.NTAccount] $acl.Owner).Translate([System.Security.Principal.SecurityIdentifier])
if ($ownerSid.Value -ne $current.Value) {
    throw 'artifact_acl_unsafe: directory owner is not the current interactive user'
}
$existingRules = @($acl.Access)
$existingSids = @($existingRules | ForEach-Object {
    $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
})
$alreadyPrivate = $acl.AreAccessRulesProtected -and
    @($existingRules | Where-Object IsInherited).Count -eq 0 -and
    @($existingRules | Where-Object AccessControlType -ne Allow).Count -eq 0 -and
    @($existingSids | Where-Object { $_ -ne $current.Value -and $_ -ne $administrators.Value }).Count -eq 0 -and
    $existingSids -contains $current.Value -and $existingSids -contains $administrators.Value
if ($alreadyPrivate) { return }
$acl.SetAccessRuleProtection($true, $false)
@($acl.Access) | ForEach-Object { [void] $acl.RemoveAccessRuleSpecific($_) }
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $current, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow
))
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $administrators, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow
))
Set-Acl -LiteralPath $resolved -AclObject $acl

$verified = Get-Acl -LiteralPath $resolved
if (-not $verified.AreAccessRulesProtected -or @($verified.Access | Where-Object IsInherited).Count -ne 0) {
    throw 'artifact_acl_unsafe: failed to establish a protected owner-private ACL'
}
