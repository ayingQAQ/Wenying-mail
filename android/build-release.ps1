$ErrorActionPreference='Stop'
Push-Location $PSScriptRoot
try {
 if (!(Test-Path -LiteralPath '.local/signing.properties') -or !(Test-Path -LiteralPath '.local/wengying-mail.jks')) { throw '缺少原发布签名。请恢复 .local 下的签名文件；勿为已有安装包重新生成不同签名。' }
 & .\gradlew.bat --no-daemon testReleaseUnitTest lintRelease assembleRelease
 if ($LASTEXITCODE -ne 0) { throw '构建或检查失败。' }
 if (!$env:ANDROID_HOME) { throw '请设置 ANDROID_HOME 后验证 APK。' }
 & "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat" verify --verbose app/build/outputs/apk/release/app-release.apk
 if ($LASTEXITCODE -ne 0) { throw '签名验证失败。' }
 New-Item -ItemType Directory -Force artifacts | Out-Null
 $metadata=Get-Content app/build/outputs/apk/release/output-metadata.json -Raw | ConvertFrom-Json
 $version=$metadata.elements[0].versionName
 $target="artifacts/Wengying-Mail-$version.apk"
 Copy-Item -LiteralPath app/build/outputs/apk/release/app-release.apk -Destination $target -Force
 $digest=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
 "$digest  Wengying-Mail-$version.apk" | Set-Content -LiteralPath "$target.sha256" -Encoding ascii
 Get-Item -LiteralPath $target | Select-Object FullName,Length
} finally { Pop-Location }
