export interface NormalizedMimoCredentials {
  serviceToken: string
  userId: string
  phToken: string
}

function trimCredentialValue(value: string | undefined): string {
  return (value || '').trim()
}

function stripOneLayerMatchingQuotes(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
    return value.slice(1, -1).trim()
  }
  return value
}

export function normalizeMimoCredentials(credentials: Record<string, string>): NormalizedMimoCredentials {
  const rawServiceToken = trimCredentialValue(credentials.service_token || credentials.serviceToken)
  const rawUserId = trimCredentialValue(credentials.user_id || credentials.userId)
  const rawPhToken = trimCredentialValue(credentials.ph_token || credentials.xiaomichatbot_ph)

  return {
    serviceToken: stripOneLayerMatchingQuotes(rawServiceToken),
    userId: rawUserId,
    phToken: stripOneLayerMatchingQuotes(rawPhToken),
  }
}
