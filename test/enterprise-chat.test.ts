import { describe, expect, it } from 'vitest'
import {
  ALLOWED_ATTRIBUTION_HEADERS,
  parseEnterpriseChatPayload,
  pickAttributionHeaders
} from '../src/main/enterprise/enterprise-chat'

const validRequest = {
  model: 'bisheng:42',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
  stream_options: { include_usage: true },
  n: 1
}

describe('enterprise chat payload validation', () => {
  it('accepts a streaming request and keeps only attribution user-agent', () => {
    expect(ALLOWED_ATTRIBUTION_HEADERS).toEqual(['user-agent'])
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
