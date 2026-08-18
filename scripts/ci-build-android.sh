#!/usr/bin/env bash
set -euo pipefail

version="${KIOSK_VERSION:-dev}"
artifact_dir="${CI_PROJECT_DIR:-$(pwd)}/artifacts/android"
mkdir -p "$artifact_dir"

npm run android:sync
(
  cd android
  ./gradlew --no-daemon assembleDebug
)
cp android/app/build/outputs/apk/debug/app-debug.apk "$artifact_dir/BB-Kiosk-${version}-debug.apk"

npm run build:waiter
(
  cd waiter
  if [[ ! -d android ]]; then ../node_modules/.bin/cap add android; fi
  cp google-services.json android/app/google-services.json
  ../node_modules/.bin/cap sync android
  node ../scripts/configure-waiter-android.mjs
  cd android
  ./gradlew --no-daemon assembleDebug
)
cp waiter/android/app/build/outputs/apk/debug/app-debug.apk "$artifact_dir/BB-Waiter-${version}-debug.apk"

signing_variables=(
  ANDROID_KEYSTORE_PATH
  ANDROID_KEYSTORE_PASSWORD
  ANDROID_KEY_ALIAS
  ANDROID_KEY_PASSWORD
)
release_ready=true
for variable_name in "${signing_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then release_ready=false; fi
done

if "$release_ready"; then
  test -f "$ANDROID_KEYSTORE_PATH"
  (
    cd android
    ./gradlew --no-daemon assembleRelease
  )
  (
    cd waiter/android
    ./gradlew --no-daemon assembleRelease
  )
  cp android/app/build/outputs/apk/release/app-release.apk "$artifact_dir/BB-Kiosk-${version}.apk"
  cp waiter/android/app/build/outputs/apk/release/app-release.apk "$artifact_dir/BB-Waiter-${version}.apk"
  apksigner verify --verbose "$artifact_dir/BB-Kiosk-${version}.apk"
  apksigner verify --verbose "$artifact_dir/BB-Waiter-${version}.apk"
else
  echo 'Protected Android signing variables are absent; release APK files were not created.'
fi
