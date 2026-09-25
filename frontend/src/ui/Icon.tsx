/**
 * The chrome's one icon system: 24-unit viewBox, 1.65 stroke, round caps and
 * joins, drawn in currentColor so every icon follows the theme. Rendered at
 * 17px inside the standard icon button unless a size is given.
 */
const PATHS = {
  plus: 'M12 5v14M5 12h14',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  chevronDown: 'M7 10l5 5 5-5',
  check: 'M5.5 12.5l4 4 9-9',
  sun: 'M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6zM12 2.8v1.9M12 19.3v1.9M4.9 4.9l1.3 1.3M17.8 17.8l1.3 1.3M2.8 12h1.9M19.3 12h1.9M4.9 19.1l1.3-1.3M17.8 6.2l1.3-1.3',
  moon: 'M19.5 14.6A7.6 7.6 0 0 1 9.4 4.5a7.6 7.6 0 1 0 10.1 10.1z',
  gear: 'M12 9.3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4zM19.2 13.4l1.6 1.2-1.8 3.1-1.9-.7a7 7 0 0 1-1.9 1.1l-.3 2h-3.6l-.3-2a7 7 0 0 1-1.9-1.1l-1.9.7-1.8-3.1 1.6-1.2a7 7 0 0 1 0-2.8L3.2 9.4 5 6.3l1.9.7a7 7 0 0 1 1.9-1.1l.3-2h3.6l.3 2a7 7 0 0 1 1.9 1.1l1.9-.7 1.8 3.1-1.6 1.2a7 7 0 0 1 0 2.8z',
  boards: 'M4 5.5h7v6H4zM13 5.5h7v3.5h-7zM13 11.5h7v7h-7zM4 14h7v4.5H4z',
  addFiles:
    'M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9zM13.5 3.5V9H19M12 12v6M9 15h6',
  search: 'M10.8 4.5a6.3 6.3 0 1 0 0 12.6 6.3 6.3 0 0 0 0-12.6zM15.4 15.4l4.1 4.1',
  history: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.9h3.9M12 8v4.3l2.8 1.7',
  pencil:
    'M14.8 5.7l3.5 3.5M5 19l1-4.2 9.6-9.6a1.8 1.8 0 0 1 2.5 0l1 1a1.8 1.8 0 0 1 0 2.5L9.5 18.3z',
  trash:
    'M5 7h14M9.5 7V5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7M7 7l.8 11.2a1.5 1.5 0 0 0 1.5 1.3h5.4a1.5 1.5 0 0 0 1.5-1.3L17 7',
  tag: 'M4.5 12.3V5.5a1 1 0 0 1 1-1h6.8l7.2 7.2a1.4 1.4 0 0 1 0 2l-5.8 5.8a1.4 1.4 0 0 1-2 0zM8.5 8.2h.01',
  pin: 'M9.5 4.5h5M10.5 4.5v5l-3 3h9l-3-3v-5M12 12.5v7',
  minimize: 'M6 12h12',
  maximize: 'M6.5 6.5h11v11h-11z',
  restore: 'M8.5 8.5h9v9h-9zM6.5 15.5v-9h9',
  windowClose: 'M7 7l10 10M17 7L7 17',
  alert: 'M12 4.5l8.5 15h-17zM12 10v4.2M12 17h.01',
  fullscreen: 'M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15',
  play: 'M8 5.5v13a.8.8 0 0 0 1.2.7l10.2-6.5a.8.8 0 0 0 0-1.4L9.2 4.8A.8.8 0 0 0 8 5.5z',
  pause: 'M8 5.5v13M16 5.5v13',
  volume: 'M4.5 9.5v5h3.5l4.5 4V5.5L8 9.5zM16 9a4.2 4.2 0 0 1 0 6M18.6 6.4a8 8 0 0 1 0 11.2',
  mute: 'M4.5 9.5v5h3.5l4.5 4V5.5L8 9.5zM16.5 9.5l5 5M21.5 9.5l-5 5',
  loop: 'M17 3.5l3 3-3 3M20 6.5H8a3.5 3.5 0 0 0-3.5 3.5v1M7 20.5l-3-3 3-3M4 17.5h12a3.5 3.5 0 0 0 3.5-3.5v-1',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
