import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ru.zvyak.brooklynbowl.waiter',
  appName: 'BrooklynBowl Waiter',
  webDir: '../dist-waiter',
  server: { androidScheme: 'https' },
  android: { backgroundColor: '#0b0b0b', allowMixedContent: false },
};

export default config;
