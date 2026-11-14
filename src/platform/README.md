# Platform boundary

This module contains pure codecs and identity references. It does not connect to QQ,
create a bot, enqueue a legacy ChatJob, or send a message. No QQ account is enabled by
importing it.

Conversation identity includes platform, accountId, idNamespace, conversationKind,
opaque id and optional threadId. Use conversationKey/messageKey/userKey for new
storage keys; tuple encoding prevents delimiter collisions. QQ numbers and official
OpenIDs remain different namespaces. No implicit identity binding is performed.

The OneBot v11 codec handles message events, typed segments and CQ strings. Outbound
support is intentionally limited to group/private text, group mentions and quoted
replies. Media is retained as an opaque incoming asset reference. Unsupported
outbound segments/actions fail explicitly. Numeric API IDs are checked before
conversion; strings larger than JavaScript's safe integer range are never rounded.

Telegram compatibility helpers preserve legacy chat signs and topic IDs. The reverse
adapter rejects QQ references. The existing pipeline's numeric chatId and Telegram
sender remain unchanged; this module is not evidence that live QQ chat works.

To integrate a future transport, pass its event to PlatformAdapterCodec.normalize,
route the resulting NormalizedMessage through a shared core keyed by ConversationRef,
then pass a PlatformAction through encode and execute the returned command in that
same account's transport. The shared core must not call Telegram APIs for QQ refs.
Add an opt-in configuration and per-conversation access policy before attaching any
live transport. QQ official support currently consists only of opaque identity
constructors, not authentication or an OpenAPI transport.

Offline verification from the repository root:

```sh
node --import tsx tests/unit/platform/codec-demo.mts
npx vitest run tests/unit/platform
```
