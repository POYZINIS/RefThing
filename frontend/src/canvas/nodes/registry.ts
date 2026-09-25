import { MIN_SCREEN_SIZE_PX } from '@/components/interactionConstants';
import { CardTextureSource } from './CardTextureSource';
import { GifTextureSource } from './GifTextureSource';
import type { NodeRenderer } from './NodeRenderer';
import { NoteTextureSource } from './NoteTextureSource';
import { PyramidTextureSource } from './PyramidTextureSource';
import { SpriteRenderer } from './SpriteRenderer';
import type { TextureSource } from './TextureSource';
import type { CanvasNode, NodeCapabilities, NodeKind } from './types';

export type TextureSourceDeps = {
  onChange: () => void;
  /** Static-pyramid fallback for animated kinds whose decode fails. */
  fallback?: TextureSource;
};

export type NodeKindRegistration = {
  rendererFactory: () => NodeRenderer;
  textureSourceFactory: (deps: TextureSourceDeps) => TextureSource<CanvasNode> | TextureSource;
  defaults: { freeTransform: boolean; minSize: number };
  capabilities: NodeCapabilities;
};

const spriteCapabilities: NodeCapabilities = {
  resizable: true,
  rotatable: true,
  // Images are aspect-locked by default; Shift unlocks (§3).
  freeTransform: false,
  groupable: true,
  editable: false,
  flippable: true,
};

export const nodeKindRegistry = {
  image: {
    rendererFactory: () => new SpriteRenderer(),
    textureSourceFactory: (deps: TextureSourceDeps) => new PyramidTextureSource(deps.onChange),
    defaults: { freeTransform: false, minSize: MIN_SCREEN_SIZE_PX },
    capabilities: spriteCapabilities,
  },
  gif: {
    rendererFactory: () => new SpriteRenderer(),
    textureSourceFactory: (deps: TextureSourceDeps) => {
      if (!deps.fallback) throw new Error('gif texture source needs the pyramid fallback');
      return new GifTextureSource(deps.fallback, deps.onChange);
    },
    defaults: { freeTransform: false, minSize: MIN_SCREEN_SIZE_PX },
    capabilities: spriteCapabilities,
  },
  // Phase 11 kinds. Media draw their server-made poster through the image
  // pyramid (clamped to `medium`) and fall back to a card until it exists;
  // files are always cards. Cards carry text, so they don't mirror.
  video: {
    rendererFactory: () => new SpriteRenderer(),
    textureSourceFactory: (deps: TextureSourceDeps) => new PyramidTextureSource(deps.onChange),
    defaults: { freeTransform: false, minSize: MIN_SCREEN_SIZE_PX },
    capabilities: spriteCapabilities,
  },
  audio: {
    rendererFactory: () => new SpriteRenderer(),
    textureSourceFactory: (deps: TextureSourceDeps) => new PyramidTextureSource(deps.onChange),
    defaults: { freeTransform: false, minSize: MIN_SCREEN_SIZE_PX },
    capabilities: { ...spriteCapabilities, flippable: false },
  },
  file: {
    rendererFactory: () => new SpriteRenderer(),
    textureSourceFactory: () => new CardTextureSource(),
    defaults: { freeTransform: false, minSize: MIN_SCREEN_SIZE_PX },
    capabilities: { ...spriteCapabilities, flippable: false },
  },
  note: {
    // Notes are sprites like images — same renderer, same z-order — whose
    // texture is painted from their text. Only Editing uses the DOM.
    rendererFactory: () => new SpriteRenderer(),
    textureSourceFactory: () => new NoteTextureSource(),
    // §4 RULE 5: notes get the same 8-zone shell, but default to free
    // transform (the sanctioned note exception).
    defaults: { freeTransform: true, minSize: MIN_SCREEN_SIZE_PX },
    capabilities: {
      resizable: true,
      rotatable: true,
      freeTransform: true,
      // The notes table has no group_id column yet.
      groupable: false,
      editable: true,
      flippable: false,
    },
  },
} satisfies Record<NodeKind, NodeKindRegistration>;
