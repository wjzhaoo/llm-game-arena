# Extract installed app icons without changing their installation or shortcuts.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$assetDirectory = Join-Path $workspace 'public/assets/avatars'
$extractionDate = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, 'China Standard Time').ToString('yyyy-MM-dd')
$temporaryDirectory = Join-Path $workspace ('tmp/avatar-import-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
$env:TEMP = $temporaryDirectory
$env:TMP = $temporaryDirectory
try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ArenaInstalledIcon {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHDefExtractIcon(string file, int index, uint flags, out IntPtr large, out IntPtr small, uint size);
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr icon);
    public static IntPtr Load(string source, int index) {
        IntPtr large = IntPtr.Zero, small = IntPtr.Zero;
        try {
            int result = SHDefExtractIcon(source, index, 0, out large, out small, (32u << 16) | 256u);
            if (result != 0 || large == IntPtr.Zero) throw new Exception("No application icon: " + source);
            return large;
        } catch {
            if (large != IntPtr.Zero) DestroyIcon(large);
            throw;
        } finally {
            if (small != IntPtr.Zero) DestroyIcon(small);
        }
    }
}
'@
    $definitions = @(
        @{ key='codearts'; label='CodeArts'; names=@('CodeArts Agent'); initials='CA' },
        @{ key='mimo'; label='MiMo'; names=@('Xiaomi MiMo'); initials='MM' },
        @{ key='opencode'; label='OpenCode'; names=@('OpenCode'); initials='OC' },
        @{ key='qoder'; label='Qoder'; names=@('Qoder CN','Qoder'); initials='QD' },
        @{ key='antigravity'; label='Antigravity'; names=@('Antigravity'); initials='AG' },
        @{ key='catpaw'; label='妙手 / CatPaw'; names=@('妙手','CatPaw'); initials='CP' },
        @{ key='minimax'; label='MiniMax Code'; names=@('MiniMax Code'); initials='MX' },
        @{ key='trae'; label='TRAE SOLO CN'; names=@('TRAE SOLO CN - 快捷方式','TRAE SOLO CN','TRAE'); initials='TR' },
        @{ key='kimi'; label='Kimi Code'; names=@('Kimi Code'); initials='KM' },
        @{ key='workbuddy'; label='WorkBuddy'; names=@('WorkBuddy'); initials='WB' },
        @{ key='workbuddy-ai'; label='WorkBuddy AI'; names=@('WorkBuddy AI'); initials='WA' },
        @{ key='zcode'; label='ZCode'; names=@('ZCode'); initials='ZC' },
        @{ key='cursor'; label='Cursor'; names=@('Cursor'); initials='CU' },
        @{ key='vscode'; label='Visual Studio Code'; names=@('Visual Studio Code'); initials='VS' }
    )
    $shortcutRoots = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('CommonDesktopDirectory'),
        [Environment]::GetFolderPath('Programs'),
        [Environment]::GetFolderPath('CommonPrograms')
    )
    $shell = New-Object -ComObject WScript.Shell
    $shortcuts = @(Get-ChildItem -LiteralPath $shortcutRoots -Recurse -Filter '*.lnk' -File -ErrorAction SilentlyContinue)
    $sources = @()
    foreach ($definition in $definitions) {
        $link = $shortcuts | Where-Object { $definition.names -contains $_.BaseName -and (Test-Path -LiteralPath $shell.CreateShortcut($_.FullName).TargetPath -PathType Leaf) } | Select-Object -First 1
        if (!$link) { continue }
        $shortcut = $shell.CreateShortcut($link.FullName)
        $source = $shortcut.TargetPath
        $index = 0
        if ($shortcut.IconLocation -match '^(.+),(-?\d+)$') {
            $explicit = [Environment]::ExpandEnvironmentVariables($Matches[1].Trim('"'))
            if (Test-Path -LiteralPath $explicit -PathType Leaf) {
                $source = $explicit
                $index = [int]$Matches[2]
            }
        }
        if (!(Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        $sources += [pscustomobject]@{ definition=$definition; source=$source; index=$index }
    }
    $codexPackage = Get-AppxPackage 'OpenAI.Codex' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($codexPackage) {
        $codexIcon = Join-Path $codexPackage.InstallLocation 'assets/Square44x44Logo.targetsize-256_altform-lightunplated.png'
        if (Test-Path -LiteralPath $codexIcon -PathType Leaf) {
            $sources += [pscustomobject]@{ definition=@{key='codex'; label='Codex'; initials='CX'}; source=$codexIcon; index=0 }
        }
    }
    $manifestPath = Join-Path $assetDirectory 'manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($entry in $sources) {
        $definition = $entry.definition
        $filename = $definition.key + '.png'
        $destination = Join-Path $assetDirectory $filename
        if ([IO.Path]::GetExtension($entry.source) -eq '.png') {
            Copy-Item -LiteralPath $entry.source -Destination $destination
        } else {
            $iconHandle = [ArenaInstalledIcon]::Load($entry.source, $entry.index)
            $icon = $null
            $bitmap = $null
            try {
                $icon = [Drawing.Icon]::FromHandle($iconHandle)
                $bitmap = $icon.ToBitmap()
                $bitmap.Save($destination, [Drawing.Imaging.ImageFormat]::Png)
            } finally {
                if ($bitmap) { $bitmap.Dispose() }
                if ($icon) { $icon.Dispose() }
                [ArenaInstalledIcon]::DestroyIcon($iconHandle) | Out-Null
            }
        }
        if ((Get-Item -LiteralPath $destination).Length -ge 1MB) { throw 'Avatar exceeds 1 MB' }
        $info = [ordered]@{
            label=$definition.label
            src='/assets/avatars/' + $filename
            asset='assets/avatars/' + $filename
            kind='installed-application-icon'
            initials=$definition.initials
            source='installed-application:' + [IO.Path]::GetFileName($entry.source)
            sourceFileName=[IO.Path]::GetFileName($entry.source)
            sourceIconIndex=$entry.index
            extractedAt=$extractionDate
            license='Application icon belongs to its respective publisher; extracted from the user-installed application for provider identification.'
            trademarkNote='Used to identify the connected provider. No affiliation or endorsement is implied.'
            changes=$(if ([IO.Path]::GetExtension($entry.source) -eq '.png') {'Copied the installed Windows app package 256 px PNG icon unchanged.'} else {'Extracted the 256 px Windows icon resource as PNG; original geometry and colors retained.'})
            sha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        $manifest.providers | Add-Member -NotePropertyName $definition.key -NotePropertyValue $info -Force
        Write-Output ($definition.label + ' -> ' + $filename)
    }
    $aliases = @{
        'codeartsdoer'='codearts'; 'codearts-agent'='codearts'; 'codearts agent'='codearts'
        'xiaomi-mimo'='mimo'; 'xiaomi mimo'='mimo'
        'minimax-code'='minimax'; 'minimaxcode'='minimax'; 'minimax code'='minimax'
        'kimi-code'='kimi'; 'kimi code'='kimi'
        'trae-solo-cn'='trae'; 'trae solo cn'='trae'; 'trae-cn'='trae'; 'trae-solo'='trae'
        'workbuddyai'='workbuddy-ai'; 'workbuddy ai'='workbuddy-ai'
        'miaoshou'='catpaw'; 'cat-paw'='catpaw'
    }
    foreach ($alias in $aliases.Keys) { $manifest.aliases | Add-Member -NotePropertyName $alias -NotePropertyValue $aliases[$alias] -Force }
    $manifest.reviewedAt = $extractionDate
    $manifest.notice = 'Available installed application icons were extracted from this computer at the user request. Providers without a local icon retain their existing vector fallback. Icons and trademarks belong to their respective publishers; no affiliation or endorsement is implied. Existing repository logo licenses remain bundled for the retained SVG assets.'
    $manifest.security = 'All avatar URLs are fixed local SVG or PNG paths. PNGs contain raster pixels only. Retained SVGs contain static vector/text elements without active content or external resources.'
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 12) + "`n", [Text.UTF8Encoding]::new($false))
} finally {
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
    $resolvedTemporary = [IO.Path]::GetFullPath($temporaryDirectory)
    $temporaryRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'tmp')) + [IO.Path]::DirectorySeparatorChar
    if (!$resolvedTemporary.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe temporary cleanup path' }
    Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
}
