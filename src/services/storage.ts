export const storage = {
  get<T>(key: string, fallback: T): T {
    try { return JSON.parse(localStorage.getItem(key) ?? '') as T; } catch { return fallback; }
  },
  set(key: string, value: unknown) { localStorage.setItem(key, JSON.stringify(value)); },
};
