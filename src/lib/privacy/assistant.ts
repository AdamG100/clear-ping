import { getAllTargets } from '../db/database'
import { listProbeAgents } from '../probe-agents/store'
import { maskForAssistant, maskText } from './mask'

/**
 * The answers with every address hidden, where Settings → Privacy says
 * assistants are not to see them: what an assistant is given goes on to
 * whoever runs it. Each tool's answer is JSON, and its address fields are
 * hidden whole; the names of targets and probe agents, and IP addresses,
 * wherever else they turn up.
 */
export async function withAddressesHidden<T>(answers: T[]): Promise<T[]> {
  const [targets, agents] = await Promise.all([getAllTargets(), listProbeAgents().catch(() => [])])
  const known = [
    ...targets.flatMap(target => [target.host, target.resolvedAddress ?? '']),
    ...agents.flatMap(agent => [agent.address, agent.hostname ?? '']),
  ].filter(Boolean)

  const hide = (text: string) => {
    try {
      return JSON.stringify(maskForAssistant(JSON.parse(text), known))
    } catch {
      return maskText(text, { known })
    }
  }
  return answers.map(answer => {
    const result = (answer as { result?: { content?: unknown } }).result
    if (!result || !Array.isArray(result.content)) return answer
    const content = result.content.map(part =>
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? { ...part, text: hide((part as { text: string }).text) }
        : part
    )
    return { ...answer, result: { ...result, content } }
  })
}
