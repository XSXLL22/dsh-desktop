import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

interface Registration {
  config: { name: string; id?: string; order?: number }
  component: (props: Record<string, unknown>) => unknown
}

describe('BISHENG Work client slot occupants', () => {
  it('keeps BISHENG artwork in mark seats and inherits the sidebar name typography', async () => {
    const source = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-client-ui', 'client.js'),
      'utf8'
    )
    let definition: {
      factory: (require: (id: string) => unknown) => {
        apply: (ctx: unknown) => void
        inject: string[]
      }
    } | undefined
    const appended: Array<{ textContent?: string }> = []
    const document = {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => ({ id: '', dataset: {}, textContent: '' })),
      head: { appendChild: (node: { textContent?: string }) => appended.push(node) }
    }
    vm.runInNewContext(source, {
      document,
      navigator: { language: 'en-US' },
      window: {
        __ModuleLoader__: {
          load: (value: typeof definition) => {
            definition = value
          }
        }
      }
    })

    expect(definition).toBeDefined()
    const createElement = (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): { type: unknown; props: Record<string, unknown> } => ({
      type,
      props: { ...props, children }
    })
    const plugin = definition!.factory((id) => {
      if (id === 'react') {
        return {
          createElement,
          useEffect: (effect: () => void | (() => void)) => effect(),
          useState: (initial: unknown) => [initial, vi.fn()]
        }
      }
      throw new Error(`Unexpected client dependency: ${id}`)
    })

    const registrations: Registration[] = []
    const slots = {
      inject: (_name: string, callback: () => unknown): unknown => {
        const result = callback()
        if (result && typeof result === 'object' && Symbol.iterator in result) {
          for (const _entry of result as Iterable<unknown>) void _entry
        }
        return result
      },
      register: (
        config: Registration['config'],
        component: Registration['component']
      ): (() => void) => {
        registrations.push({ config, component })
        return () => undefined
      }
    }
    plugin.apply({ slots })

    expect(plugin.inject).toEqual(['slots'])
    expect(registrations.map(({ config }) => config.name)).toEqual([
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark'
    ])
    // The slot occupants stay self-contained, so no theme stylesheet is injected.
    expect(appended).toHaveLength(0)

    const sidebarName = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.name'
    )!.component({}) as { type: unknown; props: Record<string, unknown> }
    expect(sidebarName.type).toBe('span')
    expect(sidebarName.props.children).toEqual(['BISHENG Work'])
    expect(sidebarName.props.className).toBeUndefined()
    expect(sidebarName.props.style).toEqual({ letterSpacing: '-0.01em' })
    expect(sidebarName.props.fontFamily).toBeUndefined()
    expect(sidebarName.props.fontSize).toBeUndefined()
    expect(sidebarName.props.fontWeight).toBeUndefined()
    expect(sidebarName.props.color).toBeUndefined()

    const sidebarMark = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.mark'
    )!.component({ size: 24 }) as { type: unknown; props: Record<string, unknown> }
    expect(sidebarMark.type).toBe('svg')
    expect(sidebarMark.props.width).toBe(17)
    expect(sidebarMark.props.height).toBe(17)
    const [markField, ...markPaths] = sidebarMark.props.children as Array<{
      type: unknown
      props: Record<string, unknown>
    }>
    expect(markField?.type).toBe('rect')
    expect(markField?.props.fill).toBe('#034FE5')
    expect(markPaths).toHaveLength(8)
    expect(markPaths.every(({ type, props }) => type === 'path' && props.fill === 'white')).toBe(true)

    const heroMark = registrations.find(
      ({ config }) => config.name === 'conversation.hero.brand.mark'
    )!.component({ size: 48 }) as { type: unknown; props: Record<string, unknown> }
    expect(heroMark.type).toBe('svg')
    expect(heroMark.props.width).toBe(48)
    expect(heroMark.props.height).toBe(48)
  })

  it('does not render the upstream preview badge beside the hero headline', async () => {
    const source = await readFile(
      path.join(
        projectRoot,
        'node_modules',
        '@deepseek-ai',
        'dsh-client-ui-conversation',
        'lib',
        'client.js'
      ),
      'utf8'
    )

    expect(source).toContain('children: (0, react_jsx_runtime.jsx)("span", { children: t("hero.headline") })')
    expect(source).not.toContain('children: t("hero.preview")')
  })

  it('shows the brand mark only in the collapsed rail, not beside the wide brand name', async () => {
    const source = await readFile(
      path.join(
        projectRoot,
        'node_modules',
        '@deepseek-ai',
        'dsh-client-ui-sidebar',
        'lib',
        'client.js'
      ),
      'utf8'
    )

    const wideBrandStart = source.indexOf('children: [wide &&')
    const wideBrandEnd = source.indexOf('label: collapsed ? t("toggle.open")', wideBrandStart)
    const wideBrand = source.slice(wideBrandStart, wideBrandEnd)
    expect(wideBrandStart).toBeGreaterThan(-1)
    expect(wideBrandEnd).toBeGreaterThan(wideBrandStart)
    expect(wideBrand).toContain('renderSlot("sidebar.brand.name"')
    expect(wideBrand).not.toContain('renderSlot("sidebar.brand.mark"')

    const railMarkStart = source.indexOf(
      'className: SidebarRoot_module_css_default.railMark',
      wideBrandEnd
    )
    const railMarkEnd = source.indexOf(
      'className: SidebarRoot_module_css_default.panelIcon',
      railMarkStart
    )
    const railMark = source.slice(railMarkStart, railMarkEnd)
    expect(railMarkStart).toBeGreaterThan(wideBrandEnd)
    expect(railMarkEnd).toBeGreaterThan(railMarkStart)
    expect(railMark).toContain('renderSlot("sidebar.brand.mark", { size: 24 }')
  })
})
