import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const android = resolve(root, 'waiter/android');
const manifestPath = resolve(android, 'app/src/main/AndroidManifest.xml');
const gradlePath = resolve(android, 'app/build.gradle');
const wrapperPath = resolve(android, 'gradle/wrapper/gradle-wrapper.properties');
const javaDestination = resolve(android, 'app/src/main/java/ru/zvyak/brooklynbowl/waiter/WaiterFirebaseMessagingService.java');
const kioskResources = resolve(root, 'android/app/src/main/res');
const waiterResources = resolve(android, 'app/src/main/res');

const launcherAssets = [
  ...['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'].flatMap((density) => [
    `mipmap-${density}/ic_launcher.png`,
    `mipmap-${density}/ic_launcher_round.png`,
    `mipmap-${density}/ic_launcher_foreground.png`,
  ]),
  'mipmap-anydpi-v26/ic_launcher.xml',
  'mipmap-anydpi-v26/ic_launcher_round.xml',
  'drawable/ic_launcher_background.xml',
  'drawable-v24/ic_launcher_foreground.xml',
  'values/ic_launcher_background.xml',
];

for (const asset of launcherAssets) {
  const destination = resolve(waiterResources, asset);
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(kioskResources, asset), destination, { force: true });
}

let manifest = await readFile(manifestPath, 'utf8');
for (const permission of ['android.permission.POST_NOTIFICATIONS', 'android.permission.USE_FULL_SCREEN_INTENT', 'android.permission.VIBRATE']) {
  if (!manifest.includes(permission)) manifest = manifest.replace('<application', `    <uses-permission android:name="${permission}" />\n\n    <application`);
}
const service = `        <service android:name=".WaiterFirebaseMessagingService" android:exported="false">\n            <intent-filter>\n                <action android:name="com.google.firebase.MESSAGING_EVENT" />\n            </intent-filter>\n        </service>\n`;
if (!manifest.includes('WaiterFirebaseMessagingService')) manifest = manifest.replace('</application>', `${service}    </application>`);
await writeFile(manifestPath, manifest);
await mkdir(dirname(javaDestination), { recursive: true });
await cp(resolve(root, 'waiter/android-template/WaiterFirebaseMessagingService.java'), javaDestination);
let gradle = await readFile(gradlePath, 'utf8');
if (!gradle.includes('firebase-messaging')) {
  gradle += "\n// Required by the native urgent waiter notification service.\ndependencies { implementation 'com.google.firebase:firebase-messaging:24.1.2' }\n";
}
if (!gradle.includes('ANDROID_KEYSTORE_PATH')) {
  gradle += `
// A release is signed only when protected CI variables provide a permanent key.
def waiterReleaseKeystorePath = System.getenv('ANDROID_KEYSTORE_PATH')
if (waiterReleaseKeystorePath) {
    android {
        signingConfigs {
            release {
                storeFile file(waiterReleaseKeystorePath)
                storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')
                keyAlias System.getenv('ANDROID_KEY_ALIAS')
                keyPassword System.getenv('ANDROID_KEY_PASSWORD')
            }
        }
        buildTypes.release.signingConfig signingConfigs.release
    }
}
`;
}
await writeFile(gradlePath, gradle);

let wrapper = await readFile(wrapperPath, 'utf8');
wrapper = wrapper
  .replace(/-all\.zip/g, '-bin.zip')
  .replace(/^networkTimeout=.*$/m, 'networkTimeout=120000');
await writeFile(wrapperPath, wrapper);
