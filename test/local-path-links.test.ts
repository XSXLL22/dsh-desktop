import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { patchPath, projectRoot } from './patch-path'

interface LocalPath {
  path: string
  kind: 'file' | 'folder'
}

/**
 * The patch is the source of truth for this helper: `node_modules` may hold a
 * different Harness build than the one the patch targets, so read the added
 * lines straight out of the patch and evaluate them.
 */
async function loadLocalPathReference(): Promise<
  (value: string) => LocalPath | undefined
> {
  const patch = await readFile(
    patchPath('@deepseek-ai/dsh-client-ui-deliverables'),
    'utf8'
  )
  const added = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n')
  const source = extractFunction(added, 'localPathReference')
  const rawSuffix = extractFunction(added, 'rawSuffix')
  const extension = extractFunction(added, 'fileExtensionOf')
  expect(source).toBeDefined()
  expect(rawSuffix).toBeDefined()
  expect(extension).toBeDefined()
  return new Function(
    `${source}\n${rawSuffix}\n${extension}\nreturn localPathReference`
  )() as (value: string) => LocalPath | undefined
}

interface FolderOpenFailure {
  details?: { reason?: string; path?: string }
  message?: string
}

interface FolderOpenResult {
  ok: boolean
  error?: FolderOpenFailure
}

/**
 * The applied client bundle is what Harness loads. The patch assertions below
 * still require these helpers to be recorded there, so a node_modules-only edit
 * cannot pass.
 */
async function loadFolderOpen(): Promise<{
  workspaceOpenCandidates: (cwd: string | undefined, value: string) => string[]
  openFolderInFileManager: (
    openWorkspacePath: (request: { path: string }) => Promise<FolderOpenResult>,
    cwd: string | undefined,
    value: string
  ) => Promise<void>
}> {
  const client = await readFile(
    path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-chat', 'lib', 'client.js'),
    'utf8'
  )
  const names = [
    'isWindowsStylePath',
    'isAbsoluteWorkspacePath',
    'hostPathForOpen',
    'workspaceOpenCandidates',
    'missingFolderMessage',
    'openFolderInFileManager'
  ]
  const source = names.map((name) => {
    const body = extractFunction(client, name)
    expect(body, name).toBeDefined()
    return body
  }).join('\n')
  return new Function(`${source}\nreturn { workspaceOpenCandidates, openFolderInFileManager }`)() as {
    workspaceOpenCandidates: (cwd: string | undefined, value: string) => string[]
    openFolderInFileManager: (
      openWorkspacePath: (request: { path: string }) => Promise<FolderOpenResult>,
      cwd: string | undefined,
      value: string
    ) => Promise<void>
  }
}

async function loadPathOpenFailureMessage(): Promise<(error: unknown) => string> {
  const host = await readFile(
    path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh-api-session-controller', 'lib', 'index.js'),
    'utf8'
  )
  const source = extractFunction(host, 'pathOpenFailureMessage')
  expect(source).toBeDefined()
  return new Function(`${source}\nreturn pathOpenFailureMessage`)() as (error: unknown) => string
}

/** Pull one `function name(...) { ... }` out of the patch's added source. */
function extractFunction(source: string, name: string): string | undefined {
  const marker = `function ${name}(`
  let start = source.indexOf(marker)
  if (start < 0) return undefined
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return undefined
}

