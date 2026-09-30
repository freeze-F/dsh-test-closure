/** Shared temporary-workspace helper for the tests that need real files on disk. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Materialize a throwaway workspace.
 * @param files - map of relative path to file contents.
 * @returns the absolute fixture root.
 */
export async function makeFixture(files) {
  const root = await mkdtemp(join(here, '.tmp-'))
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

/** Remove a fixture created by {@link makeFixture}. */
export async function dropFixture(root) {
  await rm(root, { recursive: true, force: true })
}
