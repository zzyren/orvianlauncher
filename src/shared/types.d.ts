import type { OrvianApi } from './ipc-contract'

declare global {
  interface Window {
    orvian: OrvianApi
  }
}
export {}
