import { create } from 'zustand';

/**
 * Appearance preferences: theme, glass panels and (desktop) backdrop
 * opacity. Chrome only — board content keeps its own colours in every theme.
 * Persisted per machine; applied as attributes on <html> so CSS does the rest
 * (index.html applies the saved theme before first paint, so no flash).
 */
export type ThemeMode = 'system' | 'light' | 'dark';
export type Appearance = {
  theme: ThemeMode;
  /** Translucent, blurred panels (and the native backdrop on desktop). */
  glass: boolean;
  /** Workspace opacity over the native backdrop, 0–1 (desktop glass only). */
  backdropOpacity: number;
  /** Mouse-wheel zoom speed multiplier (1 = default). */
  zoomSpeed: number;
  /** Dragging the window's left / top edge: hold the board exactly in
   *  place (Windows shows each step's previous frame shifted — a jitter),
   *  or let it ride with the window and glide back once the drag stops. */
  windowResize: WindowResizeMode;
  /** Testing aid: cap the board's frame rate (0 = normal). */
  frameCap: number;
};
export type WindowResizeMode = 'exact' | 'smooth';

const KEY = 'refthing.appearance';
/** The workspace is see-through by default so the window's blurred
 *  background (desktop glass) actually shows. */
const DEFAULTS: Appearance = {
  theme: 'system',
  glass: true,
  backdropOpacity: 0.55,
  zoomSpeed: 1,
  windowResize: 'exact',
  frameCap: 0,
};
/** The old default, saved along with any other change before the backdrop
 *  became a real blur: it means "default", not a choice. */
const OLD_DEFAULT_BACKDROP = 0.85;

function load(): Appearance {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return DEFAULTS;
    const stored = JSON.parse(raw) as Partial<Appearance>;
    if (stored.backdropOpacity === OLD_DEFAULT_BACKDROP) delete stored.backdropOpacity;
    return { ...DEFAULTS, ...stored };
  } catch {
    return DEFAULTS;
  }
}

function save(appearance: Appearance): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(appearance));
  } catch {
    // Storage blocked: the choice still holds for this session.
  }
}

const darkQuery =
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

export const resolveTheme = (mode: ThemeMode): 'light' | 'dark' =>
  mode === 'system' ? (darkQuery?.matches ? 'dark' : 'light') : mode;

type AppearanceStore = Appearance & {
  resolved: 'light' | 'dark';
  set: (patch: Partial<Appearance>) => void;
};

export const useAppearance = create<AppearanceStore>((set, get) => {
  const initial = load();
  return {
    ...initial,
    resolved: resolveTheme(initial.theme),
    set(patch) {
      const { theme, glass, backdropOpacity, zoomSpeed, windowResize, frameCap } = {
        ...get(),
        ...patch,
      };
      const next = { theme, glass, backdropOpacity, zoomSpeed, windowResize, frameCap };
      save(next);
      set({ ...next, resolved: resolveTheme(theme) });
    },
  };
});

darkQuery?.addEventListener('change', () => {
  const { theme } = useAppearance.getState();
  useAppearance.setState({ resolved: resolveTheme(theme) });
});

/** Mirror the preferences onto <html>; returns the unsubscribe. */
export function applyAppearance(): () => void {
  const root = document.documentElement;
  const apply = ({ resolved, glass, backdropOpacity }: AppearanceStore) => {
    root.dataset.theme = resolved;
    root.dataset.glass = glass ? 'on' : 'off';
    root.style.setProperty('--backdrop-alpha', String(glass ? backdropOpacity : 1));
    root.style.colorScheme = resolved;
  };
  apply(useAppearance.getState());
  return useAppearance.subscribe(apply);
}
