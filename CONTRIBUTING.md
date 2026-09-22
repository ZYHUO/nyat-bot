# Contributing to NyatBot

NyatBot is a Telegram group-chat agent. It's not a command bot — the
behaviour model (pressure / envelope / reflex, send budgets, anti-ad) is the
product, so changes to behaviour need more care than changes to a utility.

## Before you open an issue

Check whether the behaviour you're seeing is intentional by reading
[`docs/flag-census.md`](docs/flag-census.md). There are ~500 env keys and a lot
of behaviour is gated behind one of them. **The flag census fails the build if a
dead switch comes back**, so a flag that exists should do something.

## Reading the code

Six files, about an hour: [`docs/code-tour.md`](docs/code-tour.md). It answers
"where do I start" in order, and each step says what question it answers.

If you want to change **how much** the bot talks, read
[`docs/voice-tuning.md`](docs/voice-tuning.md) first — it is a measured log of what
was tried, what worked, and what didn't. Four numbers come from
`npm run measure:voice`.

## Reporting bugs

Use the **Bug report** template. The two most useful fields are the provider/model
and the non-default flags you set — NyatBot's behaviour varies a lot across those.

**Never paste a bot token or API key.** Redact to `KEY=***`.

## Pull requests

1. Branch from `main`; one logical change per PR.
2. For behaviour changes, describe the interaction you observed before and after.
   "Fixed the anti-ad wiring" is not enough — say what the bot did.
3. Keep the claims honest. If README or a comment says something runs, it should
   actually run. The whole v1.1 audit cycle existed because seven things were
   advertised that didn't match reality.
4. Tests should pass, and if you add a code path with a flag, add a test that
   fails if the flag is dead.

## Adding a provider or tool

Worth a discussion first. The provider pool has send budgets and a specific
ordering, so dropping one in without understanding that tends to regress
behaviour elsewhere.
