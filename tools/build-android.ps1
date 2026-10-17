param([switch]$Online, [string]$JavaHome)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$previousJavaHome = $env:JAVA_HOME
Push-Location $projectRoot
try {
    # Capacitor 8 requires Java 21; Gradle 8.13 cannot run under Java 25.
    # Select only for this process, preserving the user's global JAVA_HOME.
    $candidates = @($JavaHome, $env:JAVA_HOME, 'C:\Program Files\Android\Android Studio\jbr', 'C:\Program Files\Zulu\zulu-21')
    $selectedJava = $null
    foreach ($candidate in $candidates) {
        if (-not $candidate) { continue }
        $releaseFile = Join-Path $candidate 'release'
        if (-not (Test-Path -LiteralPath $releaseFile)) { continue }
        $version = Get-Content -LiteralPath $releaseFile -Raw
        if ($version -match 'JAVA_VERSION="(21|22|23)(?:\.|\")' -and (Test-Path -LiteralPath (Join-Path $candidate 'bin\java.exe'))) { $selectedJava = $candidate; break }
    }
    if (-not $selectedJava) { throw 'A JDK 21-23 is required. Pass -JavaHome <JDK directory>.' }
    $env:JAVA_HOME = $selectedJava
    # Always rebuild: cap sync alone happily packages an old dist/index.html.
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
    & node (Join-Path $projectRoot 'node_modules\@capacitor\cli\bin\capacitor') sync android
    if ($LASTEXITCODE -ne 0) { throw 'Capacitor sync failed' }
    & node (Join-Path $projectRoot 'tools\prepare-android-assets.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Bundled Android assets failed' }
    $gradleArgs = @('assembleDebug', '--console=plain', '--no-daemon')
    if (-not $Online) { $gradleArgs += '--offline' }
    & (Join-Path $projectRoot 'android\build-apk.bat') @gradleArgs
    if ($LASTEXITCODE -ne 0) { throw 'Android build failed' }
    $apk = Join-Path $projectRoot 'android\app\build\outputs\apk\debug\app-debug.apk'
    $releaseRoot = Join-Path $projectRoot 'release'
    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
    Copy-Item -LiteralPath $apk -Destination (Join-Path $releaseRoot 'NEONFALL-debug.apk') -Force
    # Keep the familiar install path current as well, so users cannot pick an old APK.
    $oldAlias = Join-Path $releaseRoot 'NEONFALL.apk'
    if (Test-Path -LiteralPath $oldAlias) {
        $backupRoot = Join-Path $projectRoot 'test-results\previous-apk'
        New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
        $oldHash = (Get-FileHash -LiteralPath $oldAlias -Algorithm SHA256).Hash
        $backup = Join-Path $backupRoot ($oldHash + '.apk')
        if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $oldAlias -Destination $backup }
    }
    Copy-Item -LiteralPath $apk -Destination (Join-Path $releaseRoot 'NEONFALL.apk') -Force
    & node (Join-Path $projectRoot 'tools\verify-android.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'APK contents differ from the current Web build' }
    Get-Item -LiteralPath (Join-Path $releaseRoot 'NEONFALL-debug.apk') | Select-Object FullName, Length, LastWriteTime
    Get-FileHash -LiteralPath (Join-Path $releaseRoot 'NEONFALL-debug.apk') -Algorithm SHA256
} finally {
    $env:JAVA_HOME = $previousJavaHome
    Pop-Location
}
