import type { Container, Texture } from 'pixi.js';
import type { BoardNode } from './types';

export type RenderFrame = {
  texture?: Texture;
  grayscale?: boolean;
};

export interface NodeRenderer {
  mount(parent: Container): void;
  sync(node: BoardNode, frame: RenderFrame): void;
  /** Board-wide grayscale toggle, applied to already-mounted renderers. */
  setGrayscale(enabled: boolean): void;
  destroy(): void;
}
