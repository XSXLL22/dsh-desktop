import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const html = readFileSync(new URL('../build/plugin-recovery.html', import.meta.url), 'utf8')
const start = html.indexOf('      // Keep the human-readable plan')
const end = html.indexOf("      primary.addEventListener('click'", start)
if (start < 0 || end < 0) throw new Error('Recovery plan rendering is missing')
const renderScript = html.slice(start, end)

function renderPlan(available: boolean) {
  const elements = new Map<string, ReturnType<typeof element>>()
  function element() {
    const handlers = new Map<string, () => void>()
    return { hidden: false, disabled: false, textContent: '', children: [] as unknown[],
      appendChild(child: unknown) { this.children.push(child) },
      setAttribute: vi.fn(), addEventListener: (name: string, handler: () => void) => handlers.set(name, handler),
      click: () => handlers.get('click')?.() }
  }
  const get = (id: string) => {
    let node = elements.get(id)
    if (!node) { node = element(); elements.set(id, node) }
    return node
  }
  const action = vi.fn()
  runInNewContext(renderScript, {
    model: { locale: 'zh', canRepair: true, repairDetailsLabel: '查看修复方案',
      repairDetails: ['升级插件 calendar 至 2.0'], rollbackVisible: true,
      rollbackLabel: available ? '回退应用至 0.12.0' : undefined,
      rollbackUnavailableReason: available ? undefined : '当前没有可回退的应用版本。' },
    document: { getElementById: get, createElement: element, querySelectorAll: () => [...elements.values()] },
    setText: (id: string, text: string) => { get(id).textContent = text },
    window: { dshRecovery: { action } }
  })
  return { get, action }
}

describe('recovery plan and rollback controls', () => {
  it('keeps error details inline after the independently expandable repair plan', () => {
    const plan = html.indexOf('<details class="repair-plan"')
    const error = html.indexOf('<details class="error-details"')
    const decision = html.indexOf('<div class="decision-row"')
    expect(plan).toBeGreaterThan(0)
    expect(error).toBeGreaterThan(html.indexOf('</details>', plan))
    expect(error).toBeLessThan(decision)
    expect(html.slice(error, html.indexOf('</details>', error))).toContain('id="show-log"')
    expect(html).not.toContain('details-drawer')
    expect(html).not.toContain('details-resizer')
    expect(html).toContain('.decision-row.safe-mode-only { justify-content: flex-end; }')
  })

  it('renders an expandable plan with no action until the user chooses', () => {
    const page = renderPlan(true)
    expect(page.get('repair-plan').hidden).toBe(false)
    expect(page.get('repair-plan-steps').children).toMatchObject([{ textContent: '升级插件 calendar 至 2.0' }])
    expect(html).toContain('<details class="repair-plan" id="repair-plan" hidden>')
    expect(page.action).not.toHaveBeenCalled()
    page.get('secondary').click()
    expect(page.action).toHaveBeenCalledWith('rollback')
  })
  it('shows disabled rollback and its reason without dispatching a downgrade', () => {
    const page = renderPlan(false)
    expect(page.get('secondary').hidden).toBe(false)
    expect(page.get('secondary').disabled).toBe(true)
    expect(page.get('rollback-note').hidden).toBe(false)
    expect(page.get('rollback-note').textContent).toContain('没有可回退')
    page.get('secondary').click()
    expect(page.action).not.toHaveBeenCalled()
  })
})
