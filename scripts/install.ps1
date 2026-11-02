<#
.SYNOPSIS
    Install (or roll back) the @deepseek-ai/dsh-tool-session-title plugin in a
    DSH profile.

.DESCRIPTION
    Copies this repository's src/ into the profile's node_modules and inserts
    one entry at the front of the profile's cordis.patch.yml `- insert:` list.

    Safety properties, in order of importance:
      * Anchor insert. The new entry always goes on the line immediately after
        the FIRST `- insert:` key, i.e. as the first child of that list. The
        script never looks for the end of the block, so sibling keys (`after:`),
        comments before/after the block and multi-entry lists are untouched.
        A layout it cannot prove safe is a hard failure: nothing is written.
      * Encoding. The patch file is only read/written with
        [System.IO.File]::ReadAllText / WriteAllText and an explicit UTF-8
        (no BOM) encoding. Legacy text cmdlets never read or write it, so
        Windows PowerShell 5.1 cannot transcode Chinese content to ANSI.
      * Transactional install: backup -> staging copy -> verify -> swap old
        directory aside -> activate -> write patch; every step rolls back.
      * Transactional rollback: no usable backup (missing, or still referencing
        this plugin) means exit code 1 with nothing deleted.
      * -WhatIf performs every check and prints every action without writing.

.PARAMETER WhatIf
    Dry run. Validate and print every planned action; change nothing.

.PARAMETER Rollback
    Restore the newest safe cordis.patch.yml backup and delete the package
    directory. Refuses (exit 1, no changes) when no safe backup exists.

.PARAMETER Force
    Refresh an existing package directory instead of skipping the copy.

.PARAMETER ProfilePath
    DSH profile to modify. Defaults to %USERPROFILE%\.dsh\profiles\desktop.

.PARAMETER SourcePath
    Plugin source to copy. Defaults to this repository's src/.

.EXAMPLE
    .\scripts\install.ps1 -WhatIf

.EXAMPLE
    .\scripts\install.ps1

.EXAMPLE
    .\scripts\install.ps1 -Rollback

.NOTES
    Written for Windows PowerShell 5.1 and PowerShell 7+. No external modules.
#>
[CmdletBinding()]
param(
    [switch]$WhatIf,
    [switch]$Rollback,
    [switch]$Force,
    [string]$ProfilePath,
    [string]$SourcePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- constants -------------------------------------------------------------

$PluginId      = 'tool-session-title'
$PackageName   = '@deepseek-ai/dsh-tool-session-title'
$PackageLeaf   = 'dsh-tool-session-title'
$PatchFileName = 'cordis.patch.yml'
$MaxBackups    = 5

if ([string]::IsNullOrWhiteSpace($SourcePath)) {
    $SourcePath = Join-Path $PSScriptRoot '..\src'
}
$SourceDir = [System.IO.Path]::GetFullPath($SourcePath)

if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
    $ProfilePath = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
}
$ProfilePath = [System.IO.Path]::GetFullPath($ProfilePath)
$PatchPath   = Join-Path $ProfilePath $PatchFileName
$ModulesRoot = Join-Path $ProfilePath 'node_modules\@deepseek-ai'
$DestDir     = Join-Path $ModulesRoot $PackageLeaf

# Shared state (script scope keeps it visible to the finally block).
$script:activeStamp = $null
$script:activeBackup = $null

# --- encoding / text helpers ----------------------------------------------

# The single encoding used for every patch read and write: UTF-8, no BOM.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-TextFile {
    param([string]$Path)
    return [System.IO.File]::ReadAllText($Path, $Utf8NoBom)
}

