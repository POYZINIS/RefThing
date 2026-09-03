# Onboarding a New Item Type

> **Applies from Phase 11 onward.** Phases 0–10 ship with image items
> only. This checklist is the contract for adding richer item types (3D
> models, web embeds, video, ...) without touching the core engine.

Adding a new item type is a **4-step checklist** — no core engine, schema,
or canvas changes are required:

1. **Backend: implement `ItemTypeHandler`** for the new type (validation,
   metadata extraction, poster-generation hook) and **register** it in the
   handler registry.
2. **Frontend: implement an `ItemRenderer`** for the type. A **poster
   renderer is required**; a **live renderer is optional**. Register it in
   the renderer registry.
3. **Nothing else.** The canvas engine, camera, spatial index, persistence
   schema, and sync protocol are item-type-agnostic. If you find yourself
   editing any of them to add an item type, stop — the handler/renderer
   extension points are incomplete, and that is the bug to fix.
4. **Feature-flag the type if it is experimental.** Unflag only when both
   poster and live paths meet the performance budget (thousands of items
   at 60fps).

## Rendering model: poster mode and live mode

Every item type renders in one of two modes:

- **Poster mode (required).** A static image — generated at import time
  (by the backend, or by the sidecar for Node-only tooling like headless
  three.js GLB snapshots and puppeteer embed screenshots) — that the canvas
  draws like any other texture. Poster mode is what you see while
  panning/zooming, at small sizes, and whenever thousands of items are on
  screen. It is always fast and always available.
- **Live mode (optional).** The rich, interactive rendering (a real 3D
  viewport, a live web embed), entered explicitly — e.g. selecting or
  focusing an item. Live mode is opt-in per item and bounded in how many
  live instances may exist at once.

The rule of thumb: **poster by default, live on demand.** The board's
60fps budget is only guaranteed because the overwhelming majority of
on-screen items are posters.
