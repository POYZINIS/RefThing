import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { blobUrl } from '@/api/client';
import type { ViewportState } from '@/canvas/BoardCanvas';
import type { SpriteNode } from '@/canvas/nodes/types';
import { Icon } from '@/ui/Icon';
import { useProximityReveal } from '@/ui/useProximityReveal';
import { formatPrecise, formatTime } from './mediaTime';

export { formatTime } from './mediaTime';

/** How near (px) the pointer must come to one control to reveal it. */
const CONTROL_REVEAL_PX = 12;
/** Below these on-screen sizes the controls move to a strip under the item
 *  (inside, they'd crowd into each other's reveal zones): a video needs room
 *  for the centre button above the scrub bar, audio for its transport. */
const COMPACT = {
  video: { width: 240, height: 170 },
  audio: { width: 280, height: 100 },
} as const;

const VOLUME_KEY = 'refthing.mediaVolume';

function loadVolume(): { volume: number; muted: boolean } {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(VOLUME_KEY) ?? 'null') as {
      volume?: unknown;
      muted?: unknown;
    } | null;
    const volume = typeof saved?.volume === 'number' ? saved.volume : 1;
    return { volume: Math.max(0, Math.min(1, volume)), muted: saved?.muted === true };
  } catch {
    return { volume: 1, muted: false };
  }
}

function saveVolume(volume: number, muted: boolean): void {
  try {
    globalThis.localStorage?.setItem(VOLUME_KEY, JSON.stringify({ volume, muted }));
  } catch {
    // Storage blocked: the level holds for this session.
  }
}

export type MediaHandle = { toggle: () => void };

type MediaPlayerProps = {
  node: SpriteNode;
  /** The rendered (eased) camera, same as every other overlay. */
  viewport: ViewportState;
  /** The lone selection: controls show, and double-click / Play drive it.
   *  Losing the selection pauses it; getting it back never resumes it. */
  selected: boolean;
  /** Start playing on mount (double-click / Play on an unselected item). */
  autoPlay: boolean;
  onAutoPlayed: () => void;
  /** The App's handle for double-click / Play on the selected player. */
  handle: RefObject<MediaHandle | null>;
};

/**
 * Phase 11 media, custom controls. A video or audio item gets a player the
 * first time it's selected and keeps it (App holds the few most recent), so
 * deselecting only PAUSES it: the position stays, and selecting it again
 * shows it exactly as left, paused, until the user presses play.
 *
 * While selected, controls fade in one by one as the pointer nears each.
 * Video: play in the centre, a scrub bar, volume / loop / fullscreen.
 * Audio, for ears: a playhead through the waveform that is itself the seek
 * control (drag it; its time shows to the millisecond), and a transport with
 * millisecond time. Only a selected item has any of these. The item body stays free: it still moves and resizes
 * while it plays.
 */
