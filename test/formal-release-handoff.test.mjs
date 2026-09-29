import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import YAML from 'yaml'

it('uses a draft release for formal handoff and publishes ModelScope only after verification', async () => {
  const source = await readFile(path.resolve(import.meta.dirname, '../.github/workflows/release.yml'), 'utf8')
  const jobs = YAML.parse(source).jobs
  const step = (job, name) => jobs[job].steps.find(item => item.name === name)
  const formal = "startsWith(github.ref, 'refs/tags/v')"

  expect(step('validate-dispatch', 'Prepare draft release for formal build handoff').if).toBe(formal)
  for (const [job, name] of [
    ['macos-apple-silicon', 'Stage signed Apple Silicon assets in draft release'],
    ['macos-intel', 'Stage signed Intel assets in draft release'],
    ['windows-x64', 'Stage unsigned Windows assets in draft release'],
    ['sign-windows', 'Stage signed Windows assets in draft release']
  ]) {
    expect(step(job, name).if).toBe(formal)
    expect(step(job, name).run).toContain('gh release upload')
  }
  for (const job of ['macos-apple-silicon', 'macos-intel', 'windows-x64', 'sign-windows']) {
    for (const item of jobs[job].steps.filter(item => item.uses?.startsWith('actions/upload-artifact@'))) {
      expect(item.if).toContain("github.event_name == 'workflow_dispatch'")
    }
  }

  expect(step('sign-windows', 'Download unsigned Windows assets from draft release').run)
    .toContain('verify-release-staging.mjs')
  const windowsSteps = jobs['windows-x64'].steps.map(item => item.name)
  expect(windowsSteps.indexOf('Smoke test packaged Windows Harness'))
    .toBeLessThan(windowsSteps.indexOf('Publish checked Windows Dev installer to ModelScope'))
  expect(step('windows-x64', 'Publish checked Windows Dev installer to ModelScope').if)
    .toContain('github.event.pull_request.head.repo.full_name == github.repository')
  expect(jobs.publish.steps.some(item => item.uses?.startsWith('actions/download-artifact@'))).toBe(false)
  const names = jobs.publish.steps.map(item => item.name)
  expect(names.indexOf('Download verified platform assets from draft release'))
    .toBeLessThan(names.indexOf('Verify release assets before publication'))
  expect(names.indexOf('Verify release assets before publication'))
    .toBeLessThan(names.indexOf('Mirror formal release to ModelScope'))
  expect(names.indexOf('Verify public ModelScope update metadata'))
    .toBeLessThan(names.indexOf('Publish verified GitHub release'))
})
