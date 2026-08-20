import arrowRight from 'lucide-static/icons/arrow-right.svg?raw';
import bell from 'lucide-static/icons/bell.svg?raw';
import check from 'lucide-static/icons/check.svg?raw';
import circleHelp from 'lucide-static/icons/circle-help.svg?raw';
import conciergeBell from 'lucide-static/icons/concierge-bell.svg?raw';
import cookingPot from 'lucide-static/icons/cooking-pot.svg?raw';
import heart from 'lucide-static/icons/heart.svg?raw';
import info from 'lucide-static/icons/info.svg?raw';
import languages from 'lucide-static/icons/languages.svg?raw';
import image from 'lucide-static/icons/image.svg?raw';
import logOut from 'lucide-static/icons/log-out.svg?raw';
import mapPinned from 'lucide-static/icons/map-pinned.svg?raw';
import minus from 'lucide-static/icons/minus.svg?raw';
import pencil from 'lucide-static/icons/pencil.svg?raw';
import plus from 'lucide-static/icons/plus.svg?raw';
import receiptText from 'lucide-static/icons/receipt-text.svg?raw';
import search from 'lucide-static/icons/search.svg?raw';
import settings from 'lucide-static/icons/settings.svg?raw';
import shoppingBag from 'lucide-static/icons/shopping-bag.svg?raw';
import ticketPercent from 'lucide-static/icons/ticket-percent.svg?raw';
import utensils from 'lucide-static/icons/utensils.svg?raw';
import utensilsCrossed from 'lucide-static/icons/utensils-crossed.svg?raw';
import userRound from 'lucide-static/icons/user-round.svg?raw';
import refreshCw from 'lucide-static/icons/refresh-cw.svg?raw';
import x from 'lucide-static/icons/x.svg?raw';

// Individual screens only choose a meaning. All artwork comes from Lucide,
// so proportions, stroke width and visual language stay consistent.
const icons = {
  arrowRight,
  bell,
  check,
  close: x,
  cooking: cookingPot,
  edit: pencil,
  heart,
  help: circleHelp,
  image,
  info,
  language: languages,
  logout: logOut,
  menu: utensilsCrossed,
  map: mapPinned,
  minus,
  order: shoppingBag,
  plus,
  promo: ticketPercent,
  receipt: receiptText,
  search,
  settings,
  refresh: refreshCw,
  utensils,
  waiter: conciergeBell,
  user: userRound,
} as const;

export type IconName = keyof typeof icons;

export const icon = (name: IconName, className = '') => icons[name]
  .replace(/^\s*<!--[^>]*-->\s*/, '')
  .replace(/class="lucide[^"]*"/, `class="icon ${className}"`)
  .replace(/\swidth="24"/, '')
  .replace(/\sheight="24"/, '')
  .replace('<svg', '<svg aria-hidden="true" focusable="false"');
