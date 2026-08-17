import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ru.zvyak.brooklynbowl.waiter',
  appName: 'BrooklynBowl Waiter',
  webDir: '../dist-waiter',
  server: { androidScheme: 'https' },
  android: { backgroundColor: '#0b0b0b', allowMixedContent: false },
  plugins: {
    CapacitorUpdater: {
      autoUpdate: false,
      updateUrl: 'https://xn--80aatcn.xn--b1ajk7f.xn--p1ai/api/v1/ota/waiter/update',
      appReadyTimeout: 15_000,
      responseTimeout: 10,
      autoDeleteFailed: true,
      autoDeletePrevious: false,
      resetWhenUpdate: false,
    },
  },
};

export default config;
