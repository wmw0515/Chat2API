import type { CredentialField } from './types'

export const DEFAULT_CREDENTIAL_FIELD_ORDER = 10_000

const FIELD_TYPES = new Set(['text', 'password', 'textarea', 'number', 'select', 'json'])
const SANITIZE_TYPES = new Set(['none', 'singleLine', 'cookie', 'numeric', 'jwt'])

export function sortCredentialFields(fields: CredentialField[] = []): CredentialField[] {
  return fields
    .map((field, index) => ({ field, index }))
    .sort((a, b) => {
      const orderA = Number.isFinite(a.field.order) ? Number(a.field.order) : DEFAULT_CREDENTIAL_FIELD_ORDER
      const orderB = Number.isFinite(b.field.order) ? Number(b.field.order) : DEFAULT_CREDENTIAL_FIELD_ORDER
      if (orderA !== orderB) return orderA - orderB
      return a.index - b.index
    })
    .map(({ field }) => field)
}

export function normalizeCredentialField(field: CredentialField, index = 0): CredentialField {
  const trimmedName = String(field.name || '').trim()
  const safeType = FIELD_TYPES.has(field.type) ? field.type : 'text'
  const safeSanitize = field.sanitize && SANITIZE_TYPES.has(field.sanitize) ? field.sanitize : 'none'

  return {
    ...field,
    name: trimmedName,
    label: String(field.label || trimmedName || `field_${index + 1}`).trim(),
    type: safeType,
    required: Boolean(field.required),
    secret: field.secret ?? safeType === 'password',
    order: Number.isFinite(field.order) ? Number(field.order) : DEFAULT_CREDENTIAL_FIELD_ORDER + index,
    sanitize: safeSanitize,
    enabled: field.enabled ?? true,
    options: safeType === 'select' ? (field.options || []) : undefined,
  }
}

export function normalizeCredentialFields(fields: CredentialField[] = []): CredentialField[] {
  const seen = new Set<string>()
  const normalized: CredentialField[] = []

  fields.forEach((field, index) => {
    const safeField = normalizeCredentialField(field, index)
    if (!safeField.name || seen.has(safeField.name)) {
      return
    }
    seen.add(safeField.name)
    normalized.push(safeField)
  })

  return normalized
}

export function sanitizeCredentialValue(value: string, mode: CredentialField['sanitize'] = 'none'): string {
  const raw = String(value ?? '')
  switch (mode) {
    case 'singleLine':
      return raw.replace(/\r?\n|\r/g, ' ').trim()
    case 'cookie':
      return raw.replace(/\r?\n|\r/g, '; ').trim()
    case 'numeric':
      return raw.replace(/[^\d]/g, '')
    case 'jwt':
      return raw.replace(/\s+/g, '')
    case 'none':
    default:
      return raw
  }
}

