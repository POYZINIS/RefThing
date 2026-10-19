import { create } from 'zustand';

/**
 * Updates from the GitHub releases (src-tauri: tauri-plugin-updater, which
 * reads the release's signed latest.json and installs the new version's
 * installer). Reached through the global Tauri API like the rest of the
 * shell; inert in the browser build. Checked once at startup and from
 * Settings → Updates; installing always waits for the user's go-ahead.
 */
type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };
type TauriUpdate = {
  version: string;
  body?: string;
  downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
};
type TauriGlobal = {
  updater?: { check(): Promise<TauriUpdate | null> };
  app?: { getVersion(): Promise<string> };
};

const tauri = () => (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;

/** Whether this build can update itself (the installed desktop app). */
export const canUpdate = () => Boolean(tauri()?.updater);

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'error';

type UpdateState = {
  status: UpdateStatus;
  /** This app's version. */
  current: string | null;
  /** The newer version, when one is available. */
  available: string | null;
  /** Its release notes. */
  notes: string | null;
  /** Download progress, 0–1 (null while the size is unknown). */
  progress: number | null;
  error: string | null;
  /** The startup notice was dismissed (Settings still shows it). */
  dismissed: boolean;
  /** Ask GitHub for a newer release. `quiet`: a failure (offline) stays out
   *  of sight — the startup check. */
  check: (quiet?: boolean) => Promise<void>;
  /** Download and install the available update; the app restarts into it. */
  install: () => Promise<void>;
  dismiss: () => void;
};

// The plugin's update handle (not state: it carries methods).
let pending: TauriUpdate | null = null;

export const useUpdates = create<UpdateState>((set, get) => ({
  status: 'idle',
  current: null,
  available: null,
  notes: null,
  progress: null,
  error: null,
  dismissed: false,

  async check(quiet = false) {
    const api = tauri();
    if (!api?.updater) return;
    const busy = get().status;
    if (busy === 'checking' || busy === 'downloading' || busy === 'installing') return;
    set({ status: 'checking', error: null });
    try {
      const current = (await api.app?.getVersion()) ?? null;
      const update = await api.updater.check();
      pending = update;
      set(
        update
          ? {
              status: 'available',
              current,
              available: update.version,
              notes: update.body ?? null,
              dismissed: false,
            }
          : { status: 'current', current, available: null, notes: null },
      );
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      set({ status: quiet ? 'idle' : 'error', error: quiet ? null : message });
    }
  },

  async install() {
    if (!pending || get().status !== 'available') return;
    let total = 0;
    let received = 0;
    set({ status: 'downloading', progress: null, error: null });
    try {
      await pending.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          set({ progress: total > 0 ? Math.min(1, received / total) : null });
        } else {
          set({ status: 'installing', progress: 1 });
        }
      });
      // Windows: the installer takes over and the app closes itself.
    } catch (reason) {
      set({
        status: 'error',
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  },

  dismiss() {
    set({ dismissed: true });
  },
}));
