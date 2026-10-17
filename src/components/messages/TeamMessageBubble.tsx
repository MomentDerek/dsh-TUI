import React from 'react'
import { Box, Text, useTerminalSize } from '../../ui.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { wrapWidth } from '../../sessions/format.js'
import { t } from '../../i18n.js'

type Props = {
  /** The sending team member's name. */
  sender: string
  text: string
  /** Adds the top margin between turns. */
  marginTopOnTurn: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
}

const MARK = '✉ '

/**
 * An Agent Teams peer message delivered to this session: a `✉ <sender>` line
 * in the agent tint, then the body in plain text with a hanging indent — it
 * reads apart from the human's bold `❯` prompt it shares a log role with.
 */
export function TeamMessageBubble({ sender, text, marginTopOnTurn, isSelected = false }: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const indent = ' '.repeat(stringWidth(MARK))
  // Pre-wrapped for the hanging indent, as the prompt bubble is.
  const lines = wrapWidth(text, Math.max(1, columns - indent.length - 3))
  return (
    <Box
      flexDirection="column"
      marginTop={marginTopOnTurn ? 1 : 0}
      backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
      paddingRight={1}
    >
      <Text color="toolDotTask" wrap="truncate-end">
        {MARK}<Text bold>{sender}</Text><Text dimColor>{` · ${t('team-message-label')}`}</Text>
      </Text>
      {lines.map((line, index) => (
        <Text key={index} wrap="truncate-end">{indent}{line}</Text>
      ))}
    </Box>
  )
}
