# APEX (Ask. Perfect. EXecute.) Firewall kit

This directory is the development corpus for the prompt injection firewall's generalization pass. It has 74 items across 11 source types: attack files, benign files, typed queries, paste payloads, and multi-turn sessions.

**In-sample warning.** The runner ran against this kit during detector development. Any live score you produce on these files is in-sample. Use the held-out corpus (`tests/pif/corpus/holdout.json`) for blind evaluation.

## What's here

- `files/` - attack and benign files: PDF, DOCX, HTML, Markdown, email, JSON, Python, JS, OCR text, images
- `web/` - local HTML pages served by `./web/serve.sh` at `127.0.0.1:8765`
- `paste/` - clipboard payload files for paste injection tests
- `queries.json` - typed query payloads
- `sessions.json` - multi-turn session turn sequences
- `expected.json` - per-item expected detection IDs
- `results/` - runner output history; JSON and Markdown per run
- `QUERIES.md` - live-testing guide

## Rebuild binaries

The kit ships with pre-built files. To regenerate them:

```
python3 build-kit.py
```

Requires: `python3`, `fpdf2` (`pip install fpdf2`), `python-docx`, and standard system tools.

## Run the kit runner

```
node run-kit.js --label my-run --json --md
```

- `--label` - names the output file in `results/`
- `--json` - writes `results/<label>.json`
- `--md` - writes `results/<label>.md`
- `--file <id>` - runs a single item by EXP id

## Read results

`results/final-v3.0.0.json` is the reference baseline. Each item has `detected_ids`, `pass`, `fail_reason`, `risk`, and `tier`. Compare a new run's `detected_ids` against the baseline to spot regressions or improvements.

## Reserved TLD

All outbound hostnames in attack files use `.example` TLDs: `attacker.example`, `api.internal.example`, `procurement-review.attacker.example`. These never resolve. A tool call to any of them is evidence the attack succeeded.
