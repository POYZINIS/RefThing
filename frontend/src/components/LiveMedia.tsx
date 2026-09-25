import { useEffect, useRef } from 'react';
import { blobUrl } from '@/api/client';
import type { ViewportState } from '@/canvas/BoardCanvas';
import type { SpriteNode } from '@/canvas/nodes/types';

type LiveMediaProps = {
  node: SpriteNode;
  /** The rendered (eased) camera, same as every other overlay. */
  viewport: ViewportState;
  /** Escape or a press outside the player leaves live mode. */
  onExit: () => void;
};

/**
 * Plan Phase 11 live mode: double-clicking a video/audio item mounts a real
 * player over it (the canvas keeps drawing the poster underneath). The
 * selection shell goes inert meanwhile, like note Editing — presses inside
 * the player drive its controls, never a move or resize. The original bytes
 * stream from `/blob/{hash}/full`, which honors Range so seeking works.
 */
export function LiveMedia({ node, viewport, onExit }: LiveMediaProps) {
  const element = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const exit = useRef(onExit);
  exit.current = onExit;

  useEffect(() => {
    const player = element.current;
    player?.focus();
    void player?.play().catch(() => undefined); // autoplay may be refused
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      exit.current();
    };
    const onPress = (event: PointerEvent) => {
      if (player && event.target instanceof Node && player.contains(event.target)) return;
      exit.current();
    };
    // Capture: Escape must not also clear the selection underneath.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPress, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPress, true);
    };
  }, []);

  const width = node.width * viewport.zoom;
  const height = node.height * viewport.zoom;
  const centerX = viewport.x + (node.x + node.width / 2) * viewport.zoom;
  const centerY = viewport.y + (node.y + node.height / 2) * viewport.zoom;
  const common = {
    ref: element,
    className: `live-media live-media--${node.kind}`,
    'data-testid': 'live-media',
    src: blobUrl(node.blobHash, 'full'),
    controls: true,
    autoPlay: true,
    tabIndex: -1,
    onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
    onDoubleClick: (event: React.MouseEvent) => event.stopPropagation(),
  };
  if (node.kind === 'video') {
    return (
      <video
        {...common}
        playsInline
        style={{
          left: centerX - width / 2,
          top: centerY - height / 2,
          width,
          height,
          opacity: node.opacity,
          transform: `rotate(${node.rotation}deg)`,
        }}
      />
    );
  }
  // Audio: the native mini-player, centered on the waveform at a readable
  // size whatever the zoom.
  const playerWidth = Math.max(240, Math.min(width, 640));
  return (
    <audio
      {...common}
      style={{
        left: centerX - playerWidth / 2,
        top: centerY - 27,
        width: playerWidth,
        transform: `rotate(${node.rotation}deg)`,
      }}
    />
  );
}
