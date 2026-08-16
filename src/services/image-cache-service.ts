import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { storage } from './storage';

type CacheEntry = { source: string; path: string; fileUri?: string; size: number; cachedAt: string };
type CacheManifest = { entries: Record<string, CacheEntry>; autoUpdate: boolean; lastSync: string | null };

export type ImageCacheState = {
  phase: 'idle' | 'scanning' | 'downloading' | 'clearing' | 'ready' | 'error';
  total: number;
  cached: number;
  bytes: number;
  completed: number;
  pending: number;
  failed: number;
  current: string;
  autoUpdate: boolean;
  lastSync: string | null;
  native: boolean;
};

const CACHE_KEY = 'bb-image-cache-v1';
const WEB_CACHE = 'brooklyn-images-v1';
let manifest = storage.get<CacheManifest>(CACHE_KEY, { entries: {}, autoUpdate: false, lastSync: null });
let running = false;
const runtimeUrls = new Map<string, string>();

const persist = () => storage.set(CACHE_KEY, manifest);
const revokeRuntimeUrl = (source: string) => {
  const value = runtimeUrls.get(source);
  if (value) URL.revokeObjectURL(value);
  runtimeUrls.delete(source);
};
const loadRuntimeUrl = async (source: string) => {
  if (!('caches' in window)) return false;
  const response = await caches.open(WEB_CACHE).then((cache) => cache.match(source));
  if (!response) return false;
  const blob = await response.blob();
  if (!blob.size) return false;
  revokeRuntimeUrl(source);
  runtimeUrls.set(source, URL.createObjectURL(blob));
  return true;
};
const uniqueSources = (sources: string[]) => [...new Set(sources.filter((source) => /^https?:\/\//i.test(source)))];
const extension = (source: string) => {
  try {
    const match = new URL(source).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return match && ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif'].includes(match[1].toLowerCase()) ? `.${match[1].toLowerCase()}` : '.img';
  } catch { return '.img'; }
};
const keyFor = async (source: string) => {
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('').slice(0, 32);
};
const removeEntryFile = async (entry: CacheEntry) => {
  revokeRuntimeUrl(entry.source);
  if (entry.fileUri && Capacitor.isNativePlatform()) await Filesystem.deleteFile({ path: entry.path, directory: Directory.Data }).catch(() => undefined);
  if ('caches' in window) await caches.open(WEB_CACHE).then((cache) => cache.delete(entry.source)).catch(() => undefined);
};

async function cacheInBrowser(source: string, path: string): Promise<CacheEntry> {
  if (!('caches' in window)) throw new Error('Хранилище изображений недоступно');
  const cache = await caches.open(WEB_CACHE);
  if (Capacitor.isNativePlatform()) {
    const result = await CapacitorHttp.get({ url: source, responseType: 'arraybuffer', connectTimeout: 15_000, readTimeout: 30_000 });
    if (result.status < 200 || result.status >= 300) throw new Error(`Не удалось загрузить изображение (${result.status})`);
    const encoded = String(result.data ?? '').replace(/^data:[^;]+;base64,/, '');
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    await cache.put(source, new Response(bytes, { headers: { 'Content-Type': result.headers['content-type'] || 'application/octet-stream', 'Content-Length': String(bytes.byteLength) } }));
    return { source, path, size: bytes.byteLength, cachedAt: new Date().toISOString() };
  }
  let response: Response;
  try { response = await fetch(source, { cache: 'no-store' }); }
  catch { response = await fetch(new Request(source, { mode: 'no-cors', cache: 'no-store' })); }
  if (!response.ok || response.type === 'opaque') throw new Error(`Не удалось загрузить изображение (${response.status || 'нет доступа'})`);
  await cache.put(source, response.clone());
  const size = Number(response.headers.get('content-length') || 0);
  return { source, path, size, cachedAt: new Date().toISOString() };
}

async function cacheOne(source: string, force: boolean) {
  const existing = manifest.entries[source];
  if (existing && !force) return existing;
  const path = `image-cache/${await keyFor(source)}${extension(source)}`;
  if (Capacitor.isNativePlatform()) {
    try {
      const temporaryPath = `${path}.download`;
      await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data }).catch(() => undefined);
      await Filesystem.downloadFile({ url: source, path: temporaryPath, directory: Directory.Data, recursive: true });
      if (existing) await removeEntryFile(existing);
      await Filesystem.rename({ from: temporaryPath, to: path, directory: Directory.Data });
      const file = await Filesystem.stat({ path, directory: Directory.Data });
      return { source, path, fileUri: file.uri, size: Number(file.size || 0), cachedAt: new Date().toISOString() } satisfies CacheEntry;
    } catch {
      // Existing APKs do not yet contain the native filesystem plugin. Cache
      // Storage keeps the feature operational until the next APK installation.
      return cacheInBrowser(source, path);
    }
  }
  return cacheInBrowser(source, path);
}

function stateFor(sources: string[], patch: Partial<ImageCacheState> = {}): ImageCacheState {
  const unique = uniqueSources(sources);
  const cachedEntries = unique.map((source) => manifest.entries[source]).filter((entry): entry is CacheEntry => Boolean(entry));
  return {
    phase: 'idle', total: unique.length, cached: cachedEntries.length,
    bytes: cachedEntries.reduce((sum, entry) => sum + Number(entry.size || 0), 0),
    completed: 0, pending: Math.max(0, unique.length - cachedEntries.length), failed: 0, current: '',
    autoUpdate: manifest.autoUpdate, lastSync: manifest.lastSync, native: Capacitor.isNativePlatform(), ...patch,
  };
}

export const imageCacheService = {
  async init() {
    await Promise.all(Object.values(manifest.entries).filter((entry) => !entry.fileUri).map(async (entry) => {
      const available = await loadRuntimeUrl(entry.source).catch(() => false);
      if (!available) delete manifest.entries[entry.source];
    }));
    persist();
  },
  resolve(source: string) {
    const entry = manifest.entries[source];
    if (entry?.fileUri && Capacitor.isNativePlatform()) return Capacitor.convertFileSrc(entry.fileUri);
    return runtimeUrls.get(source) ?? source;
  },
  state: stateFor,
  isRunning: () => running,
  setAutoUpdate(value: boolean) { manifest.autoUpdate = value; persist(); },
  autoUpdate: () => manifest.autoUpdate,

  async sync(sources: string[], options: { force?: boolean; onState?: (state: ImageCacheState) => void } = {}) {
    if (running) return stateFor(sources);
    running = true;
    const unique = uniqueSources(sources);
    const onState = options.onState ?? (() => undefined);
    onState(stateFor(unique, { phase: 'scanning' }));
    const active = new Set(unique);
    const stale = Object.values(manifest.entries).filter((entry) => !active.has(entry.source));
    for (const entry of stale) {
      await removeEntryFile(entry);
      delete manifest.entries[entry.source];
    }
    const queue = unique.filter((source) => options.force || !manifest.entries[source]);
    const totalJobs = queue.length;
    let completed = 0;
    let failed = 0;
    const publish = (current = '') => onState(stateFor(unique, { phase: totalJobs ? 'downloading' : 'ready', completed, pending: Math.max(0, totalJobs - completed - failed), failed, current }));
    publish();
    try {
      await Promise.all(Array.from({ length: Math.min(3, Math.max(1, queue.length)) }, async () => {
        while (queue.length) {
          const source = queue.shift();
          if (!source) return;
          publish(source);
          try {
            const entry = await cacheOne(source, Boolean(options.force));
            if (!entry.fileUri && !await loadRuntimeUrl(source)) throw new Error('Не удалось открыть сохранённое изображение');
            manifest.entries[source] = entry;
            completed += 1;
            persist();
          } catch {
            failed += 1;
          }
          publish();
        }
      }));
      manifest.lastSync = new Date().toISOString();
      persist();
      const result = stateFor(unique, { phase: failed ? 'error' : 'ready', completed, pending: 0, failed, current: '' });
      onState(result);
      return result;
    } finally { running = false; }
  },

  async clear(sources: string[], onState?: (state: ImageCacheState) => void) {
    if (running) return stateFor(sources);
    running = true;
    onState?.(stateFor(sources, { phase: 'clearing' }));
    try {
      if (Capacitor.isNativePlatform()) await Filesystem.rmdir({ path: 'image-cache', directory: Directory.Data, recursive: true }).catch(() => undefined);
      if ('caches' in window) await caches.delete(WEB_CACHE);
      manifest.entries = {};
      [...runtimeUrls.keys()].forEach(revokeRuntimeUrl);
      manifest.lastSync = null;
      persist();
      const result = stateFor(sources, { phase: 'idle' });
      onState?.(result);
      return result;
    } finally { running = false; }
  },
};
