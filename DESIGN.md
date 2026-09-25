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
| Workspace `--color-canvas` | `#e9ece9` pale gray-green | `#202322` charcoal-green |
| Text `--color-text` | `#343d38` | `#d0d8d0` |
| Accent `--color-accent` | `#527966` muted green | `#99bba3` light green |
| Muted text | `#56625b` | `#a7b1a9` |
| Danger | `#b3483e` | `#e0877c` |
| Snap guide | `#c2457f` | `#e98fbd` |

The accent marks selection, focus, pressed state and primary actions only.
Selection outlines, hover outlines and the box-select rectangle all read
`--color-accent`, so they follow the theme.

## Materials and depth

- **Raised** (floating groups): translucent panel (`--panel-bg`), 20px
  backdrop blur, soft opposing shadows (light top-left, dark bottom-right).
- **Floating** (popovers, menus, sheets, toasts): same panel, 24px blur,
  a deeper drop shadow.
- **Recessed** (fields, the opening target): inset shadows, no border.
- **Glass off** swaps every translucent panel for a solid raised surface.
- **Workspace**: flat colour, a faint top sheen and a static grain overlay
  (breaks up banding). On desktop with glass on, the workspace is partly
  transparent over Windows Mica (Settings → Background opacity).

## Geometry

Radii repeat at four scales: 7px icon buttons, 12px control groups and
menus, 14px popovers and sheets, 17px the opening target. Icon buttons are
32×30 (window buttons 39 wide); icons 17px.

## Type

Segoe UI, Arial, sans-serif. 11–13px for labels, 15px for sheet titles and
the opening target. Numbers that change in place (zoom, counts) use tabular
figures.

## Icons

Authored inline SVG (`ui/Icon.tsx`): 24-unit viewBox, 1.65 stroke, round
caps and joins, `currentColor`. No icon font, no emoji or glyph stand-ins.

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