function Write-TextAtomic {
    # Write a sibling temp file, then rename it over the target. The temp file
    # starts with `.` (no backup glob can match) and lives on the same volume.
    param([string]$Path, [string]$Text)
    $temp = Join-Path (Split-Path -Parent $Path) ('.' + (Split-Path -Leaf $Path) + '.tmp-' + [System.Guid]::NewGuid().ToString('N'))
    [System.IO.File]::WriteAllText($temp, $Text, $Utf8NoBom)
    Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Assert-NoTab {
    param([string]$Text, [string]$What)
    if ($Text.Contains("`t")) {
        throw "$What contains a tab character; refusing to touch a layout the script cannot verify."
    }
}

# --- output helpers --------------------------------------------------------

function Write-Step {
    param([string]$Message)
    Write-Host "  $Message"
}

function Write-Plan {
    param([string]$Message)
    if ($WhatIf) {
        Write-Host "[WHATIF] $Message" -ForegroundColor Cyan
    }
    else {
        Write-Host "          $Message" -ForegroundColor DarkGray
    }
}

function Write-Failure {
    param([string]$Message)
    Write-Host "ERROR: $Message" -ForegroundColor Red
}

# --- preflight -------------------------------------------------------------

function Assert-Prerequisites {
    if (-not (Test-Path -LiteralPath $ProfilePath -PathType Container)) {
        throw "Profile directory not found: $ProfilePath"
    }
    if (-not (Test-Path -LiteralPath $PatchPath -PathType Leaf)) {
        throw "Patch file not found: $PatchPath (is this a DSH profile?)"
    }
    if (-not (Test-Path -LiteralPath $ModulesRoot -PathType Container)) {
        throw "Module directory not found: $ModulesRoot (run DSH once so the profile is assembled)"
    }
}

function Test-PluginSource {
    if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
        throw "Plugin source not found: $SourceDir"
    }
    foreach ($required in @('package.json', 'lib\index.js')) {
        $candidate = Join-Path $SourceDir $required
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "Plugin source is incomplete: missing $candidate"
        }
    }
}

# --- patch text analysis ---------------------------------------------------

function Get-EntryPattern {
    # Precise list-entry matcher (N1). Built as a Regex object because the
    # static [regex]::IsMatch/Matches overloads do not honour an inline `(?m)`.
    return New-Object System.Text.RegularExpressions.Regex(
        ('^[ \t]*-[ \t]+id:[ \t]*' + [regex]::Escape($PluginId) + '[ \t]*$'),
        [System.Text.RegularExpressions.RegexOptions]::Multiline)
}

function Test-PluginRegistered {
    # N1: only an actual list entry counts. A mention in a comment or a
    # different plugin's config is not a registration. CRLF is normalized
    # first: `[ \t]*$` would otherwise never match before a `\r`, so a real
    # registration in a CRLF patch file would be read as "not installed".
    param([string]$Text)
    return (Get-EntryPattern).IsMatch(($Text -replace "`r", ''))
}

