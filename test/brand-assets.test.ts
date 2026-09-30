import { readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')
const build = (...segments: string[]) => path.join(projectRoot, 'build', ...segments)

async function alphaBounds(file: string | Buffer) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let left = info.width
  let top = info.height
  let right = -1
  let bottom = -1

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * info.channels + 3] === 0) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }

  return { left, top, right, bottom }
}

async function largestIcnsPng(file: string) {
  const icns = await readFile(file)
  expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')

  let offset = 8
  let largest: Buffer | undefined
  while (offset < icns.length) {
    const length = icns.readUInt32BE(offset + 4)
    const payload = icns.subarray(offset + 8, offset + length)
    if (payload.subarray(1, 4).toString('ascii') === 'PNG') {
      if (!largest || payload.length > largest.length) largest = payload
    }
    offset += length
  }

  expect(largest).toBeDefined()
  return largest!
}

describe('BISHENG brand assets', () => {
  it('keeps the downloaded SVG artwork as the authoritative source', async () => {
    const mark = await readFile(build('bisheng-logo-mark.svg'), 'utf8')
    const horizontal = await readFile(build('bisheng-logo-horizontal.svg'), 'utf8')

    expect(mark).toContain('viewBox="0 0 2400 2400"')
    expect(mark).toContain('fill="#000000"')
    expect(mark).not.toContain('#034FE5')
    expect(mark.match(/<path /g)).toHaveLength(8)
    expect(horizontal).toContain('viewBox="0 0 8220 2400"')
    expect(horizontal).toContain('fill="#000000"')
    expect(horizontal).not.toContain('#034FE5')
    expect(await readFile(build('brand-mark.svg'), 'utf8')).toBe(mark)
    expect(await readFile(build('logo-light.svg'), 'utf8')).toBe(mark)
  })

  it('keeps the logo black while preserving blue for ordinary product UI', async () => {
    const desktopBrand = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-client-ui', 'client.js'),
      'utf8'
    )
    const mobilePages = await readFile(
      path.join(projectRoot, 'src', 'main', 'mobile', 'lan-mobile-pages.ts'),
      'utf8'
    )

    expect(desktopBrand).toContain("fill: '#000000'")
    expect(desktopBrand).not.toContain("fill: '#034FE5'")
    expect(mobilePages).toContain('--brand:#034FE5')
  })

  it('ships correctly sized raster derivatives', async () => {
    const cases = [
      [build('app-icon.png'), 1024, 1024],
      [build('icon.png'), 1024, 1024],
      [build('logo-light.png'), 240, 240],
      [build('logo-dark.png'), 240, 240],
      [path.join(projectRoot, 'docs', 'images', 'readme-logo-black-v020.png'), 1644, 480]
    ] as const
    for (const [file, width, height] of cases) {
      await expect(sharp(file).metadata()).resolves.toMatchObject({ width, height })
    }
  })

  it('uses a macOS safe area without shrinking full-bleed web artwork', async () => {
    await expect(alphaBounds(build('app-icon.png'))).resolves.toEqual({
      left: 100,
      top: 100,
      right: 923,
      bottom: 923
    })
    await expect(alphaBounds(build('icon.png'))).resolves.toEqual({
      left: 0,
      top: 0,
      right: 1023,
      bottom: 1023
    })
  })

  it('builds the macOS icns from the same padded app icon', async () => {
    const largestFrame = await largestIcnsPng(build('icon.icns'))

    await expect(sharp(largestFrame).metadata()).resolves.toMatchObject({
      width: 1024,
      height: 1024
    })
    await expect(alphaBounds(largestFrame)).resolves.toEqual({
      left: 100,
      top: 100,
      right: 923,
      bottom: 923
    })

    const generator = await readFile(
      path.join(projectRoot, 'scripts', 'generate-app-icons.mjs'),
      'utf8'
    )
    expect(generator).toContain('await sharp(appIcon).resize(size, size)')
    expect(generator).toContain('await sharp(appIcon).resize(size * 2, size * 2)')
  })

  it('keeps the startup splash text-only and bilingual', async () => {
    const splash = await readFile(build('splash.html'), 'utf8')

    expect(splash).toContain('Starting BISHENG Work')
    expect(splash).toContain('First launch may take a moment.')
    expect(splash).toContain('正在启动 BISHENG Work')
    expect(splash).toContain('首次启动可能需要一点时间。')
    expect(splash).toContain('data-platform="windows"')
    expect(splash).toContain("data-theme='dark'")
    expect(splash).not.toMatch(/<img\b/u)
    expect(splash).not.toMatch(/\.gif\b/u)
  })

  it('records actual manifest dimensions', async () => {
    const installer = await readFile(
      path.join(projectRoot, 'scripts', 'install-brand-assets.mjs'),
      'utf8'
    )

    expect(installer).toContain('readPngDimensions(iconContents')
    expect(installer).not.toContain("target.sizes = '1254x1254'")
  })
})
