# Branch integration — 2026-10-26

Working branch: `arena/3fe72d58-f0` (forked from `main` @ `53b2d51`,
"Merge pull request #85").

The sandbox clone was **shallow and had a narrow fetch refspec**
(`refs/heads/main` + this session's branch only), so `git branch -r` initially
showed just `origin/main`. Both were corrected before merging:

```sh
git fetch origin --unshallow
git fetch origin '+refs/heads/*:refs/remotes/origin/*' --prune
```

With full history, 16 remote branches had commits that were not ancestors of
`main`. "Ahead" is **not** the same as "unmerged work": most of those branches
are old PR tips whose fixes were later ported onto `main` by PRs #51, #84 and
#85. Their trees are months older than `main`; a naive three-way merge would
reintroduce the pre-port code and delete newer features. Each branch below was
therefore merged with a deliberate strategy.

## Real merges (content landed here)

| Branch | What landed | Notes |
|---|---|---|
| `arena/cafa7829-f0` | Live previews fall back to auto-fit when an authored camera frames nothing (`previewPool.ts`, exported `cameraFramesBox`). | Clean descendant of `main`; the newest unmerged fix (2026-10-09). |
| `arena/01a01dfa-f0` | `connect-src 'self'` for same-origin Draco decoder XHRs on plain-HTTP hosts, clearer decoder import names, and `scripts/verify-draco.mjs` (encode→decode round-trip + CSP assertion). | Conflicts in `csp.ts`, `docs/SPEC.md`, `package.json` resolved in favour of `main`'s newer policy/docs, then re-applied the fix. Recorded as SPEC AMENDMENT 99 (the branch's "AMENDMENT 67" number was already taken). The guard now runs in `check:unit`. |
| `arena/01a0117b-f0` | Object-first UI concept mockups under `mockups/`. | Additive design studies; production scenes untouched. |
| `arena/01a01434-f0` | Interactive Aero Wire concept boards (`mockups/ui-v2.css` + reworked pages). | Descendant of `01a0117b-f0`; merged after it. |
| `arena/01a04cbc-f0` | `cloud-textures/` studies + `luanti-mods/sky/` mod. | Additive, standalone assets; no browser bundle or site code touched. |

## Recorded merges (work already on `main`)

These branch tips are recorded as merged with `git merge -s ours`, which keeps
the current tree byte-for-byte. The equivalent `main` commit(s) are listed so
the decision is auditable. Re-applying the old patches would have rolled back
newer code.

| Branch | Why it is not re-applied | Landed on `main` as |
|---|---|---|
| `arena/01a01d04-f0` | Embedded/positional post audio was ported onto `main`'s Babylon `Sound` stack; the branch uses the older `audio/player.ts` + WebAudio pose API. `main` also derives listener rotation from the active camera in `audio/spatial.ts`. | `e0f1b42`, `4267f64` |
| `arena/01a01df8-f0` | Selectable/copyable error text and its unit suite already exist. | `059a678`, `fe5fa91`, `ba30067` |
| `arena/01a01eb4-f0` | Incremental paint GPU upload (`appendNew`, `lastFlushedStampCount`) is already present verbatim. | `ebc3d28` |
| `arena/01a023bb-f0` | Dead-export cleanup was ported; the branch's settings-schema compaction predates newer settings and would remove live controls. | `cf0fd82` |
| `arena/01a025ef-f0` | Export-review card dials, model name, per-attribute Draco bits and full encoder ranges were superseded by PR #52 / SPEC AMENDMENTS 93–94. | `d8a47bf` |
| `arena/01a02667-f0` | 3D board/thread clip-plane fix was ported, then hardened by the audit batch. | `065a101`, `b86c4d7` |
| `arena/01a0266f-f0` | `previewPool` RTT `hasAlpha` + `samples=1` fix was ported. | `3b38dc3` |
| `fix/direct-3d-cards` | Closed PR #38 fixes were absorbed into the direct-3D pool and re-verified by the audit. | `73368bf`, `bdf4eaf` |

## Deliberately excluded trees (recorded, not applied)

| Branch | Why |
|---|---|
| `site` | Single "site build" commit with an **unrelated root**: it contains only a generated standalone HTML snapshot, and its tree deletes all 276 source files. Deploy is automatic from `main` via `.github/workflows/deploy-pages.yml`; merging the artifact into source would break the site. |
| `salvage/dev-rewrite` | The 2026-08-17 force-push incident's rewritten root (see AGENTS.md). It is a historical rescue snapshot, three commits with an unrelated root; its fixes landed on `main` long ago. |

## Verification

- `bun run check` (static + unit + all 5 browser suites) passed on the
  `main` baseline **and on the fully merged tree**.
- `bun run check:unit` passes with `verify-draco.mjs` and
  `workflow-unit.mjs` registered (18 unit files).
- `node audit/recheck.mjs` re-measured all 30 findings from issue #83 against
  the offline rig after the merges: **30 pass, 0 fail, 0 skipped**.
- Nine area-specific browser probes also passed: `settings`, `transfer`,
  `network-panel`, `interact`, `orient`, `overflow-scan`, `zoom`, `shaders`,
  `perf`.
- `form-zero-standalone.html` boots from `file://` with a canvas and no page
  errors; Pages itself is correctly configured as `build_type: workflow`
  (`gh api repos/SodoMita/f0/pages`).
