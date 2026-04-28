import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Check, Copy, Eye, EyeOff } from 'lucide-react'
import type { CredentialField } from '@/types/electron'
import { normalizeCredentialFields, sanitizeCredentialValue, sortCredentialFields } from '../../../../shared/credentialFields'

interface CredentialFieldsRendererProps {
  fields: CredentialField[]
  credentials: Record<string, string>
  onChange: (fieldName: string, value: string) => void
}

export function CredentialFieldsRenderer({ fields, credentials, onChange }: CredentialFieldsRendererProps) {
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>({})
  const [copiedFields, setCopiedFields] = useState<Record<string, boolean>>({})
  const sortedFields = useMemo(
    () => sortCredentialFields(normalizeCredentialFields(fields)).filter((field) => field.enabled !== false),
    [fields],
  )

  const toggleFieldVisibility = (fieldName: string) => {
    setVisibleFields((prev) => ({ ...prev, [fieldName]: !prev[fieldName] }))
  }

  const copyToClipboard = async (fieldName: string, value: string) => {
    if (!value) return
    await navigator.clipboard.writeText(value)
    setCopiedFields((prev) => ({ ...prev, [fieldName]: true }))
    setTimeout(() => setCopiedFields((prev) => ({ ...prev, [fieldName]: false })), 2000)
  }

  return (
    <div className="space-y-4">
      {sortedFields.map((field) => {
        const isSecret = field.secret ?? field.type === 'password'
        const isVisible = visibleFields[field.name]
        const isCopied = copiedFields[field.name]
        const value = credentials[field.name] || ''
        const renderedType = isSecret && !isVisible ? 'password' : field.type === 'number' ? 'number' : 'text'

        return (
          <div key={field.name} className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor={field.name}>{field.label}</Label>
              {field.required && <Badge variant="outline" className="text-xs">Required</Badge>}
            </div>
            {field.type === 'textarea' || field.type === 'json' ? (
              <div className="relative">
                <textarea
                  id={field.name}
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm pr-20"
                  placeholder={field.placeholder}
                  value={value}
                  onChange={(e) => onChange(field.name, sanitizeCredentialValue(e.target.value, field.sanitize))}
                />
                <div className="absolute right-1 top-1 flex gap-0.5">
                  <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => copyToClipboard(field.name, value)} disabled={!value}>
                    {isCopied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
                  </Button>
                  {isSecret && (
                    <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => toggleFieldVisibility(field.name)}>
                      {isVisible ? <EyeOff className="h-4 w-4 text-muted-foreground" /> : <Eye className="h-4 w-4 text-muted-foreground" />}
                    </Button>
                  )}
                </div>
              </div>
            ) : field.type === 'select' ? (
              <Select
                value={value}
                onValueChange={(next) => onChange(field.name, sanitizeCredentialValue(next, field.sanitize))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={field.placeholder || `Select ${field.label}`} />
                </SelectTrigger>
                <SelectContent>
                  {(field.options || []).map((option) => (
                    <SelectItem key={`${field.name}-${option.value}`} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="relative">
                <Input
                  id={field.name}
                  type={renderedType}
                  placeholder={field.placeholder}
                  value={value}
                  onChange={(e) => onChange(field.name, sanitizeCredentialValue(e.target.value, field.sanitize))}
                  className={isSecret ? 'pr-20' : undefined}
                />
                {isSecret && (
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5">
                    <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => copyToClipboard(field.name, value)} disabled={!value}>
                      {isCopied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => toggleFieldVisibility(field.name)}>
                      {isVisible ? <EyeOff className="h-4 w-4 text-muted-foreground" /> : <Eye className="h-4 w-4 text-muted-foreground" />}
                    </Button>
                  </div>
                )}
              </div>
            )}
            {field.helpText && <p className="text-xs text-muted-foreground">{field.helpText}</p>}
          </div>
        )
      })}
    </div>
  )
}

export default CredentialFieldsRenderer
