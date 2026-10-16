import { describe, expect, it } from 'vitest'
import {
  ALLOWED_ATTRIBUTION_HEADERS,
  parseEnterpriseChatPayload,
  pickAttributionHeaders
} from '../src/main/enterprise/enterprise-chat'
import { serializeEnterpriseRequest } from '../packages/dsh-desktop-enterprise/openai.js'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const validRequest = {
  model: 'bisheng:42',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
  stream_options: { include_usage: true },
  n: 1
}

describe('enterprise chat payload validation', () => {
  it.each([undefined, 'high'])('accepts actual adapter serialization with default or explicit effort: %s', (effort) => {
    const model = {
      id: 'bisheng:42', display_name: 'Reasoner', capabilities: { streaming: true, tools: true, reasoning_content: false },
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' }
    }
    const request = serializeEnterpriseRequest({
      model: model.id, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) })
    }, model)
    expect(parseEnterpriseChatPayload({ request }).request.reasoning_effort).toBe(effort ?? 'low')
  })

  it.each([null, true, 1, {}, '', 'a'.repeat(129), ' high', 'high\r\nx-header: injected'])('rejects invalid effort %j', (effort) => {
    expect(() => parseEnterpriseChatPayload({ request: { ...validRequest, reasoning_effort: effort } })).toThrow('reasoning effort is invalid')
  })

  it('accepts a streaming request and keeps only attribution user-agent', () => {
    expect(ALLOWED_ATTRIBUTION_HEADERS).toEqual(['user-agent', 'x-dsh-conversation-id', 'x-dsh-request-purpose'])
    const parsed = parseEnterpriseChatPayload({
      request: validRequest,
      attribution: { 'user-agent': 'deepseek-harness/0.1.5-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)' }
    })
    expect(parsed.model).toBe('bisheng:42')
    expect(parsed.attribution).toEqual({
      'user-agent': 'deepseek-harness/0.1.5-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)'
    })
  })

  it('rejects caller-controlled authorization and other headers', () => {
    expect(() => pickAttributionHeaders({ authorization: 'Bearer stolen' })).toThrow('forbidden header')
    expect(() => pickAttributionHeaders({ 'x-request-id': 'abc' })).toThrow('forbidden header')
    expect(() => parseEnterpriseChatPayload({
      request: validRequest,
      attribution: { host: 'evil.example' }
    })).toThrow('forbidden header')
    expect(() => parseEnterpriseChatPayload({
      request: { ...validRequest, authorization: 'Bearer stolen' }
    })).toThrow('unsupported fields')
    expect(() => parseEnterpriseChatPayload({
      request: validRequest,
      base: 'https://evil.example'
    })).toThrow('unsupported fields')
  })

  it.each([11, 30])('accepts %i images across messages within byte limits', (count) => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
    const messages = Array.from({ length: count }, () => ({ role: 'user', content: [image] }))
    const parsed = parseEnterpriseChatPayload({ request: { ...validRequest, messages } })
    expect(parsed.request.messages).toEqual(messages)
  })

  it('still rejects images exceeding the total byte limit', () => {
    const url = `data:image/png;base64,${'A'.repeat(Math.ceil(4 * 1024 * 1024 * 4 / 3))}`
    expect(() => parseEnterpriseChatPayload({
      request: {
        ...validRequest,
        messages: [{
          role: 'user',
          content: Array.from({ length: 6 }, () => ({ type: 'image_url', image_url: { url } }))
        }]
      }
    })).toThrow('size limit')
  })

  it('rejects remote image URLs and oversized inline images', () => {
    expect(() => parseEnterpriseChatPayload({
      request: {
        ...validRequest,
        messages: [{
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://evil.example/x.png' } }]
        }]
      }
    })).toThrow('inline images')
    const huge = `data:image/png;base64,${'A'.repeat(Math.ceil(6 * 1024 * 1024 * 4 / 3))}`
    expect(() => parseEnterpriseChatPayload({
      request: {
        ...validRequest,
        messages: [{
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: huge } }]
        }]
      }
    })).toThrow('size limit')
  })
})
