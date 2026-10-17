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

/** The identity block 0.2.0 `spawn_teammate` put before a teammate's first prompt. */
function teammateReminder(name: string): string {
  return `<system-reminder>
You are teammate "${name}".
Your Team Lead is named "lead".
Use list_agents({}) to find your teammates and their names.
To message your Team Lead, use send_message({ target: "lead", message: "..." }).
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
</system-reminder>

`
}

const TEAMMATE_REMINDER_NAME = /^<system-reminder>\nYou are teammate "([^\n]*)"\.\n/

function isTeammateReminder(block: unknown): boolean {
  const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown }
  if (type !== 'text' || typeof text !== 'string') return false
  const name = TEAMMATE_REMINDER_NAME.exec(text)?.[1]
  return name !== undefined && text === teammateReminder(name)
}

/**
 * One `user/message` in its 0.2.1 form. Two 0.2.0 shapes change; anything
 * else comes back as the same object.
 *
 * - A team message delivered by the mailbox becomes the relay: source
 *   `{ kind: 'agent-message', form: 'relay', senderSessionId }`, first block
 *   `Team message from <name>:`. The 0.2.0 framing block
 *   (`Team message <id> from <name>:`) is replaced only when it matches this
 *   message's identity exactly; otherwise it stays as content, as it did.
 * - A teammate's first prompt drops the leading `<system-reminder>` identity
 *   block (0.2.1 carries it as a system-prompt context), matched against
 *   the whole 0.2.0 template so a person's own text is never cut.
 * @param data - the message's source and content (other fields are kept).
 * @returns `data`, or a copy in the 0.2.1 form.
 */
export function asCurrentTeamMessage<T extends { readonly source?: unknown; readonly content?: unknown }>(data: T): T {
  const { source, content } = data
  if (!Array.isArray(content)) return data
  const mailbox = mailboxSourceOf(source)
  if (mailbox !== undefined) {
    const first = content[0] as { type?: unknown; text?: unknown } | undefined
    const legacyFraming = `Team message ${String(mailbox.messageId)} from ${mailbox.senderName}:`
    const body = first?.type === 'text' && first.text === legacyFraming ? content.slice(1) : content
    return {
      ...data,
      source: { kind: 'agent-message', form: 'relay', senderSessionId: mailbox.senderId },
      content: [{ type: 'text', text: `Team message from ${mailbox.senderName}:` }, ...body],
    } as T
  }
  const user = (source as { kind?: unknown } | null | undefined)?.kind === 'user'
  if (user && content.length > 1 && isTeammateReminder(content[0])) return { ...data, content: content.slice(1) } as T
  return data
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
