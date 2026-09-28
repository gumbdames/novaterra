/**
 * NOVATERRA — game-wide constants and the settings seam.
 *
 * This module is intentionally pure (no DOM, no three.js): it is imported by
 * headless tests and by every other module. Keep it that way.
 *
 * PHASE 2 SEAM: user settings — including the optional "Live Muse link"
 * (the player's own API key, stored in localStorage only, never leaving the
 * browser except to the API endpoint) — will live behind a Settings
 * interface defined here. Nothing is implemented in Phase 1; this comment
 * is the reservation, not the feature.
 */

/** Human-facing game title. */
export const GAME_TITLE = 'NOVATERRA' as const;

/** Semantic version of this build (matches game/package.json). */
export const GAME_VERSION = '0.1.0' as const;

/** Short tagline shown under the title on the menu. */
export const GAME_TAGLINE =
  'Build the nation. Command its future.' as const;
