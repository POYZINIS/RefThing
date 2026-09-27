import { ColorMatrixFilter, type Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { NodeRenderer, RenderFrame } from './NodeRenderer';
import type { BoardNode } from './types';

export class SpriteRenderer implements NodeRenderer {
  private sprite: Sprite | null = null;
  private grayscale = false;
  /** Cropped view of the current texture (§5B Crop), rebuilt on change. */
  private cropped: { base: Texture; key: string; texture: Texture } | null = null;

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
    if (frame.texture) sprite.texture = this.croppedTexture(frame.texture, node.crop);
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

  currentImage(): CanvasImageSource | null {
    const resource = this.sprite?.texture.source.resource as unknown;
    return resource instanceof ImageBitmap ||
      resource instanceof HTMLCanvasElement ||
      resource instanceof HTMLImageElement ||
      resource instanceof HTMLVideoElement ||
      (typeof OffscreenCanvas !== 'undefined' && resource instanceof OffscreenCanvas)
      ? (resource as CanvasImageSource)
      : null;
  }

  paintedBounds(): { x: number; y: number; width: number; height: number } | null {
    if (!this.sprite) return null;
    // A hidden node (drawn by DOM meanwhile) still reports where it sits.
    const visible = this.sprite.visible;
    this.sprite.visible = true;
    const bounds = this.sprite.getBounds();
    this.sprite.visible = visible;
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }

  /** A sub-texture showing only the node's crop of `base` (same GPU source,
   *  different frame); the base itself when uncropped. */
  private croppedTexture(base: Texture, crop: BoardNode['crop']): Texture {
    if (crop.x <= 0 && crop.y <= 0 && crop.w >= 1 && crop.h >= 1) return base;
    const key = `${crop.x},${crop.y},${crop.w},${crop.h}`;
    if (this.cropped?.base === base && this.cropped.key === key) return this.cropped.texture;
    this.cropped?.texture.destroy(false);
    const { frame } = base;
    const texture = new Texture({
      source: base.source,
      frame: new Rectangle(
        frame.x + crop.x * frame.width,
        frame.y + crop.y * frame.height,
        Math.max(1, crop.w * frame.width),
        Math.max(1, crop.h * frame.height),
      ),
    });
    this.cropped = { base, key, texture };
    return texture;
  }

  destroy(): void {
    this.cropped?.texture.destroy(false);
    this.cropped = null;
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
