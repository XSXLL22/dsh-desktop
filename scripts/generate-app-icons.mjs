import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDirectory = path.join(projectRoot, 'build')
const markSource = path.join(buildDirectory, 'bisheng-logo-mark.svg')
const horizontalSource = path.join(buildDirectory, 'bisheng-logo-horizontal.svg')
const appIcon = path.join(buildDirectory, 'app-icon.png')
const webIcon = path.join(buildDirectory, 'icon.png')
const iconsetDirectory = path.join(buildDirectory, 'app-icon.iconset')
const icnsDestination = path.join(buildDirectory, 'icon.icns')
const icoDestination = path.join(buildDirectory, 'icon.ico')
const appIconCanvasSize = 1024
const appIconMarkSize = 824
const sourceMarkBackground = '<rect width="2400" height="2400" rx="360" fill="#000000"/>'
const macAppIconBackground = '<rect width="2400" height="2400" rx="512" fill="#000000"/>'

const markSvg = await readFile(markSource)
const horizontalSvg = await readFile(horizontalSource)

function createMacAppIconSvg(svg) {
  const source = svg.toString('utf8')
  const matches = source.split(sourceMarkBackground).length - 1
  if (matches !== 1) {
    throw new Error(
      `Expected exactly one authoritative BISHENG mark background (${sourceMarkBackground}); found ${matches}.`
    )
  }

  // macOS does not publish one fixed corner radius for legacy ICNS artwork.
  // This radius matches the contour of Apple's icon template and current system
  // icons while the 824 px footprint preserves the existing 100 px safe area.
  return Buffer.from(source.replace(sourceMarkBackground, macAppIconBackground))
}

async function rasterise(svg, width, height, destination) {
  await sharp(svg)
    .resize(width, height, { fit: 'contain' })
    .png()
    .toFile(destination)
}

async function rasterisePaddedAppIcon(svg, destination) {
  const mark = await sharp(svg)
    .resize(appIconMarkSize, appIconMarkSize, { fit: 'contain' })
    .png()
    .toBuffer()

  await sharp({
    create: {
      width: appIconCanvasSize,
      height: appIconCanvasSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([{
      input: mark,
      left: (appIconCanvasSize - appIconMarkSize) / 2,
      top: (appIconCanvasSize - appIconMarkSize) / 2
    }])
    .png()
    .toFile(destination)
}

// These SVGs are compatibility aliases consumed by older runtime surfaces.
// The bisheng-logo-* files above remain the only authoritative source artwork.
await copyFile(markSource, path.join(buildDirectory, 'brand-mark.svg'))
await copyFile(markSource, path.join(buildDirectory, 'logo-light.svg'))
await rasterisePaddedAppIcon(createMacAppIconSvg(markSvg), appIcon)
await rasterise(markSvg, 1024, 1024, webIcon)
await rasterise(markSvg, 240, 240, path.join(buildDirectory, 'logo-light.png'))
await rasterise(markSvg, 240, 240, path.join(buildDirectory, 'logo-dark.png'))
await rasterise(
  horizontalSvg,
  1644,
  480,
  path.join(projectRoot, 'docs', 'images', 'readme-logo-black-v020.png')
)

await rm(iconsetDirectory, { recursive: true, force: true })
await mkdir(iconsetDirectory, { recursive: true })
for (const size of [16, 32, 128, 256, 512]) {
  await sharp(appIcon).resize(size, size).png().toFile(
    path.join(iconsetDirectory, `icon_${size}x${size}.png`)
  )
  await sharp(appIcon).resize(size * 2, size * 2).png().toFile(
    path.join(iconsetDirectory, `icon_${size}x${size}@2x.png`)
  )
}
execFileSync('iconutil', ['-c', 'icns', iconsetDirectory, '-o', icnsDestination])

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icoDirectory = await mkdtemp(path.join(os.tmpdir(), 'bisheng-work-icons-'))
try {
  const icoImages = []
  for (const size of icoSizes) {
    const destination = path.join(icoDirectory, `icon-${size}.png`)
    await sharp(markSvg).resize(size, size).png().toFile(destination)
    icoImages.push(await readFile(destination))
  }
  const header = Buffer.alloc(6 + icoImages.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(icoImages.length, 4)

  let offset = header.length
  for (let index = 0; index < icoImages.length; index += 1) {
    const size = icoSizes[index]
    const entry = 6 + index * 16
    header.writeUInt8(size === 256 ? 0 : size, entry)
    header.writeUInt8(size === 256 ? 0 : size, entry + 1)
    header.writeUInt8(0, entry + 2)
    header.writeUInt8(0, entry + 3)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(icoImages[index].length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += icoImages[index].length
  }
  await writeFile(icoDestination, Buffer.concat([header, ...icoImages]))
} finally {
  await rm(icoDirectory, { recursive: true, force: true })
}

console.log('Generated BISHENG app, web, mobile, README, macOS, and Windows brand assets.')