export function MediaPlayer({
  node,
  viewport,
  selected,
  autoPlay,
  onAutoPlayed,
  handle,
}: MediaPlayerProps) {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [{ volume, muted }, setLevel] = useState(loadVolume);
  const [loop, setLoop] = useState(node.kind === 'video');
  const [scrubbing, setScrubbing] = useState(false);

  const toggle = () => {
    const element = media.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => undefined);
    else element.pause();
  };

  // The App's handle is the selected player's; losing the selection pauses.
  useEffect(() => {
    if (!selected) {
      media.current?.pause();
      return;
    }
    const own: MediaHandle = {
      toggle: () => {
        const element = media.current;
        if (!element) return;
        if (element.paused) void element.play().catch(() => undefined);
        else element.pause();
      },
    };
    handle.current = own;
    return () => {
      if (handle.current === own) handle.current = null;
    };
  }, [selected, handle]);

  // Mount only: autoplay is a one-off request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only
  useEffect(() => {
    if (autoPlay) {
      void media.current?.play().catch(() => undefined);
      onAutoPlayed();
    }
  }, []);

  useEffect(() => {
    const element = media.current;
    if (!element) return;
    element.volume = volume;
    element.muted = muted;
    saveVolume(volume, muted);
  }, [volume, muted]);

  // Fullscreen shows the browser's own controls (ours stay on the board).
  useEffect(() => {
    const element = media.current;
    if (!element) return;
    const onChange = () => {
      element.controls = document.fullscreenElement === element;
    };
    element.addEventListener('fullscreenchange', onChange);
    return () => element.removeEventListener('fullscreenchange', onChange);
  }, []);

  // While playing, read the clock every frame: the playhead glides instead
  // of stepping at `timeupdate`'s few hertz.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const element = media.current;
      if (element) setTime(element.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const width = node.width * viewport.zoom;
  const height = node.height * viewport.zoom;
  const centerX = viewport.x + (node.x + node.width / 2) * viewport.zoom;
  const centerY = viewport.y + (node.y + node.height / 2) * viewport.zoom;
  const isVideo = node.kind === 'video';
  const limits = COMPACT[isVideo ? 'video' : 'audio'];
  const compact = width < limits.width || height < limits.height;
  const fraction = duration > 0 ? Math.min(1, time / duration) : 0;

  const mediaEvents = {
    ref: media,
    'data-testid': 'live-media',
    src: blobUrl(node.blobHash, 'full'),
    preload: 'metadata' as const,
    loop,
    onPlay: () => {
      setPlaying(true);
      setStarted(true);
    },
    onPause: (event: React.SyntheticEvent<HTMLMediaElement>) => {
      setPlaying(false);
      setTime(event.currentTarget.currentTime);
    },
    onTimeUpdate: (event: React.SyntheticEvent<HTMLMediaElement>) =>
      setTime(event.currentTarget.currentTime),
    onSeeked: (event: React.SyntheticEvent<HTMLMediaElement>) => {
      setTime(event.currentTarget.currentTime);
      setStarted(true);
    },
    onLoadedMetadata: (event: React.SyntheticEvent<HTMLMediaElement>) =>
      setDuration(event.currentTarget.duration),
    onDurationChange: (event: React.SyntheticEvent<HTMLMediaElement>) =>
      setDuration(event.currentTarget.duration),
  };

  const seekTo = (to: number) => {
    const element = media.current;
    if (!element || !Number.isFinite(element.duration)) return;
    element.currentTime = Math.max(0, Math.min(1, to)) * element.duration;
    setTime(element.currentTime);
  };
  const seekBy = (seconds: number) => {
    const element = media.current;
    if (!element || !Number.isFinite(element.duration)) return;
    element.currentTime = Math.max(0, Math.min(element.duration, element.currentTime + seconds));
    setTime(element.currentTime);
  };

  const playButton = (big: boolean) => (
    <button
      className={`media-button ${big ? 'big' : ''}`}
      type="button"
      aria-label={playing ? 'Pause' : 'Play'}
      title={playing ? 'Pause' : 'Play'}
      // The second click of a double-click is the double-click's.
      onClick={(event) => {
        if (event.detail <= 1) toggle();
      }}
    >
      <Icon name={playing ? 'pause' : 'play'} size={big ? 20 : 15} />
    </button>
  );

  const volumeAndLoop = (
    <>
      <Control className="media-volume">
        <button
          className="media-button"
          type="button"
          aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
          title={muted || volume === 0 ? 'Unmute' : 'Mute'}
          onClick={() => setLevel({ volume: volume === 0 ? 1 : volume, muted: !muted })}
        >
          <Icon name={muted || volume === 0 ? 'mute' : 'volume'} size={15} />
        </button>
        <input
          className="media-volume-slider"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          aria-label="Volume"
          onChange={(event) =>
            setLevel({
              volume: Number(event.target.value),
              muted: Number(event.target.value) === 0,
            })
          }
        />
      </Control>
      <Control className="media-loop">
        <button
          className="media-button"
          type="button"
          aria-pressed={loop}
          aria-label="Loop"
          title={loop ? 'Stop looping' : 'Loop'}
          onClick={() => setLoop((value) => !value)}
        >
          <Icon name="loop" size={15} />
        </button>
      </Control>
    </>
  );

  const videoControls = (
    <>
      <Control className={`media-play ${compact ? '' : 'center'}`}>{playButton(!compact)}</Control>
      <Control className="media-scrub" pinned={scrubbing}>
        <Scrubber
          fraction={fraction}
          rotation={node.rotation}
          onSeek={seekTo}
          onScrub={setScrubbing}
        />
        <span className="media-time">
          {formatTime(time)} / {formatTime(duration)}
        </span>
      </Control>
      <div className="media-corner">
        {volumeAndLoop}
        <Control className="media-fullscreen">
          <button
            className="media-button"
            type="button"
            aria-label="Fullscreen"
            title="Fullscreen"
            onClick={() => void media.current?.requestFullscreen?.().catch(() => undefined)}
          >
            <Icon name="fullscreen" size={15} />
          </button>
        </Control>
      </div>
    </>
  );

  const transport = (
    <Control className="media-transport">
      {playButton(false)}
      <span className="media-time precise">
        {formatPrecise(time)}
        <span className="media-time-total">/ {formatPrecise(duration)}</span>
      </span>
    </Control>
  );
  const audioControls = compact ? (
    <>
      {transport}
      <div className="media-corner">{volumeAndLoop}</div>
    </>
  ) : (
    <>
      {transport}
      <div className="media-corner bottom">{volumeAndLoop}</div>
    </>
  );

  const frame = {
    left: centerX - width / 2,
    top: centerY - height / 2,
    width,
    height,
    transform: `rotate(${node.rotation}deg)`,
  };

  return (
    <>
      {isVideo ? (
        <video
          {...mediaEvents}
          className="live-media live-media--video"
          playsInline
          // Deselected, the canvas poster shows (a DOM element can't take
          // part in the board's stacking); the paused frame returns with
          // the selection.
          style={{ ...frame, opacity: started && selected ? node.opacity : 0 }}
        />
      ) : (
        <audio {...mediaEvents} className="live-media live-media--audio" />
      )}
      {selected && !isVideo && duration > 0 && (
        // The playhead: through the waveform, where the audio is. Drag it
        // to seek — the item has to be selected first, like everything on
        // an item.
        <Playhead
          frame={frame}
          fraction={fraction}
          duration={duration}
          rotation={node.rotation}
          scrubbing={scrubbing}
          onSeek={seekTo}
          onSeekBy={seekBy}
          onScrub={setScrubbing}
        />
      )}
      {selected && (
        // The controls ride the item: same centre, size and rotation; in
        // compact mode a strip under it instead.
        <div
          className={`media-controls ${node.kind} ${compact ? 'compact' : ''}`}
          style={
            compact
              ? {
                  left: centerX - Math.max(width, 280) / 2,
                  top: centerY + height / 2 + 8,
                  width: Math.max(width, 280),
                  transform: `rotate(${node.rotation}deg)`,
                  transformOrigin: `50% ${-(height / 2 + 8)}px`,
                }
              : frame
          }
        >
          {isVideo ? videoControls : audioControls}
        </div>
      )}
    </>
  );
}