function Test-TextReferencesPlugin {
    # Conservative rollback guard: ANY mention of the package name or plugin
    # id means the file may still wire this plugin. Rollback uses this (not
    # the precise entry matcher) because restoring a file that still points at
    # the package and then deleting the package blocks the next startup.
    param([string]$Text)
    $flat = ($Text -replace "`r", '')
    return ($flat.IndexOf($PackageName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -or
           ($flat.IndexOf($PluginId, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function New-EntryLines {
    # Two explicit strings, returned as an array. (A parenthesised
    # `(a) + (b), (c)` would bind as an array-of-one: `+` binds tighter than
    # the comma operator.)
    param([int]$ChildIndent, [int]$NameIndent)
    $idLine = (' ' * $ChildIndent) + '- id: ' + $PluginId
    $nameLine = (' ' * $NameIndent) + 'name: "' + $PackageName + '"'
    return @($idLine, $nameLine)
}

function Find-InsertAnchor {
    <#
      Locate the FIRST top-level `- insert:` line and decide how to insert the
      new entry as its FIRST child. Returns:
        @{ Index = -1; InsertIndent = 0; ChildIndent = 0; NameIndent = 0; Lines; TrailingNewline }
      with Index = -1 meaning "no usable anchor" (including an inline `[]`).

      The block end is never computed: the new lines go on Index + 1, which is
      valid YAML for a non-empty list, a block that starts with a comment, and
      a block that continues with sibling keys.
    #>
    param([string]$Text)

    $trailingNewline = $Text.EndsWith("`n")
    $body = $Text
    if ($trailingNewline) { $body = $body.Substring(0, $body.Length - 1) }
    $lines = $body.Split("`n")

    $insertIndex = -1
    $insertIndent = 0
    $inlineEmpty = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^([ ]*)-\s+insert:[ \t]*(#.*)?$') {
            $insertIndex = $i
            $insertIndent = $Matches[1].Length
            break
        }
        if ($lines[$i] -match '^[ ]*-\s+insert:[ \t]*\[\][ \t]*(#.*)?$') {
            $insertIndex = $i
            $insertIndent = 0
            $inlineEmpty = $true
            break
        }
    }
    if ($inlineEmpty) {
        return @{ Index = -2; InsertIndent = 0; ChildIndent = 0; NameIndent = 0; Lines = $lines; TrailingNewline = $trailingNewline }
    }
    if ($insertIndex -lt 0) {
        return @{ Index = -1; InsertIndent = 0; ChildIndent = 0; NameIndent = 0; Lines = $lines; TrailingNewline = $trailingNewline }
    }

    # Child indent: first list item deeper than the key, skipping blanks and
    # comment-only lines. If the list is empty (next significant line is no
    # deeper), fall back to key indent + 4.
    $childIndent = -1
    for ($j = $insertIndex + 1; $j -lt $lines.Count; $j++) {
        $line = $lines[$j]
        if ($line.Trim().Length -eq 0) { continue }
        if ($line -match '^[ ]*#') { continue }
        $indent = $line.Length - $line.TrimStart(' ').Length
        if ($indent -le $insertIndent) { break }
        if ($line -match '^([ ]*)-\s') {
            $childIndent = $Matches[1].Length
        }
        break
    }
    if ($childIndent -lt 0) {
        $childIndent = $insertIndent + 4
    }

    # Item key indent: always exactly two spaces past the list marker. Any
    # deeper indent is valid YAML, while scanning for a `name:` line can land
    # on a nested key (for example `config.name`) and then place this entry's
    # key at an indent that does not line up with its sibling keys.
    $nameIndent = $childIndent + 2

    return @{
        Index           = $insertIndex
        InsertIndent    = $insertIndent
        ChildIndent     = $childIndent
        NameIndent      = $nameIndent
        Lines           = $lines
        TrailingNewline = $trailingNewline
    }
}

function New-PatchText {
    <#
      Returns the candidate patch text with the entry inserted as the first
      child of the first `- insert:` list. Throws on any layout it cannot
      prove safe, so the caller never writes a broken file.
    #>
    param([string]$Text)

    if (Test-PluginRegistered -Text $Text) { return $null }

    $anchor = Find-InsertAnchor -Text $Text
    if ($anchor.Index -eq -2) {
        throw "The '- insert:' block in $PatchPath is an inline empty list ([]); insert the entry by hand."
    }
    if ($anchor.Index -lt 0) {
        throw "No top-level '- insert:' block found in $PatchPath. Refusing to guess; add the block by hand or fix the profile."
    }

    $lines = $anchor.Lines
    $entry = New-EntryLines -ChildIndent $anchor.ChildIndent -NameIndent $anchor.NameIndent

    # The entry goes on the line right after `- insert:`. When nothing follows,
    # that position is the end of the file and is simply appended.
    $insertAt = $anchor.Index + 1
    if ($insertAt -gt $lines.Count) { $insertAt = $lines.Count }

    # Rebuild the full line list: the two entry lines land at $insertAt and
    # every original line keeps its order and content.
    $updated = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -le $lines.Count; $i++) {
        if ($i -eq $insertAt) {
            foreach ($entryLine in $entry) {
                [void]$updated.Add([string]$entryLine)
            }
        }
        if ($i -lt $lines.Count) {
            [void]$updated.Add([string]$lines[$i])
        }
    }

    $newText = $updated -join "`n"
    if ($anchor.TrailingNewline) { $newText = $newText + "`n" }

    # Self-check: the edit is exactly an insertion of two lines.
    if ($updated.Count -ne ($lines.Count + 2)) {
        throw "Internal error: insertion changed the line count by $(($updated.Count - $lines.Count))."
    }
    $idPattern = Get-EntryPattern
    if ($idPattern.Matches($newText).Count -ne 1) {
        throw "Internal error: '$PluginId' must appear exactly once after insertion."
    }
    Assert-NoTab -Text $newText -What 'The candidate patch'

    return $newText
}

# --- backups ---------------------------------------------------------------

function Get-Backups {
    if (-not (Test-Path -LiteralPath $ProfilePath -PathType Container)) { return @() }
    $pattern = "$PatchFileName.bak.*"
    return @(
        Get-ChildItem -LiteralPath $ProfilePath -File -Filter $pattern -ErrorAction SilentlyContinue |
            Sort-Object -Property LastWriteTime, Name
    )
}

function Test-BackupSafe {
    # A backup is only usable as a rollback source when it exists and no
    # longer registers this plugin; otherwise restoring it keeps the very
    # reference that may block startup.
    param($File)
    if ($null -eq $File) { return $false }
    if (-not (Test-Path -LiteralPath $File.FullName -PathType Leaf)) { return $false }
    $text = Read-TextFile -Path $File.FullName
    return -not (Test-TextReferencesPlugin -Text $text)
}

function New-BackupStamp {
    # Second-resolution stamp plus a per-run suffix: two runs in the same
    # second must not overwrite each other's backup.
    $stamp = (Get-Date).ToString('yyyyMMddHHmmss') + '-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 8)
    $target = "$PatchPath.bak.$stamp"
    while (Test-Path -LiteralPath $target) {
        $stamp = (Get-Date).ToString('yyyyMMddHHmmss') + '-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 8)
        $target = "$PatchPath.bak.$stamp"
    }
    return $stamp
}

function Backup-PatchFile {
    param([string]$Stamp)
    $target = "$PatchPath.bak.$Stamp"
    Write-Plan "Backup $PatchFileName -> $(Split-Path -Leaf $target)"
    if (-not $WhatIf) {
        if (Test-Path -LiteralPath $target) {
            throw "Backup target already exists: $target"
        }
        [System.IO.File]::Copy($PatchPath, $target, $false)
    }
    return $target
}

function Remove-OldBackups {
    # N2: count the backups that actually exist now (the new one included).
    $existing = @(Get-Backups)
    $excess = $existing.Count - $MaxBackups
    if ($excess -le 0) { return }
    $victims = @($existing | Select-Object -First $excess)
    foreach ($victim in $victims) {
        Write-Plan "Prune old backup $($victim.Name)"
        if (-not $WhatIf) {
            Remove-Item -LiteralPath $victim.FullName -Force
        }
    }
}

# --- staging ---------------------------------------------------------------

function Get-StagingPath {
    param([string]$Suffix)
    return (Join-Path $ModulesRoot ('.' + $PackageLeaf + '.' + $Suffix + '.' + [System.Guid]::NewGuid().ToString('N')))
}

function Copy-TreeTo {
    # LiteralPath on both ends: a source path containing [ or ] must never be
    # interpreted as a wildcard.
    param([string]$Source, [string]$Target)
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    $items = @(Get-ChildItem -LiteralPath $Source -Force)
    foreach ($item in $items) {
        Copy-Item -LiteralPath $item.FullName -Destination $Target -Recurse -Force
    }
}

function Assert-StagingComplete {
    param([string]$StagingDir)
    $indexPath = Join-Path $StagingDir 'lib\index.js'
    $manifestPath = Join-Path $StagingDir 'package.json'
    if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
        throw "Staged copy is incomplete: missing lib\index.js in $StagingDir"
    }
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Staged copy is incomplete: missing package.json in $StagingDir"
    }
    $manifest = Read-TextFile -Path $manifestPath | ConvertFrom-Json
    if ($manifest.name -ne $PackageName) {
        throw "Staged package.json declares '$($manifest.name)', expected '$PackageName'."
    }
}

function Remove-PathIfExists {
    param([string]$Path)
    if ($Path -and (Test-Path -LiteralPath $Path)) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force
            return $null
        }
        catch {
            return $_.Exception.Message
        }
    }
    return $null
}

