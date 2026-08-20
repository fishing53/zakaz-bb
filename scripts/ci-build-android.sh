#!/usr/bin/env bash
set -euo pipefail

version="${KIOSK_VERSION:-dev}"
artifact_dir="${CI_PROJECT_DIR:-$(pwd)}/artifacts/android"
mkdir -p "$artifact_dir"
export ANDROID_VERSION_CODE="${ANDROID_VERSION_CODE:-${CI_PIPELINE_IID:-1}}"

use_ci_gradle_distribution() {
  local wrapper_properties="$1"
  if [[ -n "${CI_GRADLE_DISTRIBUTION_FILE:-}" ]]; then
    test -s "$CI_GRADLE_DISTRIBUTION_FILE"
    sed -i "s#^distributionUrl=.*#distributionUrl=file\\\://${CI_GRADLE_DISTRIBUTION_FILE}#" "$wrapper_properties"
  fi
}

npm run android:sync
use_ci_gradle_distribution android/gradle/wrapper/gradle-wrapper.properties
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
  use_ci_gradle_distribution android/gradle/wrapper/gradle-wrapper.properties
  cd android
  ./gradlew --no-daemon assembleDebug
)
cp waiter/android/app/build/outputs/apk/debug/app-debug.apk "$artifact_dir/BB-Waiter-${version}-debug.apk"

if [[ -s /bb-ci-secrets/android-signing.env ]]; then
  # Dedicated runner fallback. GitLab file variables remain the preferred setup.
  source /bb-ci-secrets/android-signing.env
fi

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
  cp android/app/build/outputs/apk/release/app-release.apk "$artifact_dir/BB-Kiosk-latest.apk"
  cp waiter/android/app/build/outputs/apk/release/app-release.apk "$artifact_dir/BB-Waiter-${version}.apk"
  cp waiter/android/app/build/outputs/apk/release/app-release.apk "$artifact_dir/BB-Waiter-latest.apk"
  apksigner_bin="$(command -v apksigner || find "${ANDROID_HOME:-/opt/android-sdk-linux}/build-tools" -type f -name apksigner -perm -u+x | sort -V | tail -n 1)"
  test -x "$apksigner_bin"
  "$apksigner_bin" verify --verbose "$artifact_dir/BB-Kiosk-${version}.apk"
  "$apksigner_bin" verify --verbose "$artifact_dir/BB-Kiosk-latest.apk"
  "$apksigner_bin" verify --verbose "$artifact_dir/BB-Waiter-${version}.apk"
  "$apksigner_bin" verify --verbose "$artifact_dir/BB-Waiter-latest.apk"
else
  echo 'Protected Android signing variables are absent; release APK files were not created.'
  exit 1
fi
