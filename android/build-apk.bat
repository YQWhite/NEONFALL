@echo off
rem Use an isolated Gradle cache; preserve a caller-supplied JDK and SDK.
setlocal
if not defined JAVA_HOME if exist "C:\Program Files\Android\Android Studio\jbr\bin\java.exe" set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
if not defined ANDROID_HOME set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "GRADLE_USER_HOME=%~dp0..\.gradle-home"
cd /d "%~dp0"
call gradlew.bat %*
set "NF_BUILD_EXIT=%ERRORLEVEL%"
endlocal & exit /b %NF_BUILD_EXIT%
