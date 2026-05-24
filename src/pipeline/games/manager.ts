export interface Game {
  name: string;
  play(uid: number, text: string): string | null; // null = not a game input
  isOver(): boolean;
  summary(): string;
}

const activeGames = new Map<number, { game: Game; timer: ReturnType<typeof setTimeout> }>();

export function startGame(chatId: number, game: Game, timeoutMs = 300_000, sendFn?: (chatId: number, text: string) => Promise<unknown>): string {
  if (activeGames.has(chatId)) {
    return `🎮 已经有一局「${activeGames.get(chatId)!.game.name}」在进行中，先 /game stop 结束吧~`;
  }
  const timer = setTimeout(() => {
    const entry = activeGames.get(chatId);
    if (entry) {
      activeGames.delete(chatId);
      if (sendFn) {
        sendFn(chatId, `⏰ 游戏「${entry.game.name}」超时结束啦~\n${entry.game.summary()}`).catch(() => {});
      }
    }
  }, timeoutMs);
  timer.unref?.();
  activeGames.set(chatId, { game, timer });
  return `🎮 ${game.name} 开始！`;
}

export function playGame(chatId: number, uid: number, text: string): string | null {
  const entry = activeGames.get(chatId);
  if (!entry) return null;
  const result = entry.game.play(uid, text);
  if (entry.game.isOver()) {
    clearTimeout(entry.timer);
    activeGames.delete(chatId);
  }
  return result;
}

export function stopGame(chatId: number): string | null {
  const entry = activeGames.get(chatId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  activeGames.delete(chatId);
  return `🎮 ${entry.game.name} 已结束。${entry.game.summary()}`;
}

export function hasActiveGame(chatId: number): boolean {
  return activeGames.has(chatId);
}
