import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const android = resolve(root, 'waiter/android');
const manifestPath = resolve(android, 'app/src/main/AndroidManifest.xml');
const javaDestination = resolve(android, 'app/src/main/java/ru/zvyak/brooklynbowl/waiter/WaiterFirebaseMessagingService.java');
let manifest = await readFile(manifestPath, 'utf8');
for (const permission of ['android.permission.POST_NOTIFICATIONS', 'android.permission.USE_FULL_SCREEN_INTENT', 'android.permission.VIBRATE']) {
  if (!manifest.includes(permission)) manifest = manifest.replace('<application', `    <uses-permission android:name="${permission}" />\n\n    <application`);
}
const service = `        <service android:name=".WaiterFirebaseMessagingService" android:exported="false">\n            <intent-filter>\n                <action android:name="com.google.firebase.MESSAGING_EVENT" />\n            </intent-filter>\n        </service>\n`;
if (!manifest.includes('WaiterFirebaseMessagingService')) manifest = manifest.replace('</application>', `${service}    </application>`);
await writeFile(manifestPath, manifest);
await mkdir(dirname(javaDestination), { recursive: true });
await cp(resolve(root, 'waiter/android-template/WaiterFirebaseMessagingService.java'), javaDestination);
