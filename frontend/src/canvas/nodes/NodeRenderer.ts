import type { Container, Texture } from 'pixi.js';
import type { BoardNode } from './types';

export type RenderFrame = {
  texture?: Texture;
  grayscale?: boolean;
  /** 0–1 node opacity (notes carry one today). */
  alpha?: number;
  /** Hidden while a DOM surface stands in for it (the note being edited). */
  hidden?: boolean;
};

export interface NodeRenderer {
  mount(parent: Container): void;
  sync(node: BoardNode, frame: RenderFrame): void;
  /** Board-wide grayscale toggle, applied to already-mounted renderers. */
  setGrayscale(enabled: boolean): void;
  /** Painted axis-aligned bounds in canvas-local px (test/debug hook). */
  paintedBounds(): { x: number; y: number; width: number; height: number } | null;
  destroy(): void;
}