/** One control, revealed on its own when the pointer comes near it. */
function Control({
  className,
  pinned = false,
  children,
}: {
  className: string;
  pinned?: boolean;
  children: ReactNode;
}) {
  const element = useRef<HTMLFieldSetElement>(null);
  const shown = useProximityReveal(element, pinned, CONTROL_REVEAL_PX);
  return (
    <fieldset
      ref={element}
      className={`media-control ${className}`}
      data-revealed={shown}
      // Presses on a control are the control's: never a move, never a
      // canvas press, never a new selection.
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {children}
    </fieldset>
  );
}

/** Pointer → 0–1 along an element's own axis (rotation-aware: the pointer
 *  is projected onto the turned item's x axis). */
function fractionAlong(element: HTMLElement, event: React.PointerEvent, rotation: number) {
  const rect = element.getBoundingClientRect();
  const radians = (rotation * Math.PI) / 180;
  const dx = event.clientX - (rect.left + rect.width / 2);
  const dy = event.clientY - (rect.top + rect.height / 2);
  const along = dx * Math.cos(radians) + dy * Math.sin(radians);
  return Math.max(0, Math.min(1, along / element.offsetWidth + 0.5));
}

/** Drag-to-seek on an element: capture, seek on press and move. */
function useSeekDrag(
  rotation: number,
  onSeek: (fraction: number) => void,
  onScrub: (scrubbing: boolean) => void,
) {
  return {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      onScrub(true);
      onSeek(fractionAlong(event.currentTarget, event, rotation));
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        onSeek(fractionAlong(event.currentTarget, event, rotation));
      }
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      event.currentTarget.releasePointerCapture(event.pointerId);
      onScrub(false);
    },
    onPointerCancel: () => onScrub(false),
  };
}

