# AI configuration regression checks

The unit suite uses synthetic endpoints and credentials with the real dotenv,
environment and label/usage parsers. It does not read the deployment's private
environment file, call models, or certify current provider health. Missing
providers, orphaned backup labels, small reasoning budgets and differently named
labels sharing one configured endpoint/key are tested as explicit counterexamples.

For a separate configuration review, run the TypeScript script
[check-ai-config.mts](../scripts/check-ai-config.mts) with an explicit `--env`
argument naming the intended candidate file. Without that argument it exits with
status 2. It never infers the input from the working directory. JSON output contains
only issue codes; credentials and configuration contents are not printed.

The audit retains the historical reasoning-usage budgets and account fallback
policy as review checks. It does not impose those budgets on every model call:
the bounded life-project driver deliberately has a separate maximum of 1200
output tokens. Distinct configured credentials are also not proof of distinct
upstream billing quotas. Local unauthenticated providers or a deployment which
intentionally shares an account may require a documented operator decision.

Exit 0 means the selected configuration passes these checks; exit 1 means a
configuration issue or invalid input. Runtime availability, rate limits and model
quality require separate evidence.
