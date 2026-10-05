/**
 * Removes credentials from free text before it is written to a log, copied to the clipboard
 * or sent to the renderer. Pure and dependency-free so it can run in any process.
 */
const RULES: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer ***'],
  [/--accessToken\s+\S+/g, '--accessToken ***'],
  [/("?(?:access_?token|refresh_?token|auth_access_token|auth_session|client_secret)"?\s*[:=]\s*"?)[^"\s,&}]+/gi, '$1***'],
  [/([?&](?:code|token|access_token|refresh_token)=)[^&\s]+/gi, '$1***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh*_***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '<jwt>']
]

export function redactSecrets(input: string): string {
  let out = input
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}
