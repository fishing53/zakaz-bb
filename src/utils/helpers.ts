export const formatPrice = (value: number) => `${new Intl.NumberFormat('ru-RU').format(value)}\u00a0₽`;
export const escapeHtml = (value: string | number | null | undefined) => String(value ?? '').replace(/[&<>'"]/g, (symbol) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[symbol] ?? symbol);
type Debounced<T extends (...args: never[]) => void> = ((...args: Parameters<T>) => void) & { cancel: () => void };

export const debounce = <T extends (...args: never[]) => void>(callback: T, delay = 180): Debounced<T> => {
  let timer = 0;
  const debounced = ((...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), delay);
  }) as Debounced<T>;
  debounced.cancel = () => { clearTimeout(timer); timer = 0; };
  return debounced;
};
export const imageStyle = (url: string, position = 'center') => {
  const source = String(url ?? '').trim();
  const safeUrl = /^(https?:\/\/|\/)/i.test(source) ? encodeURI(source).replace(/["']/g, (symbol) => symbol === '"' ? '%22' : '%27') : '/icons/app-icon.svg';
  return `style="--image: url('${safeUrl}');--image-position:${position.replace(/[^\w% -]/g, '')}"`;
};
