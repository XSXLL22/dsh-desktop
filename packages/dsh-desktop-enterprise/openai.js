import { normalizeAuditContext } from './contract.js'
import {
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ToolCallId,
  attributionHeaders,
  contentHasImage,
  projectImagesForTextModel,
  requestImageHandleText,
  textOnlyImageText
} from '@deepseek-ai/dsh-llm'

export const ALLOWED_ATTRIBUTION_HEADERS = Object.freeze(['user-agent'])

export function pickAttributionHeaders(headers = {}) {
  const picked = {}
  for (const key of ALLOWED_ATTRIBUTION_HEADERS) {
    const value = headers[key] ?? headers[key.toUpperCase()]
    if (typeof value === 'string' && value.length > 0) picked[key] = value
  }
  return picked
}

function textContent(blocks) {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function assertTextOnly(blocks) {
  if (contentHasImage(blocks)) {
    throw new LlmError('Image input is unavailable for this model or message role.', 'UNSUPPORTED_CONTENT')
  }
}

function messageImageBlocks(message) {
  const blocks = []
  for (const block of message.content ?? []) {
    if (block.type === 'image') blocks.push(block)
    else if (block.type === 'tool-result') {
      for (const inner of block.content ?? []) {
        if (inner.type === 'image') blocks.push(inner)
      }
    }
  }
  return blocks
}

function assertRoleAllowsImages(message) {
  if (message.role === 'user' || message.role === 'tool') return
  assertTextOnly(message.content)
  for (const block of message.content ?? []) {
    if (block.type === 'tool-result') assertTextOnly(block.content)
  }
}

// Text-only routes stay usable by replacing images with the upstream placeholder.
// The shared projection does not recurse into legacy tool-result blocks.
function projectEnterpriseMessagesForTextModel(messages) {
  return projectImagesForTextModel(messages).map((message) => {
    if (!message.content?.some((block) => block.type === 'tool-result' && contentHasImage(block.content ?? []))) {
      return message
    }
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type !== 'tool-result' || !contentHasImage(block.content ?? [])) return block
        return {
          ...block,
          content: block.content.map((inner) => (
            inner.type === 'image'
              ? { type: 'text', text: textOnlyImageText(inner.attachment) }
              : inner
          ))
        }
      })
    }
  })
}

function imageUrlPart(block, images) {
  const image = images.get(block.attachment.attachmentId)
  if (!image) throw new LlmError('Image attachment is unavailable.', 'UNSUPPORTED_CONTENT')
  return { type: 'image_url', image_url: { url: image.url } }
}

