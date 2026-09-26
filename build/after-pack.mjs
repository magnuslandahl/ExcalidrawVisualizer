import { execFileSync } from 'node:child_process'
import path from 'node:path'

export default async function adHocSignMacBundle(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('  • skipping ad-hoc signing: a signing certificate is configured')
    return
  }

  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit'
  })

  console.log(`  • ad-hoc signed ${path.basename(appPath)}`)
}
