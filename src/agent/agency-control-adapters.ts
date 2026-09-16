// Explicit Agency control adapters. Each host callback owns the actual
// persistence or control-plane operation; these factories only enforce scope,
// action shape, budget accounting and receipt contracts.

import { validateAgencyAction } from './agency.js';
import type { AgencyAction } from './agency.js';
import type { AgencyAdapter, AgencyAdapters, AgencyAdapterContext } from './agency-runtime.js';
import type { CognitiveScope } from '../shared/cognitive-scope.js';

interface AgencyControlRequestBase {
  chatId: number;
  scope: CognitiveScope;
  runId: string;
  attempt: number;
  correlationId: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface AgencyObserveRequest extends AgencyControlRequestBase {
  target: string;
  args?: Record<string, unknown>;
}

export interface AgencyObserveResult {
  data: unknown;
}

export type AgencyObserve = (request: AgencyObserveRequest) => Promise<AgencyObserveResult>;

export interface AgencyRememberRequest extends AgencyControlRequestBase {
  fact: string;
}

export interface AgencyRememberResult {
  memoryId: string;
}

export type AgencyRemember = (request: AgencyRememberRequest) => Promise<AgencyRememberResult>;

export interface AgencyCorrectRequest extends AgencyControlRequestBase {
  debtId: number;
  resolution: string;
}

export interface AgencyCorrectResult {
  resolved: boolean;
  resolutionEventId: string;
}

export type AgencyCorrect = (request: AgencyCorrectRequest) => Promise<AgencyCorrectResult>;

export interface AgencyStopRequest extends AgencyControlRequestBase {
  reason: string;
}

export interface AgencyStopResult {
  stoppedAt: number;
  stopId?: string;
}

export type AgencyStop = (request: AgencyStopRequest) => Promise<AgencyStopResult>;

function scopedChatId(context: AgencyAdapterContext): number {
  const chatId = context.scope.chatId;
  if (context.scope.visibility === 'global' || chatId === undefined || !Number.isSafeInteger(chatId) || chatId === 0) {
    throw new Error('control adapter requires a scoped chat');
  }
  return chatId;
}

function checkedAction<T extends AgencyAction['type']>(action: AgencyAction, type: T): Extract<AgencyAction, { type: T }> {
  const checked = validateAgencyAction(action);
  if (!checked.ok || !checked.action || checked.action.type !== type) {
    throw new Error(`control adapter action mismatch: expected ${type}`);
  }
  return checked.action as Extract<AgencyAction, { type: T }>;
}

function controlRequest(context: AgencyAdapterContext, chatId: number): AgencyControlRequestBase {
  if (context.signal.aborted) throw new Error('agency run cancelled');
  return {
    chatId,
    scope: context.scope,
    runId: context.runId,
    attempt: context.attempt,
    correlationId: context.correlationId,
    idempotencyKey: context.idempotencyKey,
    signal: context.signal,
  };
}

function checkedTextId(value: unknown, error: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 240) throw new Error(error);
  return value.trim();
}

function observeAdapter(observe: AgencyObserve): AgencyAdapter {
  return async (rawAction, context) => {
    const action = checkedAction(rawAction, 'observe');
    const chatId = scopedChatId(context);
    const base = controlRequest(context, chatId);
    context.usage.consumeToolCall();
    const result = await observe({
      ...base,
      target: action.target,
      ...(action.args ? { args: action.args } : {}),
    });
    if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.prototype.hasOwnProperty.call(result, 'data')) {
      throw new Error('invalid observation receipt');
    }
    return { data: result.data };
  };
}

function rememberAdapter(remember: AgencyRemember): AgencyAdapter {
  return async (rawAction, context) => {
    const action = checkedAction(rawAction, 'remember');
    const chatId = scopedChatId(context);
    const base = controlRequest(context, chatId);
    context.usage.consumeToolCall();
    const result = await remember({ ...base, fact: action.fact });
    return { memoryId: checkedTextId(result?.memoryId, 'invalid memory receipt') };
  };
}

function correctAdapter(correct: AgencyCorrect): AgencyAdapter {
  return async (rawAction, context) => {
    const action = checkedAction(rawAction, 'correct');
    const chatId = scopedChatId(context);
    const base = controlRequest(context, chatId);
    context.usage.consumeToolCall();
    const result = await correct({ ...base, debtId: action.debtId, resolution: action.resolution });
    if (!result || result.resolved !== true) throw new Error('correction was not accepted');
    return {
      resolved: true,
      resolutionEventId: checkedTextId(result.resolutionEventId, 'invalid correction receipt'),
    };
  };
}

function stopAdapter(stop: AgencyStop): AgencyAdapter {
  return async (rawAction, context) => {
    const action = checkedAction(rawAction, 'stop');
    const chatId = scopedChatId(context);
    const base = controlRequest(context, chatId);
    context.usage.consumeToolCall();
    const result = await stop({ ...base, reason: action.reason });
    if (!result || !Number.isSafeInteger(result.stoppedAt) || result.stoppedAt <= 0) {
      throw new Error('invalid stop receipt');
    }
    if (result.stopId !== undefined && (typeof result.stopId !== 'string' || !result.stopId.trim() || result.stopId.length > 240)) {
      throw new Error('invalid stop id');
    }
    return {
      stoppedAt: result.stoppedAt,
      ...(result.stopId !== undefined ? { stopId: result.stopId.trim() } : {}),
    };
  };
}

export function createAgencyObserveAdapters(observe: AgencyObserve): Pick<AgencyAdapters, 'observe'> {
  return { observe: observeAdapter(observe) };
}

export function createAgencyRememberAdapters(remember: AgencyRemember): Pick<AgencyAdapters, 'remember'> {
  return { remember: rememberAdapter(remember) };
}

export function createAgencyCorrectAdapters(correct: AgencyCorrect): Pick<AgencyAdapters, 'correct'> {
  return { correct: correctAdapter(correct) };
}

export function createAgencyStopAdapters(stop: AgencyStop): Pick<AgencyAdapters, 'stop'> {
  return { stop: stopAdapter(stop) };
}
