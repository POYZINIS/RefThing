import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { blobUrl } from '@/api/client';
import type { ViewportState } from '@/canvas/BoardCanvas';
import type { SpriteNode } from '@/canvas/nodes/types';
import { Icon } from '@/ui/Icon';
import { useProximityReveal } from '@/ui/useProximityReveal';

/** How near (px) the pointer must come to one control to reveal it. */
const CONTROL_REVEAL_PX = 12;
/** Below these on-screen sizes the controls move to a strip under the item
 *  (inside, they'd crowd into each other's reveal zones): a video needs room
 *  for the centre button above the scrub bar, audio only for one row. */
const COMPACT = {
  video: { width: 240, height: 170 },
  audio: { width: 280, height: 90 },
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

/** 83.4 → "1:23"; an hour or more → "1:02:03". */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = String(whole % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

export type MediaHandle = { toggle: () => void };

type MediaPlayerProps = {
  node: SpriteNode;
  /** The rendered (eased) camera, same as every other overlay. */
  viewport: ViewportState;
  /** Start playing on mount (double-click / Play on an unselected item). */
  autoPlay: boolean;
  onAutoPlayed: () => void;
  /** The App's handle for double-click / Play on the mounted player. */
  handle: RefObject<MediaHandle | null>;
};

/**
 * Phase 11 media, custom controls. Selecting a lone video or audio item
 * mounts its player: the element itself (video over the poster once it has
 * frames to show; audio invisible over its waveform) and a set of controls —
 * play, scrub bar, volume, loop, fullscreen — that each fade in only when
 * the pointer comes near that control, like the corner chrome. Nothing
 * reveals mid-drag. The selection shell stays live underneath (the item
 * still moves and resizes while it plays); controls take only their own
 * presses. Deselecting stops playback.
 */
export function MediaPlayer({ node, viewport, autoPlay, onAutoPlayed, handle }: MediaPlayerProps) {
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
  handle.current = { toggle };

  // Mount only: autoplay is a one-off request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only
  useEffect(() => {
    if (autoPlay) {
      void media.current?.play().catch(() => undefined);
      onAutoPlayed();
    }
    return () => {
      handle.current = null;
    };
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

  const width = node.width * viewport.zoom;
  const height = node.height * viewport.zoom;
  const centerX = viewport.x + (node.x + node.width / 2) * viewport.zoom;
  const centerY = viewport.y + (node.y + node.height / 2) * viewport.zoom;
  const isVideo = node.kind === 'video';
  const limits = COMPACT[isVideo ? 'video' : 'audio'];
  const compact = width < limits.width || height < limits.height;

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
    onPause: () => setPlaying(false),
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

  const seekTo = (fraction: number) => {
    const element = media.current;
    if (!element || !Number.isFinite(element.duration)) return;
    element.currentTime = Math.max(0, Math.min(1, fraction)) * element.duration;
    setTime(element.currentTime);
  };

  const controls = (
    <>
      <Control className={`media-play ${compact ? '' : isVideo ? 'center' : 'left'}`}>
        <button
          className="media-button big"
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause' : 'Play'}
          // The second click of a double-click is the double-click's.
          onClick={(event) => {
            if (event.detail <= 1) toggle();
          }}
        >
          <Icon name={playing ? 'pause' : 'play'} size={compact ? 16 : 20} />
        </button>
      </Control>
      <Control className="media-scrub" pinned={scrubbing}>
        <Scrubber
          fraction={duration > 0 ? time / duration : 0}
          rotation={node.rotation}
          onSeek={seekTo}
          onScrub={setScrubbing}
        />
        <span className="media-time">
          {formatTime(time)} / {formatTime(duration)}
        </span>
      </Control>
      <div className="media-corner">
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
        {isVideo && (
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
        )}
      </div>
    </>
  );

  return (
    <>
      {isVideo ? (
        <video
          {...mediaEvents}
          className={`live-media live-media--video ${started ? 'started' : ''}`}
          playsInline
          style={{
            left: centerX - width / 2,
            top: centerY - height / 2,
            width,
            height,
            opacity: started ? node.opacity : 0,
            transform: `rotate(${node.rotation}deg)`,
          }}
        />
      ) : (
        <audio {...mediaEvents} className="live-media live-media--audio" />
      )}
      {/* The controls ride the item: same centre, size and rotation; in
          compact mode a strip under it instead. */}
      <div
        className={`media-controls ${node.kind} ${compact ? 'compact' : ''}`}
        style={
          compact
            ? {
                left: centerX - Math.max(width, 260) / 2,
                top: centerY + height / 2 + 8,
                width: Math.max(width, 260),
                transform: `rotate(${node.rotation}deg)`,
                transformOrigin: `50% ${-(height / 2 + 8)}px`,
              }
            : {
                left: centerX - width / 2,
                top: centerY - height / 2,
                width,
                height,
                transform: `rotate(${node.rotation}deg)`,
              }
        }
      >
        {controls}
      </div>
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

/** The scrub bar. Rotation-aware: the pointer is projected onto the bar's
 *  own axis, so seeking works on a turned item too. */
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
  const track = useRef<HTMLDivElement>(null);
  const fractionAt = (event: React.PointerEvent) => {
    const element = track.current;
    if (!element) return 0;
    const rect = element.getBoundingClientRect();
    const radians = (rotation * Math.PI) / 180;
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const along = dx * Math.cos(radians) + dy * Math.sin(radians);
    return along / element.offsetWidth + 0.5;
  };
  return (
    <div
      ref={track}
      className="media-track"
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        onScrub(true);
        onSeek(fractionAt(event));
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) onSeek(fractionAt(event));
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        onScrub(false);
      }}
      onPointerCancel={() => onScrub(false)}
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
