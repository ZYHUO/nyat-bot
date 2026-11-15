import { describe, expect, it } from "vitest";

// The floor guard lives inline in pipeline.ts, whose import graph is too heavy
// to load in a unit test. This mirrors the exact predicate so the *decision*
// stays covered: which slash commands are allowed to skip the floor heuristic.
//
// Keep in sync with src/pipeline/pipeline.ts (`isOwnSlashCommand`).
function isOwnSlashCommand(
  text: string,
  botUsername: string,
): boolean {
  const slashMatch = text.match(/^\s*\/(\w+)(?:@(\w+))?/);
  return Boolean(slashMatch) &&
    (!slashMatch?.[2] || slashMatch[2]!.toLowerCase() === botUsername.toLowerCase());
}

const BOT = "xxb_bot";

describe("floor slash-command guard", () => {
  it("lets our own bare commands skip the floor heuristic", () => {
    for (const text of ["/cards", "/game guess", "/wish", "/checkin", "  /stats"]) {
      expect(isOwnSlashCommand(text, BOT), text).toBe(true);
    }
  });

  it("lets commands explicitly addressed to us skip the floor heuristic", () => {
    expect(isOwnSlashCommand("/cards@xxb_bot", BOT)).toBe(true);
    expect(isOwnSlashCommand("/checkin@XXB_BOT", BOT)).toBe(true);
  });

  it("keeps other bots' commands on the floor path so we never steal them", () => {
    // These belong to AnitaBriso_bot / DickGrowerBot / Music163bot etc. They must
    // keep flowing through the floor heuristic (which yields ambient -> silent),
    // because NyatBot must not answer another bot's command.
    for (const text of [
      "/play@AnitaBriso_bot",
      "/pvp@DickGrowerBot 200",
      "/music@Music163bot 昨日青空",
    ]) {
      expect(isOwnSlashCommand(text, BOT), text).toBe(false);
    }
  });

  it("ignores non-command text and bare slashes", () => {
    expect(isOwnSlashCommand("hello", BOT)).toBe(false);
    expect(isOwnSlashCommand("/", BOT)).toBe(false);
    expect(isOwnSlashCommand("@xxb_bot /cards", BOT)).toBe(false);
    // A command that merely appears mid-text is not an entry command.
    expect(isOwnSlashCommand("看看 /cards 吧", BOT)).toBe(false);
  });
});
