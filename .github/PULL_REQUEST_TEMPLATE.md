## What this changes

## Which behaviour changes?

Describe the interaction before and after — not just the code path.

- Before:
- After:

## Claims check

This project's whole v1.1 audit cycle existed because seven things were
documented that didn't match what ran. So:

- [ ] Any README or comment claim I'm touching is now true of the running code
- [ ] Any env flag I added is actually read (and tested)
- [ ] No dead switches introduced

## Cost

- [ ] No new LLM calls in the hot path
- [ ] Adds LLM calls — justified above

## How to verify

- [ ] `npm test` passes
- [ ] ran it in a real group, not just unit tests

## Checklist

- [ ] No bot tokens or API keys committed
- [ ] `docs/flag-census.md` regenerated if flags changed