async function readRequestImages(messages, readImage, signal) {
  const images = new Map()
  let imageBytes = 0
  for (const message of messages) {
    assertRoleAllowsImages(message)
    for (const block of messageImageBlocks(message)) {
      const image = await readImage?.(block.attachment, signal)
      if (!image) throw new LlmError('Image attachment is unavailable.', 'UNSUPPORTED_CONTENT')
      imageBytes += image.data.byteLength
      if (image.data.byteLength > 5 * 1024 * 1024 || imageBytes > 20 * 1024 * 1024) {
        throw new LlmError('Image request exceeds the size limit.', 'UNSUPPORTED_CONTENT')
      }
      images.set(block.attachment.attachmentId, {
        url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`,
        width: image.width,
        height: image.height,
        mediaType: image.mediaType
      })
    }
  }
  return images
}

function assistantMessage(message, includeReasoning) {
  const content = textContent(message.content)
  const reasoning = message.content
    .filter((block) => block.type === 'reasoning')
    .map((block) => block.text)
    .join('')
  const toolCalls = message.content
    .filter((block) => block.type === 'tool-call')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.arguments }
    }))
  return {
    role: 'assistant',
    content,
    ...(includeReasoning && reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  }
}

export function serializeEnterpriseRequest(options, model, images = new Map()) {
  const history = model.capabilities.vision
    ? options.messages
    : projectEnterpriseMessagesForTextModel(options.messages)
  const messages = []
  // 109 accepts image_url on user messages, not image arrays on tool.content.
  // Keep each tool call contiguous, then flush retained images once.
  const pendingToolImages = []
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return
    messages.push({ role: 'user', content: pendingToolImages.splice(0) })
  }
  const queueToolImages = (toolCallId, blocks) => {
    if (!model.capabilities.vision) return
    for (const block of blocks ?? []) {
      if (block.type !== 'image') continue
      const image = images.get(block.attachment.attachmentId)
      if (!image) throw new LlmError('Image attachment is unavailable.', 'UNSUPPORTED_CONTENT')
      pendingToolImages.push({
        type: 'text',
        text: `Tool call ${toolCallId}. ${requestImageHandleText(block.attachment, image)}`
      })
      pendingToolImages.push(imageUrlPart(block, images))
    }
  }
  const pushToolResult = (toolCallId, blocks) => {
    messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: textContent(blocks) || '(no output)'
    })
    queueToolImages(toolCallId, blocks)
  }
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  for (const message of history) {
    if (model.capabilities.vision) assertRoleAllowsImages(message)
    if (message.role === 'system') {
      flushToolImages()
      messages.push({ role: 'system', content: textContent(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      messages.push(assistantMessage(message, model.capabilities.reasoning_content))
      continue
    }
    // Harness carries tool results as messages; the call ID belongs to the message.
    if (message.role === 'tool') {
      pushToolResult(message.toolCallId, message.content)
      continue
    }
    const toolResults = message.content.filter((block) => block.type === 'tool-result')
    if (toolResults.length === 0) flushToolImages()
    for (const result of toolResults) pushToolResult(result.toolCallId, result.content)
    if (toolResults.length > 0) flushToolImages()
    const regularText = textContent(message.content)
    const parts = message.content.filter(block => block.type === 'text' || block.type === 'image')
    const hasImages = parts.some(block => block.type === 'image')
    const content = hasImages ? parts.map(block => (
      block.type === 'text' ? block : imageUrlPart(block, images)
    )) : regularText
    if (hasImages || regularText || toolResults.length === 0) messages.push({ role: 'user', content })
  }
  flushToolImages()
  const tools = options.tools?.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }))
  if (tools && tools.length > 0 && !model.capabilities.tools) {
    throw new LlmError(`BiSheng model "${model.id}" does not support tools.`, 'UNSUPPORTED_OPTION')
  }
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_completion_tokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    n: 1
  }
}

export async function* parseSseEvents(body, signal) {
  if (!body) throw new LlmError('BiSheng returned an empty event stream.', 'STREAM_CLOSED')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason
      const { value, done } = await reader.read()
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
      buffer = buffer.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (!frame || frame.startsWith(':')) continue
        let event = 'message'
        const data = []
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''))
        }
        if (data.length > 0) yield { event, data: data.join('\n') }
      }
      if (done) break
    }
    if (buffer.trim() && !buffer.trimStart().startsWith(':')) {
      throw new LlmError('BiSheng event stream ended with an incomplete frame.', 'STREAM_CLOSED')
    }
  } finally {
    reader.releaseLock()
  }
}

const LOCAL_CHAT_FAILURES = Object.freeze({
  'Enterprise models are unavailable.': {
    zh: '企业模型暂不可用。',
    en: 'Enterprise models are unavailable.'
  },
  'Enterprise session changed.': {
    zh: '企业会话已变更。',
    en: 'Enterprise session changed.'
  }
})

function isChineseLocale(language) {
  return String(language || '').toLowerCase().startsWith('zh')
}

function readUiLanguage() {
  return typeof navigator === 'object' && navigator && typeof navigator.language === 'string'
    ? navigator.language
    : 'en'
}

const CHAT_PLATFORM_CODES = new Set([
  'upstream_error',
  'upstream_timeout',
  'monthly_token_limit_exceeded',
  'quota_unavailable',
  'usage_unavailable',
  'model_not_allowed',
  'invalid_request',
  'unsupported_parameter',
  'authorization_unavailable',
  'internal_error',
  'invalid_access_token',
  'session_expired',
  'session_revoked',
  'seat_revoked',
  'dsh_disabled',
  'user_disabled',
  'tenant_unavailable',
  'enterprise_models_unavailable',
  'enterprise_session_changed',
  'enterprise_chat_busy',
  'UNKNOWN_MODEL'
])

const LEGACY_CHAT_PHRASES = Object.freeze({
  'monthly token limit exceeded': 'monthly_token_limit_exceeded',
  'monthly token limit reached': 'monthly_token_limit_exceeded',
  'authorization unavailable': 'authorization_unavailable',
  'dsh authorization is temporarily unavailable': 'authorization_unavailable',
  'quota unavailable': 'quota_unavailable',
  'dsh quota state is temporarily unavailable': 'quota_unavailable',
  'usage unavailable': 'usage_unavailable',
  'actual request usage could not be confirmed': 'usage_unavailable',
  'seat revoked': 'seat_revoked',
  'dsh seat revoked': 'seat_revoked',
  'session revoked': 'session_revoked',
  'dsh session revoked': 'session_revoked',
  'session expired': 'session_expired',
  'dsh session expired': 'session_expired',
  'invalid access token': 'invalid_access_token',
  'invalid dsh access token': 'invalid_access_token',
  'internal error': 'internal_error',
  'user disabled': 'user_disabled',
  'tenant unavailable': 'tenant_unavailable',
  'dsh disabled': 'dsh_disabled'
})

const LOCAL_CHAT_PHRASES = Object.freeze({
  'enterprise models are unavailable': 'enterprise_models_unavailable',
  'enterprise session changed': 'enterprise_session_changed',
  'model is not assigned to this account': 'UNKNOWN_MODEL',
  'too many enterprise chats': 'enterprise_chat_busy'
})

const CHAT_MESSAGE_LIMIT = 300

function payloadError(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) &&
    payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
    ? payload.error
    : null
}

function rawChatMessage(payload) {
  const objectMessage = payloadError(payload)?.message
  if (typeof objectMessage === 'string' && objectMessage.length > 0) return objectMessage
  return payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.error === 'string'
    ? payload.error
    : ''
}

function normalizeChatPhrase(value) {
  return value.trim().replace(/\.$/u, '').trim().toLowerCase()
}

function messageLooksLikeHtml(value) {
  return /<[a-z!/][^>]*>/iu.test(value)
}

function sanitizeChatMessage(value) {
  return value
    .replace(/<[^>]*>/gu, ' ')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, CHAT_MESSAGE_LIMIT)
}

function formatEnterpriseChatFailure(status, payload, language) {
  if (platformChatCode(payload) === 'context_length_exceeded') return 'Model context length exceeded'
  const zh = isChineseLocale(language)
  const raw = rawChatMessage(payload)
  const local = LOCAL_CHAT_FAILURES[raw]
  if (local) return zh ? local.zh : local.en
  const fallback = zh ? `毕昇模型请求失败（${status}）。` : `BiSheng model request failed (${status}).`
  if (!raw || messageLooksLikeHtml(raw)) {
    const stripped = raw ? sanitizeChatMessage(raw) : ''
    return stripped || fallback
  }
  return sanitizeChatMessage(raw) || fallback
}

function platformChatCode(payload) {
  const code = payloadError(payload)?.code
  if (typeof code === 'string' && code.trim() && code.trim() !== 'request_failed') return code.trim()
  const phrase = normalizeChatPhrase(rawChatMessage(payload))
  return LEGACY_CHAT_PHRASES[phrase] || LOCAL_CHAT_PHRASES[phrase] || 'request_failed'
}

function classifyChatFailure(code, status) {
  // Compaction retries only this harness code. The chat UI localizes the BiSheng sentence on its own.
  if (code === 'context_length_exceeded') return 'CONTEXT_WINDOW_EXCEEDED'
  if (CHAT_PLATFORM_CODES.has(code)) return code
  if (code !== 'request_failed') return code
  if (status >= 500) return 'SERVER'
  if (status === 429) return 'RATE_LIMIT'
  return 'PROVIDER_ERROR'
}

function requestIdFrom(headerId, payload) {
  if (typeof headerId === 'string' && headerId.length > 0) return headerId
  const bodyId = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload.request_id
    : undefined
  return typeof bodyId === 'string' && bodyId.length > 0 ? bodyId : undefined
}

function requestFailure(status, requestId, payload) {
  const resolvedId = requestIdFrom(requestId, payload)
  return new LlmError(
    formatEnterpriseChatFailure(status, payload, readUiLanguage()),
    classifyChatFailure(platformChatCode(payload), status),
    {
      status,
      ...(resolvedId ? { requestId: ProviderRequestId(resolvedId) } : {})
    }
  )
}

async function responseFailure(response) {
  const payload = await response.json().catch(() => ({}))
  return requestFailure(response.status, response.headers.get('x-request-id') ?? undefined, payload)
}

function validUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prompt = value.prompt_tokens
  const completion = value.completion_tokens
  const total = value.total_tokens
  if (prompt === null && completion === null && total === null) return undefined
  if (
    !Number.isSafeInteger(prompt) || prompt < 0 ||
    !Number.isSafeInteger(completion) || completion < 0 ||
    !Number.isSafeInteger(total) || total < 0 ||
    total !== prompt + completion
  ) return undefined
  const details = value.prompt_tokens_details
  const read = details && typeof details === 'object' && !Array.isArray(details)
    ? optionalTokenCount(details.cached_tokens)
    : undefined
  const write = details && typeof details === 'object' && !Array.isArray(details)
    ? optionalTokenCount(details.cache_creation_tokens)
    : undefined
  const cached = (read ?? 0) + (write ?? 0)
  const safeCache = cached <= prompt
  return {
    inputTokens: safeCache ? prompt - cached : prompt,
    outputTokens: completion,
    totalTokens: total,
    ...(safeCache && read !== undefined ? { cacheReadTokens: read } : {}),
    ...(safeCache && write !== undefined ? { cacheWriteTokens: write } : {})
  }
}

function optionalTokenCount(value) {
  if (value === null || value === undefined) return undefined
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function finishReason(value) {
  if (value === 'stop') return { kind: 'stop' }
  if (value === 'length') return { kind: 'max-tokens' }
  if (value === 'tool_calls') return { kind: 'tool-calls' }
  if (value === 'content_filter') {
    return {
      kind: 'error',
      failure: { message: 'BiSheng filtered the model response.', code: 'CONTENT_FILTERED' }
    }
  }
  return undefined
}

export class EnterpriseLlmAdapter extends LlmAdapter {
  /**
   * @param {object} options
   * @param {() => string} options.providerName
   * @param {() => import('./contract.js').EnterpriseModel[]} options.models
   * @param {() => readonly string[]} [options.auditFields] Current trusted connection capability; not persisted.
   * @param {Function} options.request Existing credential broker transport.
   * @param {Function} [options.readImage]
   * @param {Function} [options.onComplete]
   */
  constructor(options) {
    super()
    this.options = options
  }

  providerInfo(provider) {
    return { id: provider, name: this.options.providerName() }
  }

  providerRetryPolicy() {
    return { mode: 'normal', maxRetries: 0, retryableCodes: ['TRANSPORT'] }
  }

  listModels(provider) {
    return Promise.resolve(this.options.models().map((model) => ({
      provider,
      id: model.id,
      name: model.display_name,
      inputModalities: model.capabilities.vision ? ['text', 'image'] : ['text']
    })))
  }

  resolveModel(provider, id) {
    const model = this.options.models().find((candidate) => candidate.id === id)
    if (!model) throw new LlmError(`BiSheng provider has no authorized model "${id}".`, 'UNKNOWN_MODEL')
    return Promise.resolve({
      provider,
      id,
      name: model.display_name,
      inputModalities: model.capabilities.vision ? ['text', 'image'] : ['text']
    })
  }

  async *stream(options) {
    const model = this.options.models().find((candidate) => candidate.id === options.model)
    if (!model) throw new LlmError(`BiSheng provider has no authorized model "${options.model}".`, 'UNKNOWN_MODEL')
    const history = model.capabilities.vision
      ? options.messages
      : projectEnterpriseMessagesForTextModel(options.messages)
    const images = model.capabilities.vision
      ? await readRequestImages(history, this.options.readImage, options.signal)
      : new Map()
    const request = serializeEnterpriseRequest({ ...options, messages: history }, model, images)
    const auditContext = normalizeAuditContext({
      conversation_id: options.sessionId,
      request_kind: options.purpose === undefined ? 'chat' : options.purpose
    }, this.options.auditFields?.() ?? [])
    if (auditContext) request.audit_context = auditContext
    const response = await this.options.request(
      request,
      options.signal,
      pickAttributionHeaders(attributionHeaders())
    )
    if (!response.ok) throw await responseFailure(response)
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith('text/event-stream')) {
      throw new LlmError('BiSheng returned a non-SSE model response.', 'INVALID_RESPONSE', {
        status: response.status
      })
    }

    const blocks = []
    const tools = new Map()
    let textBlock
    let reasoningBlock
    let usage
    let stopped
    let done = false

    const startBlock = (type) => {
      const block = { index: blocks.length, type, text: '' }
      blocks.push(block)
      return block
    }

    for await (const event of parseSseEvents(response.body, options.signal)) {
      if (event.data === '[DONE]') {
        done = true
        break
      }
      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        throw new LlmError('BiSheng event stream contains invalid JSON.', 'INVALID_RESPONSE')
      }
      if (event.event === 'error' || payload?.error) {
        for (const block of blocks) {
          if (block.type === 'text') yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
          else if (block.type === 'reasoning') yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
          else yield { type: 'block-end', index: block.index, block: { type: 'tool-call', id: ToolCallId(block.id), name: block.name, arguments: block.arguments } }
        }
        const failure = requestFailure(200, payload?.request_id, payload)
        yield { type: 'finish', reason: { kind: 'error', failure: failure.failure } }
        return
      }
      const parsedUsage = validUsage(payload?.usage)
      if (parsedUsage) usage = parsedUsage
      const choices = Array.isArray(payload?.choices) ? payload.choices : []
      for (const choice of choices) {
        if (!choice || typeof choice !== 'object' || choice.index !== 0) continue
        const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {}
        if (model.capabilities.reasoning_content && typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          if (!reasoningBlock) {
            reasoningBlock = startBlock('reasoning')
            yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
          }
          reasoningBlock.text += delta.reasoning_content
          yield { type: 'reasoning-delta', index: reasoningBlock.index, text: delta.reasoning_content }
        }
        if (typeof delta.content === 'string' && delta.content) {
          if (!textBlock) {
            textBlock = startBlock('text')
            yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
          }
          textBlock.text += delta.content
          yield { type: 'text-delta', index: textBlock.index, text: delta.content }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const item of delta.tool_calls) {
            if (!item || !Number.isSafeInteger(item.index) || item.index < 0) continue
            let tool = tools.get(item.index)
            if (!tool) {
              tool = { index: undefined, id: '', name: '', arguments: '', pendingArguments: '' }
              tools.set(item.index, tool)
            }
            if (typeof item.id === 'string' && item.id) tool.id = item.id
            if (typeof item.function?.name === 'string') tool.name += item.function.name
            if (typeof item.function?.arguments === 'string') tool.pendingArguments += item.function.arguments
            if (tool.id && tool.index === undefined) {
              const block = startBlock('tool-call')
              tool.index = block.index
              block.id = tool.id
              block.name = tool.name
              block.arguments = ''
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
            }
            if (tool.index !== undefined && tool.pendingArguments) {
              const block = blocks[tool.index]
              block.name = tool.name
              block.arguments += tool.pendingArguments
              yield {
                type: 'tool-call-delta',
                index: tool.index,
                id: ToolCallId(tool.id),
                ...(tool.name ? { name: tool.name } : {}),
                argumentsDelta: tool.pendingArguments
              }
              tool.pendingArguments = ''
            }
          }
        }
        const nextStop = finishReason(choice.finish_reason)
        if (nextStop) stopped = nextStop
      }
    }

    if (!done || !stopped) throw new LlmError('BiSheng event stream closed before completion.', 'STREAM_CLOSED')
    if (blocks.length === 0 && stopped.kind !== 'error') {
      throw new LlmError('BiSheng event stream completed without model output.', 'EMPTY_RESPONSE')
    }
    for (const block of blocks) {
      if (block.type === 'text') {
        yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
      } else if (block.type === 'reasoning') {
        yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
      } else {
        if (!block.id || !block.name) throw new LlmError('BiSheng returned an incomplete tool call.', 'INVALID_RESPONSE')
        try {
          JSON.parse(block.arguments)
        } catch {
          throw new LlmError('BiSheng returned incomplete tool arguments.', 'INVALID_RESPONSE')
        }
        yield {
          type: 'block-end',
          index: block.index,
          block: {
            type: 'tool-call',
            id: ToolCallId(block.id),
            name: block.name,
            arguments: block.arguments
          }
        }
      }
    }
    if (usage) yield { type: 'usage', usage }
    await this.options.onComplete?.(options.model)
    yield { type: 'finish', reason: stopped }
  }
}
