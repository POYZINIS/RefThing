import { ColorMatrixFilter, type Container, Sprite } from 'pixi.js';
import type { NodeRenderer, RenderFrame } from './NodeRenderer';
import type { BoardNode } from './types';

export class SpriteRenderer implements NodeRenderer {
  private sprite: Sprite | null = null;
  private grayscale = false;

  mount(parent: Container): void {
    const sprite = new Sprite();
    sprite.anchor.set(0.5);
    sprite.eventMode = 'static';
    // §5: hover over an unselected item body = grab (open hand / four-way
    // move icon), not the default pointer arrow.
    sprite.cursor = 'grab';
    parent.addChild(sprite);
    this.sprite = sprite;
  }

  sync(node: BoardNode, frame: RenderFrame): void {
    const sprite = this.sprite;
    if (!sprite) return;
    if (frame.texture) sprite.texture = frame.texture;
    sprite.position.set(node.x + node.width / 2, node.y + node.height / 2);
    sprite.width = node.width;
    sprite.height = node.height;
    // §3 FLIP: mirror about the node's own center (anchor is 0.5).
    sprite.scale.x = Math.abs(sprite.scale.x) * (node.flipX ? -1 : 1);
    sprite.scale.y = Math.abs(sprite.scale.y) * (node.flipY ? -1 : 1);
    sprite.rotation = (node.rotation * Math.PI) / 180;
    sprite.zIndex = node.zIndex;
    sprite.alpha = node.opacity;
    sprite.visible = !frame.hidden;
    this.applyGrayscale(frame.grayscale ?? false);
  }

  setGrayscale(enabled: boolean): void {
    this.applyGrayscale(enabled);
  }

  paintedBounds(): { x: number; y: number; width: number; height: number } | null {
    if (!this.sprite) return null;
    const bounds = this.sprite.getBounds();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }

  destroy(): void {
    this.sprite?.destroy();
    this.sprite = null;
  }

  private applyGrayscale(enabled: boolean): void {
    if (enabled === this.grayscale) return;
    this.grayscale = enabled;
    const sprite = this.sprite;
    if (!sprite) return;
    if (enabled) {
      const filter = new ColorMatrixFilter();
      filter.grayscale(1, false);
      sprite.filters = [filter];
    } else {
      sprite.filters = [];
    }
  }
}
