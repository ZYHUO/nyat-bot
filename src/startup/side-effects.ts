import type { StartupOwnership } from './ownership.js';

export function shouldRegisterBotCommands(ownership: StartupOwnership): boolean {
  return ownership.botIngress;
}

export function shouldWarmMemory(ownership: StartupOwnership): boolean {
  return ownership.worker || ownership.botIngress || ownership.cron;
}