describe('assistant local path links', () => {
  it('keeps produced paths ahead of the heuristic and opens folders outside preview', async () => {
    const patch = await readFile(
      patchPath('@deepseek-ai/dsh-client-ui-deliverables'),
      'utf8'
    )
    const primitives = await readFile(
      patchPath('@deepseek-ai/dsh-client-ui-primitives'),
      'utf8'
    )
    const chat = await readFile(
      patchPath('@deepseek-ai/dsh-client-ui-chat'),
      'utf8'
    )

    expect(patch).toContain('onlyPathWithBasename(paths, value)')
    expect(patch).toContain('localPathReference(value)')
    expect(patch).toContain('revealInFileManager: true')
    expect(patch).toContain('kind === "folder"')
    expect(patch).toContain('presented.openFolder')
    expect(patch).toContain('在文件管理器中打开 {name}')
    // Upstream bails out of `forClosing` when the turn produced and presented
    // nothing; the patch drops that guard so a mention still resolves against
    // an empty deliverable set.
    expect(patch).toContain('-\t\t\t\tif (paths === null && presented.length === 0) return void 0;')
    expect(primitives).toContain('mention.kind === "folder" ? "folder"')
    expect(primitives).toContain('kind?: "file" | "folder"')
    expect(chat).toContain('options?.revealInFileManager === true')
    expect(chat).toContain('openFolderInFileManager((request) => ctx.remote.session.openWorkspacePath(request), cwd, path)')
    expect(chat).toContain('reason === "PATH_NOT_FOUND" && index === 0 && candidates.length > 1')
    expect(chat).toContain('throw opened.error')
    expect(chat).toContain('requestOpenFile(fileOpenError.path, fileOpenError.options)')
    expect(chat).toContain('readonly revealInFileManager?: boolean')
  })

  it('resolves workspace files and explicit directories', async () => {
    const localPathReference = await loadLocalPathReference()

    expect(localPathReference('src/main.ts')).toEqual({ path: 'src/main.ts', kind: 'file' })
    expect(localPathReference('./scripts/build.mjs')).toEqual({
      path: './scripts/build.mjs',
      kind: 'file'
    })
    expect(localPathReference('../sibling/file.txt')).toEqual({
      path: '../sibling/file.txt',
      kind: 'file'
    })
    expect(localPathReference('C:\\Users\\me\\file.txt')).toEqual({
      path: 'C:\\Users\\me\\file.txt',
      kind: 'file'
    })
    expect(localPathReference('~/notes.md')).toEqual({ path: '~/notes.md', kind: 'file' })
    expect(localPathReference('node_modules/@foo/bar/lib/client.js')).toEqual({
      path: 'node_modules/@foo/bar/lib/client.js',
      kind: 'file'
    })
    expect(localPathReference('docs/')).toEqual({ path: 'docs/', kind: 'folder' })
    expect(localPathReference('/etc/hosts')).toEqual({ path: '/etc/hosts', kind: 'folder' })
    expect(localPathReference('/private/tmp/somedir')).toEqual({
      path: '/private/tmp/somedir',
      kind: 'folder'
    })
    expect(localPathReference('/private/tmp/dsh-market-installer.EZeHSP')).toEqual({
      path: '/private/tmp/dsh-market-installer.EZeHSP',
      kind: 'folder'
    })
    expect(localPathReference('dsh-main-acceptance.UWeor9')).toEqual({
      path: 'dsh-main-acceptance.UWeor9',
      kind: 'folder'
    })
    expect(localPathReference('dsh-rc7-audit.XvPgKX/desktop')).toEqual({
      path: 'dsh-rc7-audit.XvPgKX/desktop',
      kind: 'folder'
    })
  })

  it('keeps branch names, packages, emails, versions, and bare tokens inert', async () => {
    const localPathReference = await loadLocalPathReference()

    for (const value of [
      'codex/startup-timing-diagnostics',
      'codex/windows-titlebar-menu',
      'origin/main',
      'src/components',
      'application/json',
      'CI/CD',
      '@deepseek-ai/cordis',
      '@foo/bar@1.0.0',
      'user@example.com',
      'v0.8.0',
      '0.8.0',
      '1.2.3-rc.1',
      'console.log',
      'process.env',
      'package.json',
      'file:///tmp/report.txt',
      'https://example.com/src/main.ts',
      'ftp://host/report.txt',
      'ws://host/socket.js',
      'npm install',
      'someFunction',
      '',
      '   '
    ]) {
      expect(localPathReference(value), value).toBeUndefined()
    }
  })

  it('still resolves paths that merely contain an @ segment', async () => {
    const localPathReference = await loadLocalPathReference()

    expect(localPathReference('./@scope/pkg')).toEqual({ path: './@scope/pkg', kind: 'folder' })
    expect(localPathReference('/tmp/@scope/pkg/index.js')).toEqual({
      path: '/tmp/@scope/pkg/index.js',
      kind: 'file'
    })
    expect(localPathReference('patches/@deepseek-ai+dsh-client-ui-deliverables+0.1.6-alpha.2.patch')).toEqual({
      path: 'patches/@deepseek-ai+dsh-client-ui-deliverables+0.1.6-alpha.2.patch',
      kind: 'file'
    })
    expect(localPathReference('patches/@deepseek-ai+dsh-client-ui-deliverables+0.1.5-rc.2.patch')).toEqual({
      path: 'patches/@deepseek-ai+dsh-client-ui-deliverables+0.1.5-rc.2.patch',
      kind: 'file'
    })
    expect(localPathReference('@scope/pkg@1.2.3/dist/index.js')).toEqual({
      path: '@scope/pkg@1.2.3/dist/index.js',
      kind: 'file'
    })
  })

  it('keeps the literal folder path ahead of a workspace-name overlap', async () => {
    const { workspaceOpenCandidates } = await loadFolderOpen()
    const cwd = '/work/deepseek-harness/default-workspace'

    expect(workspaceOpenCandidates(cwd, 'default-workspace/城市晨间通勤观察/')).toEqual([
      `${cwd}/default-workspace/城市晨间通勤观察/`,
      `${cwd}/城市晨间通勤观察`
    ])
    expect(workspaceOpenCandidates(cwd, '城市晨间通勤观察/')).toEqual([
      `${cwd}/城市晨间通勤观察/`
    ])
    expect(workspaceOpenCandidates(cwd, '/etc/hosts')).toEqual(['/etc/hosts'])
    expect(workspaceOpenCandidates(undefined, 'docs/')).toEqual(['docs/'])
    expect(workspaceOpenCandidates(cwd, 'deepseek-harness/default-workspace/foo/')).toEqual([
      `${cwd}/deepseek-harness/default-workspace/foo/`,
      `${cwd}/foo`
    ])
    expect(workspaceOpenCandidates('/work/Reports', 'reports/q1/')).toEqual([
      '/work/Reports/reports/q1/'
    ])
    expect(workspaceOpenCandidates('C:\\Users\\me\\Default-Workspace', 'default-workspace/城市晨间通勤观察/')).toEqual([
      'C:/Users/me/Default-Workspace/default-workspace/城市晨间通勤观察/',
      'C:/Users/me/Default-Workspace/城市晨间通勤观察'
    ])
  })

  it('retries a missing folder only when the literal path is absent', async () => {
    const { openFolderInFileManager } = await loadFolderOpen()
    const cwd = '/work/deepseek-harness/default-workspace'
    const mention = 'default-workspace/城市晨间通勤观察/'
    const literal = `${cwd}/default-workspace/城市晨间通勤观察/`
    const deduped = `${cwd}/城市晨间通勤观察`

    const calls: string[] = []
    await openFolderInFileManager(async (request) => {
      calls.push(request.path)
      if (request.path === literal) {
        return { ok: false, error: { details: { reason: 'PATH_NOT_FOUND', path: request.path } } }
      }
      return { ok: true }
    }, cwd, mention)
    expect(calls).toEqual([literal, deduped])

    const present: string[] = []
    await openFolderInFileManager(async (request) => {
      present.push(request.path)
      return { ok: true }
    }, cwd, mention)
    expect(present).toEqual([literal])

    const denied: string[] = []
    const permission = { message: 'path open failed: EACCES', details: { reason: 'EACCES' } }
    await expect(openFolderInFileManager(async (request) => {
      denied.push(request.path)
      return { ok: false, error: permission }
    }, cwd, mention)).rejects.toBe(permission)
    expect(denied).toEqual([literal])

    const openerFailure = { message: 'path open failed: Command failed: open', details: {} }
    const opened: string[] = []
    await expect(openFolderInFileManager(async (request) => {
      opened.push(request.path)
      return { ok: false, error: openerFailure }
    }, cwd, mention)).rejects.toBe(openerFailure)
    expect(opened).toEqual([literal])

    await expect(openFolderInFileManager(async (request) => {
      return { ok: false, error: { details: { reason: 'PATH_NOT_FOUND', path: request.path } } }
    }, cwd, mention)).rejects.toThrow(`Path does not exist: ${deduped}`)
  })

  it('keeps the native opener cause in the path-open failure', async () => {
    const pathOpenFailureMessage = await loadPathOpenFailureMessage()
    const sessionPatch = await readFile(patchPath('@deepseek-ai/dsh-api-session-controller'), 'utf8')

    expect(pathOpenFailureMessage(new Error('The file /tmp/a does not exist'))).toBe(
      'path open failed: The file /tmp/a does not exist'
    )
    expect(pathOpenFailureMessage(new Error('path open failed'))).toBe('path open failed')
    expect(pathOpenFailureMessage('boom')).toBe('path open failed: boom')
    expect(pathOpenFailureMessage(new Error(''))).toBe('path open failed')
    expect(sessionPatch).toContain('reason: "PATH_NOT_FOUND"')
    expect(sessionPatch).toContain('pathOpenFailureMessage(error)')
    expect(sessionPatch).toContain('fs.stat(resolved, signal)')
  })

  it('strips line and column suffixes from resolved paths', async () => {
    const localPathReference = await loadLocalPathReference()

    expect(localPathReference('src/main.ts#L42')).toEqual({ path: 'src/main.ts', kind: 'file' })
    expect(localPathReference('src/main.ts:42:7')).toEqual({ path: 'src/main.ts', kind: 'file' })
  })
})
