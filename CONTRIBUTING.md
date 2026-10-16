# Contributing to TTTKart

TTTKart is an early open source kart racer. The immediate priorities are brainrot
characters, better gameplay, finishing customization, and a solid experience with
keyboard, gamepad, and phone controls. Bug reports and playtest feedback are useful
contributions too.

The v1 racing flow supports twelve preset racers. The visible custom-racer card and
garage controls are unfinished: the game does not yet connect them to selection,
saved loadouts, or racing. See the [known limitations](README.md#known-limitations)
before working on that area. Section 13 of [SPEC.md](SPEC.md) describes the planned,
partially implemented customization design.

## Report a bug or suggest a change

Search [existing issues](https://github.com/johrmohr/TTTKart/issues) first. For bugs,
include steps to reproduce, what you expected, what happened, and your browser,
operating system, and input method. A screenshot or short clip helps with visual
or driving problems. Remove private information from screenshots and logs.

For substantial features, new characters, or gameplay changes, open an issue to
discuss the approach before investing in a large implementation. Describe what
the change improves for players.

## Work on the code

1. Fork the repository and create a branch with a descriptive name.
2. Follow the [README setup instructions](README.md#run-it), using your fork's clone
   URL. Install dependencies with `npm ci`.
3. Keep each pull request focused on one change. Follow the surrounding JavaScript
   style and use `public/js/config.js` for shared tuning values.
4. Read the relevant module contracts in [SPEC.md](SPEC.md). Keep them and the
   README up to date when behavior or setup changes.
5. Run the checks relevant to your change and play through the affected flow.

Useful checks without a browser:

```bash
node tools/kart-test.mjs
node tools/race-logic-test.mjs
node tools/track-check.mjs
node tools/sim.mjs --all
```

For networking changes, run `node tools/test-net.mjs`. Phone, menu, and full-race
browser checks are listed in the [README](README.md#tests-and-dev-tools); those
scripts currently expect Google Chrome at its default macOS installation path.
Run server-based tests one at a time to avoid port conflicts.

## Open a pull request

Explain the problem, the resulting behavior, and how you checked it. Include
screenshots or a short clip for visible changes, and note checks you could not
run. For gameplay tuning, describe the track, difficulty, racer, and input method
used during playtesting so others can compare the result.

Commit source files and intentional dependency updates, including the lockfile
when dependencies change. Keep installed dependencies, generated certificates,
local configuration, and test output out of commits.

Use original character designs and assets, or material you have permission to
redistribute. Include the source, license, and any required attribution for
third-party material. Contributions are made under the project's [ISC license](LICENSE).

Be respectful and specific in reviews. Small, understandable changes are easier
to discuss, test, and merge.
