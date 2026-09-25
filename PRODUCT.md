# RefThing — product

## What it is

A local-first reference board: thousands of images (plus notes, video,
audio and any file) on one WebGL canvas at 60fps. A faithful clone of
PureRef's interaction model, with better organization (tags, search, saved
views, snapshots) and room for new content types. Desktop app (Tauri) and
browser, one codebase.

## Who uses it, and where

Artists, designers and art directors collecting visual reference while they
work in another tool: a painting app, a 3D package, a layout tool. The board
usually sits beside that tool or on a second monitor, often pinned on top,
glanced at more than operated. Sessions are long; ambient light varies from
a bright studio to a dark room, so both themes matter.

## What success looks like

- The board is the interface. Images get the whole window; the chrome is
  small, quiet and always in the same three places.
- Every common action is a gesture that becomes obvious after one use;
  anything rare is in the right-click menu (see
  `Refthing_interaction_conventions.txt`, which is the specification).
- Opening, dropping and finding reference never costs a detour: drop files
  where they should land, search from anywhere, switch boards in one click.
- It stays fast on huge boards; the chrome never costs frames.

## Constraints

- React owns chrome only; PixiJS owns the canvas (AGENTS.md).
- No toolbar button duplicates a gesture; no tooltips explaining gestures.
- Local data only (`data/`); no accounts, no cloud.

## Voice

Plain, short, specific. Controls name their action ("Add files", "Delete
board"); errors say what happened and what to do next. No marketing copy
in the product.
