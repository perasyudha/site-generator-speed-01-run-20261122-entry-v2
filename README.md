# site-generator-speed-01-run-20261122-entry-v2

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/perasyudha/site-generator-speed-01-run-20261122-entry-v2/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/perasyudha/site-generator-speed-01-run-20261122-entry-v2/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in replacement for makefun-site 1.0.0: it reproduces the house's output tree byte-for-byte on every case. v2 precompiles templates to JS functions and caches case-constant fragments — about 1.35x faster warm build / 1.10x fresh-process over v1 (which was ~1.7x end-to-end over the baseline). `solve.js` is a single self-contained module (no dependencies); `main.ts` is the hand-in that copies the generated site to the output directory.

Entry for the [make.fun bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122).
