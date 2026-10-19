# RefThing — design system

Adapted from `ui-design.md` (a reading app) to a reference
board. The reading app gives the document nearly the whole window and a few soft
floating controls handle the rest; RefThing does the same with the board.
Source of truth for values: `frontend/src/index.css` (tokens) and
`frontend/src/ui/Icon.tsx` (icons).

## Principles

1. **The board dominates.** Full-bleed canvas; chrome floats over it and
   passes the pointer through its empty space.
2. **A clean board.** At rest there is no chrome at all. The two corner
   groups — board and appearance top left, window controls top right
   (desktop) — fade out until the pointer comes within 56px of them (in 150ms; out in
   100ms after a 90ms grace), and
   stay up while one of their panels is open or they hold keyboard focus.
   Nothing reveals mid-drag. The only uninvited chrome: a status line
   (bottom centre) while something is working, and a filter pill (top
   centre) while a search filter holds.
3. **Progressive disclosure.** Search opens from the context menu
   (Search…, or Ctrl+F) where it was asked for; board lists and settings
   open beside the control that opened them.
4. **No chrome for gestures.** Per the interaction conventions, pan, zoom
   and fit stay gestures; wheel zoom speed is a setting (Settings → Mouse).
5. **Content keeps its colours.** Themes change the chrome and the
   workspace, never images, file cards or a note's chosen colours. The one
   theme-aware piece of content is an unstyled note: with no fill it is
   text only, in the theme's flipped text colour, so it reads as a label on
   the board.

## Palette

| Token | Light | Dark |
|:--|:--|:--|
| Workspace `--color-canvas` | `#e3e9f3` pale blue-gray | `#1c2029` deep blue-slate |
| Text `--color-text` | `#2f3b52` | `#cfd8e6` |
| Accent `--color-accent` | `#3d6fb6` clear blue | `#8fb4ec` light blue |
| Muted text | `#56625b` | `#a7b1a9` |
| Danger | `#b3483e` | `#e0877c` |
| Snap guide | `#c2457f` | `#e98fbd` |

The accent marks selection, focus, pressed state and primary actions only.
Selection outlines, hover outlines and the box-select rectangle all read
`--color-accent`, so they follow the theme.

## Materials and depth

- **Glass** comes from GlassKit (`@jungherz-de/glasskit`, imported first
  in `index.css`; its `--gl-*` tokens follow our `data-theme`). A panel is
  a thin tint (`--gl-surface-1` light / `--gl-surface-3` dark) over
  GlassKit's readability scrim (`--gl-state-scrim`), a luminous rim
  (`--gl-border-*`), its bright top edge (`--gl-inset-strong`) and a real
  blur of the board (`--gl-blur`, 24px) with saturation (1.6).
- **Raised** (floating groups): that glass, soft opposing shadows (light
  top-left, dark bottom-right).
- **Floating** (popovers, menus, sheets, toasts): the same glass, a deeper
  drop shadow; sheets blur heavier (`--gl-blur-heavy`).
- **Recessed** (fields, the opening target): inset shadows, no border.
- **Every neumorphic shadow and highlight sits at 45°** (equal x and y
  offsets): light from the top-left, shadow to the bottom-right — raised,
  floating, recessed, the colour tools and the palettes' dip alike.
- **Glass off** swaps every translucent panel for a solid raised surface.
- **Workspace**: flat colour, a faint top sheen and a static grain overlay
  (breaks up banding). On desktop with glass on, the workspace is partly
  transparent over Windows Acrylic — a live blur of whatever is behind the
  window (Settings → Background opacity, 55% by default).

## Geometry

Radii repeat at four scales: 7px icon buttons, 12px control groups and
menus, 14px popovers and sheets, 17px the opening target. Icon buttons are
32×30 (window buttons 39 wide); icons 17px.

## Type

Segoe UI, Arial, sans-serif. 11–13px for labels, 15px for sheet titles and
the opening target. Numbers that change in place (zoom, counts) use tabular
figures.

