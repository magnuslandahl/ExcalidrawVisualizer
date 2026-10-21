import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const swedishHash = 'de6911330cbdc131362f7a955682b65c8a5a2394caba73e7ea821a9822efb8c6'

describe('bundled Swedish speech assets', () => {
  it('pins the reference GGML weights and verifies both cached and downloaded files', async () => {
    const script = await readFile('scripts/fetch-whisper-assets.mjs', 'utf8')
    expect(script).toContain('https://huggingface.co/KBLab/kb-whisper-small/resolve/3564d61a42fc210ceaa55a22a96dd64478959c78/ggml-model.bin')
    expect(script).toContain("path: join(modelRoot, 'ggml-kb-whisper-small.bin')")
    expect(script).toContain('size: 487_601_984')
    expect(script).toContain(swedishHash)
    expect(script).toContain('download(assets.swedish)')
    expect(script).toContain('await verifyFile(asset.path, asset)')
    expect(script).toContain('await verifyFile(partialPath, asset)')
  })

  it('bundles the model directory and complete KB-Whisper attribution/license', async () => {
    const [builder, notices] = await Promise.all([
      readFile('electron-builder.yml', 'utf8'),
      readFile('build/WHISPER-NOTICES.txt', 'utf8')
    ])
    expect(builder).toContain('from: vendor/whisper')
    expect(builder).toContain('from: build/WHISPER-NOTICES.txt')
    expect(notices).toContain('National Library of Sweden (KBLab)')
    expect(notices).toContain(swedishHash)
    expect(notices).toMatch(/Apache License\s+Version 2\.0/)
    expect(notices).toContain('END OF TERMS AND CONDITIONS')
  })

  it.each(['ci', 'release'])('verifies Swedish weights and licensing in %s packages', async (workflow) => {
    const text = await readFile(`.github/workflows/${workflow}.yml`, 'utf8')
    expect(text.split(swedishHash)).toHaveLength(3)
    expect(text).toContain('ggml-kb-whisper-small.bin')
    expect(text.match(/National Library of Sweden/g)).toHaveLength(2)
    expect(text.match(/END OF TERMS AND CONDITIONS/g)).toHaveLength(2)
  })
})
