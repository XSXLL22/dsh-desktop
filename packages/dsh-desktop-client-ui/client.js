window.__ModuleLoader__.load({
  id: 'dsh-desktop-client-ui',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    // Paths are copied from build/bisheng-logo-mark.svg. Keeping the browser
    // occupant self-contained makes it replayable when Harness loads plugins
    // from an installed Profile rather than the repository.
    const BISHENG_MARK_PATHS = [
      'M697.188 502.5H764.315C801.418 502.5 831.503 532.585 831.503 569.688V578.317C831.503 615.42 794.4 645.505 764.315 645.505H697.188C660.085 645.505 630 608.402 630 578.317V569.688C630 532.585 667.102 502.5 697.188 502.5Z',
      'M965.863 502.5H1503.17C1540.27 502.5 1570.36 532.585 1570.36 569.688V578.317C1570.36 615.42 1533.25 645.505 1503.17 645.505H965.863C928.761 645.505 898.676 608.402 898.676 578.317V569.688C898.676 532.585 935.778 502.5 965.863 502.5Z',
      'M764.363 752.749H1704.69C1741.79 752.749 1771.88 782.834 1771.88 819.936V828.566C1771.88 865.668 1734.78 895.754 1704.69 895.754H764.363C727.261 895.754 697.176 858.651 697.176 828.566V819.936C697.176 782.834 734.278 752.749 764.363 752.749Z',
      'M764.363 1003H1436.01C1473.12 1003 1503.2 1033.09 1503.2 1070.19V1078.82C1503.2 1115.92 1466.1 1146.01 1436.01 1146.01H764.363C727.261 1146.01 697.176 1108.91 697.176 1078.82V1070.19C697.176 1033.09 734.278 1003 764.363 1003Z',
      'M764.363 1253.26H1570.35C1607.45 1253.26 1637.53 1283.34 1637.53 1320.44V1329.07C1637.53 1366.18 1600.43 1396.26 1570.35 1396.26H764.363C727.261 1396.26 697.176 1359.16 697.176 1329.07V1320.44C697.176 1283.34 734.278 1253.26 764.363 1253.26Z',
      'M764.363 1503.5H1704.69C1741.79 1503.5 1771.88 1533.59 1771.88 1570.69V1579.32C1771.88 1616.42 1734.78 1646.51 1704.69 1646.51H764.363C727.261 1646.51 697.176 1609.41 697.176 1579.32V1570.69C697.176 1533.59 734.278 1503.5 764.363 1503.5Z',
      'M697.188 1753.76H1234.49C1271.6 1753.76 1301.68 1783.84 1301.68 1820.94V1829.57C1301.68 1866.68 1264.58 1896.76 1234.49 1896.76H697.188C660.085 1896.76 630 1859.66 630 1829.57V1820.94C630 1783.84 667.102 1753.76 697.188 1753.76Z',
      'M1436.04 1753.76H1503.17C1540.27 1753.76 1570.36 1783.84 1570.36 1820.94V1829.57C1570.36 1866.68 1533.26 1896.76 1503.17 1896.76H1436.04C1398.94 1896.76 1368.86 1859.66 1368.86 1829.57V1820.94C1368.86 1783.84 1405.96 1753.76 1436.04 1753.76Z'
    ]

    function BishengMark(props = {}) {
      const { size = 17, ...svgProps } = props
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 2400 2400',
          fill: 'none',
          'aria-hidden': 'true',
          ...svgProps
        },
        React.createElement('rect', { width: 2400, height: 2400, rx: 360, fill: '#034FE5' }),
        ...BISHENG_MARK_PATHS.map((d, index) =>
          React.createElement('path', { key: index, d, fill: 'white' })
        )
      )
    }

    function DesktopBrandMark() {
      return BishengMark({ size: 17 })
    }

    function DesktopBrandName() {
      return React.createElement('span', { style: { letterSpacing: '-0.01em' } }, 'BISHENG Work')
    }

    function ConversationBrandMark(props) {
      return BishengMark(props)
    }

    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('sidebar.brand.mark', () =>
        ctx.slots.inject('sidebar.brand.name', () =>
          ctx.slots.inject('conversation.hero.brand.mark', function* () {
            yield ctx.slots.register({ name: 'sidebar.brand.mark' }, DesktopBrandMark)
            yield ctx.slots.register({ name: 'sidebar.brand.name' }, DesktopBrandName)
            yield ctx.slots.register(
              { name: 'conversation.hero.brand.mark' },
              ConversationBrandMark
            )
          })
        )
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
