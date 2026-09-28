import {
  ArrowRightToLine,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Dices,
  FilePlus2,
  History,
  LayoutDashboard,
  type LucideIcon,
  Maximize,
  Minus,
  Moon,
  Palette,
  Pause,
  Pencil,
  Pin,
  Play,
  Plus,
  Repeat,
  Search,
  Settings,
  Square,
  Sun,
  Tag,
  Trash2,
  TriangleAlert,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';

/**
 * The chrome's one icon system: Lucide icons, drawn in currentColor so every
 * icon follows the theme, at one stroke weight. Rendered at 17px inside the
 * standard icon button unless a size is given. Names describe the job, not
 * the glyph, so a glyph can change here without touching call sites.
 */
const ICONS = {
  plus: Plus,
  close: X,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  check: Check,
  sun: Sun,
  moon: Moon,
  gear: Settings,
  boards: LayoutDashboard,
  addFiles: FilePlus2,
  search: Search,
  history: History,
  pencil: Pencil,
  trash: Trash2,
  tag: Tag,
  pin: Pin,
  minimize: Minus,
  maximize: Square,
  restore: Copy,
  windowClose: X,
  alert: TriangleAlert,
  fullscreen: Maximize,
  play: Play,
  pause: Pause,
  volume: Volume2,
  mute: VolumeX,
  loop: Repeat,
  palette: Palette,
  dice: Dices,
  compress: ArrowRightToLine,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      className="icon"
      size={size}
      strokeWidth={1.75}
      absoluteStrokeWidth={false}
      aria-hidden="true"
      focusable="false"
    />
  );
}
