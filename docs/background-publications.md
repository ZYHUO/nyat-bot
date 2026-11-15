# Background checks and publication

`BACKGROUND_PUBLICATION_ENABLED` defaults off. With it enabled, the existing
unified-tick goal checks, self-play and nightly dreaming producers register an explicit background
task before enqueue. The task records its platform/account, conversation/topic,
origin, fixed version and owner in migration 0131. Model text such as a goal tag
is not authority. Old periodic queue payloads without a producer record are held.
Foreground tasks keep their existing tools and receipt semantics. This governs
these CodeAct background tasks; it does not disable explicit reminders, weather
reports or every other scheduled notification in the application.

The isolated background guest can read, check and propose a short result. It
cannot directly send text, react, send media, ask Meta to publish a diary, add a
goal, schedule another wake, or ask for a clarification that sends a message.
The actual host applies the same restriction, including calls made outside the
normal guest capability map. The executor has no background typing pulse,
plain-text fallback, completion callback or distiller-created follow-up goal.

The initial evidence adapter accepts only authoritative F13 user-message sources
from the exact task conversation and topic under the current authenticated
account. It rechecks source/event/version relations, complete-body hash,
retraction and observed QQ recall. Bot replies and unknown historical provenance
are rejected. Owner-linked recall does not authorize cross-chat publication.
Evidence handles are host-issued and bound to one check; a model hash or URL is
not a handle. Search/web results and D project artifacts have no publication
adapter in this version, so they remain silent with a suppressed outcome.

The guest protocol is:

1. Read a known local message using `runtime.readPublicationEvidence`.
2. Submit at most one 200-character draft with `runtime.proposePublication` and
   up to three returned handles. The result is `proposed`, with no message ID.
3. End with `finding` to request host review. `no_update`, `no_change`, failure,
   or any other terminal summary produces no publication.

The host requires a still-valid new body version since the producer's previous
check time. Backfilling old messages and no-op edits do not manufacture change.
A previously sending, sent or uncertain evidence fingerprint or identical text
is not sent again for that origin. This verifies source/version provenance; it
does not independently prove every sentence of the model's interpretation.

Checking and notification budgets are separate. The producer retains its check
interval/cooldown but does not debit the notification coordinator. Publication
uses the existing proactive activation/coordinator and a durable per-chat hourly
attempt bound, using the configured proactive limit clamped to 1–10 (default 1
when unavailable). A check gets at most one publication. Origin, cancellation,
source versions and the fixed owner/version are checked again at the sender's
actual API boundary, including split/retry preparation.

The durable proposal moves from proposed to sending before an external call.
Only real `DeliveryResult` ACK parts become delivery history. A partial ACK is
retained as fact and holds the whole publication as unknown, even if the tail
was explicitly rejected. A sending/unknown result and a crashed running check
are never automatically reclaimed or replayed. Reconciliation is required;
these tables are not an exactly-once claim about an external platform.
Cancellation cannot retract a request already accepted by that platform.

The host cancellation API is `cancelBackgroundTask`; goal cancellation or a new
goal-check generation also invalidates its captured origin. The fixed claim is
rechecked between model/tool awaits to stop further check iterations after
cancellation. Changing the configured owner revokes queued self-play/dreaming
publication to the old owner. This does not claim
to interpret every natural-language cancellation of autonomous work. Closed
receipts remain in SQLite even if context/vector bookkeeping fails; the stored
reason identifies pending bookkeeping without resending the message.

Validation uses real SQLite, the actual periodic producer and CodeAct host/
executor paths with synthetic models, a simulated isolated guest driver and
intercepted message transports. It
does not send real messages or establish production model answer quality.
