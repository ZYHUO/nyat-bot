import type { Game } from './manager.js';

export function createGuessNumberGame(): Game {
  const target = Math.floor(Math.random() * 100) + 1;
  let attempts = 0;
  let winner: number | null = null;

  return {
    name: '猜数字 (1-100)',
    play(uid: number, text: string): string | null {
      const num = parseInt(text.trim(), 10);
      if (isNaN(num) || num < 1 || num > 100) return null;
      attempts++;
      if (num === target) {
        winner = uid;
        return `🎉 恭喜！答案就是 ${target}，你用了 ${attempts} 次猜中！`;
      }
      return num > target ? `📉 ${num} 大了~` : `📈 ${num} 小了~`;
    },
    isOver() { return winner !== null; },
    summary() { return winner ? `答案是 ${target}` : `答案是 ${target}，没人猜中~`; },
  };
}
