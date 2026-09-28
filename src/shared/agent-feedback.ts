import type {
  LocalFeedbackSubmission,
  LocalFeedbackSubmissionInput
} from './feedback'

export const AGENT_FEEDBACK_PROTOCOL_VERSION = 1 as const

export type AgentDeliveryMode = 'enqueue' | 'immediate'
export type AgentReadiness =
  | 'disconnected'
  | 'idle'
  | 'working'
  | 'blocked'
  | 'error'

export type AgentAttemptStatus =
  | 'prepared'
  | 'accepted'
  | 'consumed'
  | 'reply-observed'
  | 'idle-after-turn'
  | 'rejected'
  | 'unknown'
  | 'retired'

export type AgentConnectionStatus = {
  paired: boolean
  readiness: AgentReadiness
  sessionId: string | null
  generation: string | null
  blockedReason: string | null
  lastEventSequence: number
  detail: string | null
}

export type AgentDeliveryAttempt = {
  id: string
  documentId: string
  submissionId: string
  bindingId: string | null
  generation: string
  mode: AgentDeliveryMode
  status: AgentAttemptStatus
  providerMessageId: string | null
  reply: string | null
  createdAt: string
  updatedAt: string
  detail: string | null
}

export type AgentDocumentState = {
  connection: AgentConnectionStatus
  attempts: AgentDeliveryAttempt[]
}

export type AgentPairingInput = {
  pairingCode: string
}

export type AgentDeliveryInput = LocalFeedbackSubmissionInput & {
  mode: AgentDeliveryMode
}

export type AgentDeliveryResult = {
  submission: LocalFeedbackSubmission
  attempt: AgentDeliveryAttempt
}

export type AgentEvent =
  | { type: 'connection'; connection: AgentConnectionStatus }
  | {
      type: 'attempt'
      documentId: string
      attempt: AgentDeliveryAttempt
    }

const MAX_PAIRING_CODE_LENGTH = 4096

export const parseAgentPairingInput = (value: unknown): AgentPairingInput => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('pairingCode' in value) ||
    typeof value.pairingCode !== 'string'
  ) {
    throw new TypeError('A pairing code is required')
  }
  const pairingCode = value.pairingCode.trim()
  if (
    !pairingCode.startsWith('evp1:') ||
    pairingCode.length > MAX_PAIRING_CODE_LENGTH
  ) {
    throw new TypeError('The pairing code is invalid')
  }
  return { pairingCode }
}