/** The video scrub bar. */
function Scrubber({
  fraction,
  rotation,
  onSeek,
  onScrub,
}: {
  fraction: number;
  rotation: number;
  onSeek: (fraction: number) => void;
  onScrub: (scrubbing: boolean) => void;
}) {
  const drag = useSeekDrag(rotation, onSeek, onScrub);
  return (
    <div
      className="media-track"
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      {...drag}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          event.stopPropagation();
          onSeek(fraction + (event.key === 'ArrowLeft' ? -0.05 : 0.05));
        }
      }}
    >
      <span className="media-track-fill" style={{ width: `${fraction * 100}%` }} />
      <span className="media-track-thumb" style={{ left: `${fraction * 100}%` }} />
    </div>
  );
}

/**
 * The audio playhead: a line through the waveform at the current time, and
 * the seek control itself — grab it (a thin zone around the line) and drag
 * along the waveform; arrows step a second (Shift: five). While hovered or
 * dragged it shows its time to the millisecond. It exists only while the
 * item is selected.
 */
function Playhead({
  frame,
  fraction,
  duration,
  rotation,
  scrubbing,
  onSeek,
  onSeekBy,
  onScrub,
}: {
  frame: React.CSSProperties;
  fraction: number;
  duration: number;
  rotation: number;
  scrubbing: boolean;
  onSeek: (fraction: number) => void;
  onSeekBy: (seconds: number) => void;
  onScrub: (scrubbing: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Positions are fractions of the WAVEFORM (the item's box), wherever the
  // pointer is while dragging.
  const seekFrom = (event: React.PointerEvent) => {
    if (box.current) onSeek(fractionAlong(box.current, event, rotation));
  };
  return (
    <div ref={box} className="media-frame" style={frame}>
      <div
        className={`media-playhead ${scrubbing ? 'dragging' : ''}`}
        style={{ left: `${fraction * 100}%` }}
        role="slider"
        tabIndex={0}
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration * 1000) / 1000}
        aria-valuenow={Math.round(fraction * duration * 1000) / 1000}
        aria-valuetext={formatPrecise(fraction * duration)}
        onPointerDown={(event) => {
          // The playhead's, never a move of the item.
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          onScrub(true);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFrom(event);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          onScrub(false);
        }}
        onPointerCancel={() => onScrub(false)}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          event.stopPropagation();
          const step = event.shiftKey ? 5 : 1;
          onSeekBy(event.key === 'ArrowLeft' ? -step : step);
        }}
      >
        <span className="media-playhead-line" />
        <span className="media-playhead-cap" />
        <span className="media-playhead-time">{formatPrecise(fraction * duration)}</span>
      </div>
    </div>
  );
}
