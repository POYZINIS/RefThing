import { MIN_SCREEN_SIZE_PX } from '@/components/interactionConstants';
import { GifTextureSource } from './GifTextureSource';
import type { NodeRenderer } from './NodeRenderer';
import { PyramidTextureSource } from './PyramidTextureSource';
import { SpriteRenderer } from './SpriteRenderer';
import type { TextureSource } from './TextureSource';
import type { NodeCapabilities, NodeKind } from './types';

export type TextureSourceDeps = {
  onChange: () => void;
  /** Static-pyramid fallback for animated kinds whose decode fails. */
  fallback?: TextureSource;
};

export type NodeKindRegistration = {
  rendererFactory: () => NodeRenderer;
  textureSourceFactory: (deps: TextureSourceDeps) => TextureSource;
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
  note: {
    // Notes render through the DOM NoteOverlay, not the canvas (Phase 2
    // territory); the registry entry exists so note geometry/capabilities
    // already ride the node model.
    rendererFactory: (): NodeRenderer => {
      throw new Error('note nodes render through the DOM overlay, not the canvas');
    },
    textureSourceFactory: (): TextureSource => {
      throw new Error('note nodes have no texture source');
    },
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
    },
  },
} satisfies Record<NodeKind, NodeKindRegistration>;