## Icons

Lucide (`lucide-react`), through one component (`ui/Icon.tsx`) that maps
job names (`close`, `addFiles`, `loop`…) to glyphs: 1.75 stroke,
`currentColor`, 17px by default. The rotate cursor is Lucide's rotate-cw
(white over a dark outline). No icon font, no emoji or glyph stand-ins.

## Colour tools

The colour wheel is chrome glass on the board: the theme's panel tint at
76% (`--tool-bg`), its rim and top sheen, the theme's text; its controls
are chrome fields (`--field-bg`, 0.28×height radius) — a harmony picker
(our menu, the right-click menu's look) with a Lucide chevron, an HSV|HSL switch whose raised side slides, and
Random as the Lucide dice. Unselected, the canvas paints that tint over
the board; live (the lone selection), the canvas picture is hidden and
the DOM panel adds the real blur and a lift, easing in (220ms). Both
faces share `color/wheelLayout.ts`, so they match pixel for pixel.
Zoomed out (under 300px wide on screen) it drops its text and buttons and
its handles become 3.5px dots.

Depth is the chrome's neumorphism, in the wheel's em so it scales with
the item, and it is only ever dipped or plateaued: nothing lights the
inside top of a colour tool (no glass sheen on the wheel, no inner
highlight on any strip — that's claymorphism). The wheel's colours stay
flat (colour accuracy) and their depth is all outside them: the disc,
the brightness slider, the palette strips and Random are raised, a
shadow down-right and a highlight up-left (`--tool-hi`, brighter than
the chrome's, which vanished on the glass; the disc has a second, wider
one). The harmony field and the switch are recessed wells, the switch's
chosen side raised in it. The selection and hover outlines follow the
tools' own rounded corners.

Unselected, the canvas paints the wheel as the same glass without the
blur. Selecting it blurs the board behind in (320ms); deselecting (or
zooming far out) blurs it back out (240ms, the controls already
inert) before the canvas picture takes over. No drop shadow either way.

Palettes dropped on the board are the one dipped exception: shaded over
their colours at 45° — a shadow along the inner top-left in multiply,
light along the inner bottom-right in lighten — so dark swatches aren't
crushed and light ones aren't washed out.

Palettes are the wheel's palette strip on its own: contiguous swatches
in one strip (radius 0.14×height), 7:9 swatches, nothing printed on
them; a hovered swatch's hex shows in a small glass tip above it.

Motion (colour tools only; the board itself never animates): handles
glide to a new harmony, Random or undo (260ms, hue the short way), the
slider thumb and swatches follow; a hovered swatch lifts out of the
strip, a copied one pulses; a newly saved palette slides into the
library; the dice tumbles; a palette being dragged out is tilted.

## Board text

Every string the app lays out itself — note text, file/media cards
(filename, detail line, extension badge) — goes through pretext
(`@chenglou/pretext`): line breaking, measuring, ellipsizing and fitting;
the canvas only paints the lines pretext produced. Chrome text is HTML and
laid out by the browser.

## States

- Hover: soft background (`--hover-bg`) and stronger text.
- Keyboard focus: 2px accent outline.
- Pressed/on (toggles, open popovers, the pin): accent text, accent tint,
  inset shadow.
- Disabled: 28% opacity.
- Destructive confirmations happen inline (the row turns into a short
  question with a safe default), never in a separate modal.

## Motion

Chrome only (`ui/motion.ts`): menus and popovers pop in (120ms), sheets and
toasts rise (180ms); hover transitions 140ms. The board and the selection
shell never animate. Reduced motion removes it all.

## Added things

New things arrive sized to the camera, never to the world: a dropped file
shows at its natural pixels on screen (at most 80% of the view), a new
note at the same on-screen size and text, whatever the zoom.

## Layout at small sizes

Below 760px the corner groups share one wrapping row; below 500px spacing
tightens. Devices without hover (touch) always show the corner groups.
