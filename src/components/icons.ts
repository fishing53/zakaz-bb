const paths: Record<string, string> = {
  arrow: '<path d="m19 12-7 7m7-7-7-7M5 12h14"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.9-8.6a5.5 5.5 0 0 0-.1-7.8Z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.3-4.3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  plate: '<path d="M4 15h16M5 18h14M7 12a5 5 0 0 1 10 0M12 7V3M8 5 6 3M16 5l2-2"/>',
  flame: '<path d="M12 22c4 0 7-2.5 7-7 0-3-1.8-5.6-4.4-7.9.1 2.6-1 4-2.3 4.8.2-3.7-1.8-6.5-4.9-8.9.3 4.9-5.4 7.1-5.4 12C2 19.5 6 22 12 22Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3Z"/><path d="m14.5 7.5 3 3"/>',
  ticket: '<path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4V7Z"/><path d="M12 9.5v5"/>',
  language: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  utensils: '<path d="M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10M17 3v18M17 3c3 1 3 7 0 8h-2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  serviceBell: '<path d="M5 17h14M7 17v-1a5 5 0 0 1 10 0v1M12 8V5M10 5h4"/><path d="M4 20h16"/>',
  serviceCutlery: '<path d="M6 3v7M3.5 3v4.5a2.5 2.5 0 0 0 5 0V3M6 10v11M17.5 3v18M17.5 3c2.5 1.2 2.5 6.8 0 8h-2.3"/>',
  serviceReceipt: '<path d="M7 3h10v18l-2.5-1.7L12 21l-2.5-1.7L7 21V3Z"/><path d="M10 8h4M10 12h4M10 16h2"/>',
  serviceHelp: '<path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.6 8.6 0 0 1-3.3-.7L4 20l1.5-4A7.2 7.2 0 0 1 4 11.5 7.5 7.5 0 0 1 12 4a7.5 7.5 0 0 1 8 7.5Z"/><path d="M10.2 9.5a2 2 0 1 1 3.4 1.4c-.9.8-1.6 1.2-1.6 2.6M12 16h.01"/>',
};

export type IconName = keyof typeof paths;

export const icon = (name: IconName, className = '') => `<svg class="icon ${className}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
