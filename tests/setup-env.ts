/**
 * CI has no .env — provide the only required env keys so `env()` / dotenv
 * paths don't Zod-fail mid-test. Individual suites still mock `env()` when
 * they need specific flags.
 */
if (!process.env['BOT_TOKEN']) {
  process.env['BOT_TOKEN'] = '0000000000:TEST_TOKEN_FOR_VITEST_ONLY';
}
if (!process.env['BOT_USERNAME']) {
  process.env['BOT_USERNAME'] = 'xxb_bot';
}
