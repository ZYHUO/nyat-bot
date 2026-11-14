# Pending reply intent boundaries

`META_PENDING_INTENT_ENABLED` is off by default and applies to the existing
Meta-enabled chat scope. Migration 0129 adds host-owned input state; it does not
add a scheduler, another model call, or a parallel conversation engine.

An Attention lane is bound to platform, authenticated account, conversation,
sender and topic. Same-author supplements update its revision. Another sender
or topic cannot reset its quiet deadline, release its hold, cancel its task, or
answer its pending clarification. This does not grant the owner new powers to
control other people's tasks. The ordinary direct quiet/max windows and QQ
1500/4000 ms pre-Heart batching remain configurable. With the flag enabled,
passive Attention is bounded at max(its quiet window, 4000 ms) per lane.

Short explicit controls such as “等我发完”, “等我贴完再说”, “先别回复” hold that
author's lane before Heart/direct dispatch. Further input stays in the existing
Attention queue. The ordinary maximum quiet deadline and thirty-minute age do
not release that hold. “发完了”/“可以回复了” from the same author/topic releases it
for a fresh decision; “不用了”/“取消” closes it. Merely quoting another person's
message grants no cancellation right. Full linguistic interpretation of every
possible paraphrase is not claimed; these controls are deliberately short and
explicit, with optional verified bot-name prefixes.

Each generated CodeAct task captures an immutable intent ID and revision from
the exact accepted source inputs. A newer supplement, edit, cancellation or
observed QQ recall stops the old draft before a real send. The executor does not
look up a new revision and pretend an old draft used it. Superseded tasks finish
without a failure callback that could cause Meta to publish an unwanted apology.
The fresh input remains eligible for a new task. An awaiting-clarification task
may resume only with its original author's same-topic messages, which are
explicitly injected before a new generation.
It must also belong to the same non-cancelled intent. On the next Attention
batch a cancelled waiting task is retired and its checkpoint/index cleared;
a later new request gets a new task. Model return, guest completion, checkpointing and terminal verification
all recheck the captured revision, including code that only ends or waits and
never sends. Late older Heart results cannot replace the current edit's binding.

Text uses the sender's beforeSend fence before each actual API attempt, shard,
explicitly rejected-format fallback and rate-limit retry. File/photo/voice and
sticker sends check again after preparation/upload. Confirmed delivery prefixes
remain facts even if a correction arrives while an API request is already in
flight. A request already accepted by an external platform cannot be unsent by
a local fence. Unknown delivery remains held and is never blindly retried.
The durable delivery claim is followed by another synchronous fence, covering
reactions too. Promise detection is joined before settlement and rechecks its
source after model work, so a cancelled promise cannot silently create new
autonomous work. A transient final revision read after Attention claims its
queue retains the input for retry instead of dropping it.

Source identity is distinct from intent generation. Repeated originals and
older edits do not advance input state. A genuine newer edit of an answered,
settled message starts a new generation and is not swallowed by the old numeric
message-ID answered marker or quote claim. Editing an earlier answered source
while a new same-author/topic draft runs makes that edit the lane's newest input
and invalidates that draft. A source from an explicitly cancelled intent cannot
be revived by editing; a new message starts a new intent. Retired terminal
metadata preserves this distinction across later generations and restarts.

Wait/defer replay keeps the captured binding and topic; it never reconstructs
provenance from the currently configured bot. Quote-bearing legacy tasks without
that binding are held when the flag is enabled. Rollout must account for those
held tasks; enabling the flag is not authorization to replay them.

The normal queue capacity is still bounded. These changes do not claim semantic
topic splitting for one author posting unrelated tasks in the same topic, or
unlimited preservation of arbitrarily many held messages. Durable raw intake and
memory-source storage remain the authority described in the durable ingress and
memory projection documents. Telegram does not generally emit deletion events;
only observed platform recall information can be checked.

The pre-existing Turn Actor remains in use outside Meta; its cancellation helper
now also requires the obligation's actual author. Its full scheduler is not
replaced by these lanes. Background goal checks still need a distinct verified
change/publication contract: a prompt saying no_update is not a runtime proof of
zero external output. This change does not claim to implement that contract.

Validation uses real SQLite migration 0129, the real Attention and Meta dispatch
paths, actual CodeAct host/executor boundaries, and loopback OneBot WebSocket
intake. Models and message transports are controlled synthetic fixtures; tests
send no user messages and do not establish production model quality.
