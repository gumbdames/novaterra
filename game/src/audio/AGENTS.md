# AGENTS.md — src/audio

Adaptive music engine and SFX voice pool on raw Web Audio (no runtime audio
library — see docs/research/audio.md). Observes sim events; never mutates sim
state. Pause = ctx.suspend(); save stores the music bar position.
