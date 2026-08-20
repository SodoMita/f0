# Trace plates

Front-facing flat icons. The tracer is **not** hand fans:
`scripts/trace-2d-glb.py` runs

  PNG → ImageMagick quantize → pixel-boundary loops → RDP → earcut

so each colour owns disjoint pixels and every triangle sits at z=0.
Stacked z-offsets (the previous source of z-fighting) are forbidden.

Traced: smile, heart, star, house, check, lock.

The source PNGs are **not** committed (they were ~4.4 MiB of build input for
already-committed GLBs — the repo stays small). To re-trace a plate, drop a
flat-colour PNG named `<id>.png` into this directory and run
`python3 scripts/trace-2d-glb.py`; it writes `<id>.glb` to `../2d/`.
