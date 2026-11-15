/** Platform-neutral references never infer chat kind from the sign of an ID. */
export type Platform = 'telegram' | 'qq';
export type IdNamespace = 'telegram' | 'qq-number' | 'qq-openid';
export type ConversationKind = 'private' | 'group';

export interface AccountRef {
  platform: Platform;
  accountId: string;
  idNamespace: IdNamespace;
}

export interface ConversationRef extends AccountRef {
  conversationKind: ConversationKind;
  id: string;
  /** Telegram topic or another platform's explicit sub-conversation, if present. */
  threadId?: string;
}

export interface UserRef extends AccountRef {
  id: string;
}

export interface MessageRef {
  conversation: ConversationRef;
  id: string;
}

export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; user: UserRef }
  | { type: 'mention-all' }
  | { type: 'reply'; message: MessageRef }
  // Media is an opaque platform asset reference, never a local path to open.
  | { type: 'image' | 'voice' | 'video' | 'file'; assetRef: string;
      url?: string; fileName?: string; fileSize?: number; mimeType?: string }
  | { type: 'unsupported'; platformType: string };

export interface NormalizedMessage {
  ref: MessageRef;
  sender: UserRef;
  senderName?: string;
  /** Unix milliseconds. */
  timestampMs: number;
  segments: readonly MessageSegment[];
}

export type PlatformAction =
  | { action: 'send'; conversation: ConversationRef; segments: readonly MessageSegment[] }
  | { action: 'delete'; message: MessageRef }
  | { action: 'react'; message: MessageRef; reaction: string };

export interface PlatformCapabilities {
  inboundSegments: readonly MessageSegment['type'][];
  outboundSegments: readonly MessageSegment['type'][];
  actions: readonly PlatformAction['action'][];
}

/** Pure boundary: codecs do not connect, enqueue legacy ChatJobs, or send messages. */
export interface PlatformAdapterCodec<TCommand> {
  readonly account: AccountRef;
  readonly capabilities: PlatformCapabilities;
  normalize(event: unknown): NormalizedMessage | null;
  encode(action: PlatformAction): TCommand;
}

export class PlatformBoundaryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PlatformBoundaryError';
  }
}

export class UnsupportedCapabilityError extends PlatformBoundaryError {
  constructor(capability: string) {
    super('unsupported_capability', `Adapter does not support ${capability}`);
    this.name = 'UnsupportedCapabilityError';
  }
}
