/**
 * Agent Teams 0.2.0 durable shapes, read as their 0.2.1 equivalents.
 *
 * Every reader of these shapes calls in here first, so the rest of the
 * adapter knows only the 0.2.1 forms (docs/agent-teams-design.md「兼容（0.2.0）」).
 * The shapes are log compatibility, not host compatibility: a 0.2.1 host
 * still resumes sessions recorded under 0.2.0, so dropping the 0.2.0 host
 * line alone does not retire this module. It retires when reading
 * 0.2.0-era team logs is given up; then delete this file and its callers
 * (`grep -rn "compat(dsh 0.2.0"`).
 *
 * @module
 */

/** The 0.2.0 mailbox source a target session recorded for a team message. */
interface MailboxSource {
  readonly kind: 'team-message'
  readonly messageId?: unknown
  readonly senderId: string
  readonly senderName: string
}

function mailboxSourceOf(source: unknown): MailboxSource | undefined {
  const shape = source as { kind?: unknown; senderId?: unknown; senderName?: unknown } | null | undefined
  return shape?.kind === 'team-message' && typeof shape.senderId === 'string' && typeof shape.senderName === 'string'
    ? shape as MailboxSource
    : undefined
}

/**
 * A team message delivered by the 0.2.0 mailbox, rewritten as the 0.2.1
 * relay: source `{ kind: 'agent-message', form: 'relay', senderSessionId }`,
 * first block `Team message from <name>:`. The 0.2.0 framing block
 * (`Team message <id> from <name>:`) is replaced only when it matches this
 * message's identity exactly; otherwise it stays as content, as it did.
 * Anything else comes back unchanged.
 * @param source - a `user/message` source.
 * @param content - that message's content blocks.
 * @returns the 0.2.1 form of the message.
 */
export function teamMailboxAsRelay<C>(source: unknown, content: C): { readonly source: unknown; readonly content: C } {
  const mailbox = mailboxSourceOf(source)
  if (mailbox === undefined || !Array.isArray(content)) return { source, content }
  const first = content[0] as { type?: unknown; text?: unknown } | undefined
  const legacyFraming = `Team message ${String(mailbox.messageId)} from ${mailbox.senderName}:`
  const body = first?.type === 'text' && first.text === legacyFraming ? content.slice(1) : content
  return {
    source: { kind: 'agent-message', form: 'relay', senderSessionId: mailbox.senderId },
    content: [{ type: 'text', text: `Team message from ${mailbox.senderName}:` }, ...body] as C,
  }
}

/**
 * The 0.2.0 `send_message` result: the mailbox status of the queued message
 * (0.2.1 answers `{ sent: true }`).
 * @param value - the parsed tool result.
 * @returns `accepted` / `queued`, or `undefined` for anything else.
 */
export function legacySendMessageStatus(value: Readonly<Record<string, unknown>>): string | undefined {
  return value.status === 'accepted' || value.status === 'queued' ? value.status : undefined
}