# --- installation ----------------------------------------------------------

function Invoke-Install {
    Write-Host 'Installing dsh-tool-session-title' -ForegroundColor Green
    Write-Step "Profile   : $ProfilePath"
    Write-Step "Source    : $SourceDir"
    Write-Step "Package   : $DestDir"
    if ($WhatIf) { Write-Host 'Mode      : WhatIf (no changes will be made)' -ForegroundColor Yellow }

    Assert-Prerequisites
    Test-PluginSource

    # 1. Read the patch and compute the candidate text. Nothing is written yet.
    $patchText = Read-TextFile -Path $PatchPath
    Assert-NoTab -Text $patchText -What $PatchFileName
    $registered = Test-PluginRegistered -Text $patchText
    $candidate = $null
    if ($registered) {
        Write-Step "cordis.patch.yml already contains $PluginId; the YAML edit will be skipped."
    }
    else {
        $candidate = New-PatchText -Text $patchText
    }

    $destExists = Test-Path -LiteralPath $DestDir -PathType Container
    $copyNeeded = (-not $destExists) -or $Force
    if (-not $copyNeeded) {
        Write-Step 'Package directory already exists; skipping copy (use -Force to refresh).'
    }

    if ($WhatIf) {
        if ($copyNeeded) {
            if ($destExists) { Write-Plan "Replace package directory $DestDir (staged swap)" }
            else { Write-Plan "Create package directory $DestDir (staged copy)" }
        }
        $writeNeeded = (-not $registered) -or $copyNeeded
        if ($writeNeeded) {
            Write-Plan "Backup $PatchFileName (newest $MaxBackups kept)"
        }
        if (-not $registered) {
            Write-Plan "Insert at the top of the '- insert:' list: $PluginId ($PackageName)"
        }
        Write-Host ''
        Write-Host 'WhatIf: no files were written.' -ForegroundColor Yellow
        return
    }

    # Re-running an already-complete install is a no-op: no copy, no backup,
    # no patch write. Only -Force (refresh) or a missing piece changes files.
    if ($registered -and -not $copyNeeded) {
        Write-Step 'Nothing to do: the plugin is already installed. Use -Force to refresh the package.'
        Write-Host ''
        Write-Host 'Installation complete (no changes).' -ForegroundColor Green
        Write-Host '  >>> RESTART DSH Desktop if you have not done so since the first install. <<<' -ForegroundColor Yellow
        return
    }

    # 2. Transaction: backup, stage, swap, patch. Any failure unwinds.
    $stamp = New-BackupStamp
    $script:activeStamp = $stamp
    $script:activeBackup = "$PatchPath.bak.$stamp"
    $staging = $null
    $oldDir = $null
    $activated = $false
    $patchWritten = $false

    try {
        # 2a. Backup first, always: the rollback path needs it even when no
        #     YAML change happens, and a copy failure must abort before any
        #     directory is touched.
        Backup-PatchFile -Stamp $stamp | Out-Null
        $backupText = Read-TextFile -Path $script:activeBackup
        if (-not [string]::Equals($backupText, $patchText, [System.StringComparison]::Ordinal)) {
            throw 'Backup verification failed: the backup does not byte-match the patch file.'
        }

        # 2b. Staged copy on the same volume.
        if ($copyNeeded) {
            $staging = Get-StagingPath -Suffix 'staging'
            Write-Plan "Stage $SourceDir -> $(Split-Path -Leaf $staging)"
            Copy-TreeTo -Source $SourceDir -Target $staging
            Assert-StagingComplete -StagingDir $staging
        }

        # 2c. Move the current package aside (kept until the very end).
        if ($copyNeeded -and $destExists) {
            $oldDir = Get-StagingPath -Suffix 'old'
            Write-Plan "Set aside $DestDir -> $(Split-Path -Leaf $oldDir)"
            Move-Item -LiteralPath $DestDir -Destination $oldDir
        }

        # 2d. Activate.
        if ($copyNeeded) {
            Write-Plan "Activate $DestDir"
            Move-Item -LiteralPath $staging -Destination $DestDir
            $staging = $null
            $activated = $true
        }

        # 2e. Commit the patch last.
        if (-not $registered) {
            Write-Plan "Insert at the top of the '- insert:' list: $PluginId ($PackageName)"
            Write-TextAtomic -Path $PatchPath -Text $candidate
            $patchWritten = $true
            $roundTrip = Read-TextFile -Path $PatchPath
            if (-not [string]::Equals($roundTrip, $candidate, [System.StringComparison]::Ordinal)) {
                throw 'Patch verification failed: the written file does not match the candidate text.'
            }
        }
        $script:activeStamp = $null
        $script:activeBackup = $null
    }
    catch {
        $failure = $_.Exception.Message
        Write-Host "Install failed: $failure" -ForegroundColor Red
        Write-Host 'Rolling back...' -ForegroundColor Yellow

        if ($patchWritten -or -not $registered) {
            if (Test-Path -LiteralPath $script:activeBackup -PathType Leaf) {
                [System.IO.File]::Copy($script:activeBackup, $PatchPath, $true)
                Write-Step "Restored $PatchFileName from $(Split-Path -Leaf $script:activeBackup)"
            }
        }
        if ($activated) {
            $discard = Remove-PathIfExists -Path $DestDir
            if ($discard) { Write-Step "Warning: could not remove $DestDir ($discard)" }
        }
        if ($oldDir -and (Test-Path -LiteralPath $oldDir)) {
            try {
                Move-Item -LiteralPath $oldDir -Destination $DestDir
                Write-Step "Restored the previous package directory"
                $oldDir = $null
            }
            catch {
                Write-Host "ERROR: could not restore $oldDir to $DestDir - move it back by hand." -ForegroundColor Red
            }
        }
        if ($staging) {
            $discardStaging = Remove-PathIfExists -Path $staging
            if ($discardStaging) { Write-Step "Warning: could not remove $staging ($discardStaging)" }
        }
        throw $failure
    }

    # 3. Cleanup after a successful commit.
    if ($oldDir) {
        $discardOld = Remove-PathIfExists -Path $oldDir
        if ($discardOld) { Write-Step "Warning: could not remove the old package copy $oldDir ($discardOld)" }
    }
    Remove-OldBackups

    Write-Host ''
    Write-Host 'Installation complete.' -ForegroundColor Green
    Write-Host ''
    Write-Host '  >>> RESTART DSH Desktop to activate the plugin. <<<' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  WARNING: this profile is managed by pnpm (nodeLinker: hoisted).' -ForegroundColor Red
    Write-Host '  Do NOT change the plugin list inside DSH after installing: a pnpm' -ForegroundColor Red
    Write-Host '  install can sweep away this hand-copied directory and the host will' -ForegroundColor Red
    Write-Host '  then fail to start. If you did change it, re-run this script.' -ForegroundColor Red
    Write-Host ''
    Write-Host '  If DSH fails to start, run: .\scripts\install.ps1 -Rollback'
}

