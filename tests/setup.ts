import { initLogger } from '../electron/logger'

// Tests assert on behaviour, not log output; keep the console readable.
initLogger({ level: 'silent' })
