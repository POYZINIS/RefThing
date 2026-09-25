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
};

const KEY = 'refthing.appearance';
const DEFAULTS: Appearance = { theme: 'system', glass: true, backdropOpacity: 0.85, zoomSpeed: 1 };

function load(): Appearance {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Appearance>) } : DEFAULTS;
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
      const { theme, glass, backdropOpacity, zoomSpeed } = { ...get(), ...patch };
      const next = { theme, glass, backdropOpacity, zoomSpeed };
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
