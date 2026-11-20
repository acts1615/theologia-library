#!/usr/bin/env bash
# `npx cap add android` 로 만들어진 안드로이드 프로젝트에 우리 플러그인과 설정을 넣는다.
set -euo pipefail
cd "$(dirname "$0")/.."
PKG_DIR=android/app/src/main/java/kr/goodsoldier/theologia/mobile
mkdir -p "$PKG_DIR"
cp android-src/FolderPlugin.java "$PKG_DIR/FolderPlugin.java"
cp android-src/MainActivity.java "$PKG_DIR/MainActivity.java"
# 앱 이름·버전
VER=$(node -p "require('./package.json').version")
CODE=$(node -p "const v=require('./package.json').version.split('.').map(Number); v[0]*10000+v[1]*100+v[2]")
sed -i "s/versionName \".*\"/versionName \"$VER\"/; s/versionCode [0-9]*/versionCode $CODE/" android/app/build.gradle
grep -n "versionName\|versionCode" android/app/build.gradle || true
ls "$PKG_DIR"
