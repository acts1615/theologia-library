#!/usr/bin/env bash
# `npx cap add android` 로 만들어진 안드로이드 프로젝트에 우리 플러그인과 설정을 넣는다.
set -euo pipefail
cd "$(dirname "$0")/.."
PKG_DIR=android/app/src/main/java/kr/goodsoldier/theologia/mobile
mkdir -p "$PKG_DIR"
cp android-src/FolderPlugin.java "$PKG_DIR/FolderPlugin.java"
cp android-src/MainActivity.java "$PKG_DIR/MainActivity.java"
cp android-src/UpdaterPlugin.java "$PKG_DIR/UpdaterPlugin.java"
# 서명: 매번 같은 키로 서명해야 새 APK를 지우지 않고 덮어 설치할 수 있다 (시험판용 공개 키)
cp android-src/debug.keystore android/app/debug.keystore
sed -i '0,/^android {/s//android {\n    signingConfigs {\n        debug {\n            storeFile file("debug.keystore")\n            storePassword "android"\n            keyAlias "androiddebugkey"\n            keyPassword "android"\n        }\n    }/' android/app/build.gradle
grep -n -A8 "signingConfigs" android/app/build.gradle | head -12 || true
# 앱 안 업데이트: 설치 화면을 띄우는 권한
MANI=android/app/src/main/AndroidManifest.xml
grep -q REQUEST_INSTALL_PACKAGES "$MANI" || sed -i 's#<uses-permission android:name="android.permission.INTERNET" />#<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />#' "$MANI"
grep -n "uses-permission" "$MANI"
# 앱 이름·버전
VER=$(node -p "require('./package.json').version")
CODE=$(node -p "const v=require('./package.json').version.split('.').map(Number); v[0]*10000+v[1]*100+v[2]")
sed -i "s/versionName \".*\"/versionName \"$VER\"/; s/versionCode [0-9]*/versionCode $CODE/" android/app/build.gradle
grep -n "versionName\|versionCode" android/app/build.gradle || true
ls "$PKG_DIR"
