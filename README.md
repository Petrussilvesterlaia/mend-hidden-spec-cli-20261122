# mend-hidden-spec-cli-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Petrussilvesterlaia/mend-hidden-spec-cli-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Petrussilvesterlaia/mend-hidden-spec-cli-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in all four
formats they write them in: unified diffs (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON.
It finds the lines an edit names even when the model drifted their whitespace or
indentation, and it changes every file or none: a failed edit reports its failure
and nothing is written. See SPEC.md for the full specification.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-` (or nothing) to read the patch from standard
input. Node 22 and its standard library alone; nothing is installed.

```sh
node main.ts fix.patch            # apply a unified diff
node main.ts --format=v4a - < patch.txt
node main.ts --check fix.patch    # same output and exit code, writes nothing
node main.ts --strict fix.patch   # match lines exactly, no fuzzy tiers
```

Exit 0 applies the patch and lists what changed (`A`, `D`, `M`, or `R old -> new`
per path, then `ok: N files`). Exit 1 lists one `error: <code> <path>` line per
failed edit and `failed: K of N edits`, and writes nothing. Exit 2 is a usage,
missing-patch, format, or parse error, with exactly one `error:` line.

## Files

- `main.ts` — the CLI: the command line, the output and exit codes, safe paths,
  format detection, and the four readers (unified, SEARCH/REPLACE, V4A, JSON)
  with three-tier line matching and the all-or-nothing write.
- `runner.ts` — the kit's trial runner, kept as it is: in a trial it reads the
  checks from the environment and runs `main.ts` on each one.
- `check.ts` — the practice set on your own machine:
  `node check.ts ../program/generator/practice.json` (100 checks, practice
  score 1000 here).
- `SPEC.md` — the specification this tool implements, sentence by sentence.
- `LICENSE` — MIT.

## How it works

Every check runs `node main.ts` once in a fresh directory. The patch is read in
its format (`--format` names one, or `auto` detects it), parsed into edits, and
the edits apply in order to the tree as earlier edits left it. Old lines are
found at the first of three tiers where they occur: exact, trailing whitespace
ignored, then leading and trailing whitespace ignored with new lines re-indented
to the file's own indentation. A unified hunk takes the occurrence nearest its
stated line number; a SEARCH/REPLACE block fails as ambiguous when its old lines
occur more than once; a V4A chunk follows its anchor and a cursor through the
file. Paths are checked for safety before anything else, and a file whose bytes
after the patch equal its bytes before it is not listed.

---

<sub>Entered on [make.fun](https://make.fun/?ref=dr95t7s8&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
