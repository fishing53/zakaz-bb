import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ru.zvyak.zakaz',
  appName: 'Заказ Звяк',
  webDir: 'dist',
  plugins: {
    CapacitorUpdater: {
      autoUpdate: 'onLaunch',
      updateUrl: 'https://xn--80aatcn.xn--b1ajk7f.xn--p1ai/ota/manifest.json',
      appReadyTimeout: 15_000,
      responseTimeout: 10,
      autoDeleteFailed: true,
      autoDeletePrevious: false,
      resetWhenUpdate: false,
    },
  },
};

export default config;
