import './styles/index.css';
import { startApp } from './app';
import { appStore } from './store/app-store';

if ('serviceWorker' in navigator) window.addEventListener('load', async () => {
  const registration = await navigator.serviceWorker.register('./service-worker.js');
  registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', () => {
    if (registration.installing?.state === 'installed' && navigator.serviceWorker.controller) appStore.set({ pwaUpdateReady: true });
  }));
});
startApp();