# --- rollback --------------------------------------------------------------

function Invoke-Rollback {
    Write-Host 'Rolling back dsh-tool-session-title' -ForegroundColor Green
    Write-Step "Profile : $ProfilePath"
    if ($WhatIf) { Write-Host 'Mode    : WhatIf (no changes will be made)' -ForegroundColor Yellow }

    if (-not (Test-Path -LiteralPath $ProfilePath -PathType Container)) {
        throw "Profile directory not found: $ProfilePath"
    }

    # Pick the newest backup that no longer registers this plugin. Newer
    # backups that still mention it (e.g. taken after our own install) are
    # skipped, never restored, and never partially applied.
    $backups = @(Get-Backups)
    if ($backups.Count -eq 0) {
        Write-Failure "No backup found: no $PatchFileName.bak.* in $ProfilePath."
        Write-Failure 'Refusing to delete the package: the patch file may still register it.'
        Write-Host '  Nothing was changed. To remove the plugin by hand: delete the' -ForegroundColor Yellow
        Write-Host "  '$PluginId' entry from $PatchPath first, then remove $DestDir." -ForegroundColor Yellow
        throw 'Rollback refused: no backup available.'
    }

    $chosen = $null
    for ($i = $backups.Count - 1; $i -ge 0; $i--) {
        if (Test-BackupSafe -File $backups[$i]) { $chosen = $backups[$i]; break }
        Write-Step "Skipping backup that still references $PluginId : $($backups[$i].Name)"
    }
    if ($null -eq $chosen) {
        Write-Failure 'Every backup still registers this plugin, so restoring one would keep it enabled.'
        Write-Failure 'Refusing to delete the package. Nothing was changed.'
        throw 'Rollback refused: no backup is safe to restore.'
    }

    $restoreText = Read-TextFile -Path $chosen.FullName
    if (Test-TextReferencesPlugin -Text $restoreText) {
        throw "Refusing to restore $($chosen.Name): it still references $PackageName."
    }

    $destExists = Test-Path -LiteralPath $DestDir -PathType Container

    if (-not $WhatIf) {
        if ($destExists) {
            # A backup of the current patch file lets an interrupted rollback
            # be retried (or undone by hand).
            $safety = "$PatchPath.bak.pre-rollback-" + (Get-Date).ToString('yyyyMMddHHmmss') + '-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 8)
            [System.IO.File]::Copy($PatchPath, $safety, $false)
            Write-Step "Safety copy of the current patch: $(Split-Path -Leaf $safety)"
        }
    }

    Write-Plan "Restore $($chosen.Name) -> $PatchFileName"
    if (-not $WhatIf) {
        Write-TextAtomic -Path $PatchPath -Text $restoreText
        $restored = Read-TextFile -Path $PatchPath
        if (Test-TextReferencesPlugin -Text $restored) {
            throw "Restored patch still references $PackageName; not deleting the package."
        }
    }

    if ($destExists) {
        Write-Plan "Remove package directory $DestDir"
        if (-not $WhatIf) {
            # Rename out of the way first so a partially deleted directory is
            # never left behind at the path the profile loads from.
            $trash = Get-StagingPath -Suffix 'trash'
            Move-Item -LiteralPath $DestDir -Destination $trash
            $trashFailure = Remove-PathIfExists -Path $trash
            if ($trashFailure) {
                Move-Item -LiteralPath $trash -Destination $DestDir
                throw "Could not delete the package directory; it was restored in place. ($trashFailure)"
            }
        }
    }
    else {
        Write-Step 'Package directory is not present; nothing to remove.'
    }

    if ($WhatIf) {
        Write-Host ''
        Write-Host 'WhatIf: no files were written.' -ForegroundColor Yellow
        return
    }

    Write-Host ''
    Write-Host 'Rollback complete. Restart DSH Desktop to apply.' -ForegroundColor Green
}

# --- entry point -----------------------------------------------------------

try {
    if ($Rollback) {
        Invoke-Rollback
    }
    else {
        Invoke-Install
    }
}
catch {
    Write-Failure $_.Exception.Message
    exit 1
}
