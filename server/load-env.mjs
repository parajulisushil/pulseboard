import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'

// Capture the launch environment so deleted file entries do not survive validation.
export const launchEnvironment = { ...process.env }
export const envFilePath = fileURLToPath(new URL('../.env', import.meta.url))
if (!process.argv.includes('--check-config')) config({ path: envFilePath, override: true, quiet: true })
