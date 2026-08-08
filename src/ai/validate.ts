/**
 * The one validator.
 *
 * Every implementation and every test uses this function, because that shared
 * validation is the entire claim that mock is not a fork. If the mock had its own
 * checker, "the mock validates" would mean nothing.
 *
 * It is deliberately small: enough for the seven schemas in schemas.ts and nothing
 * more. No `$ref`, no recursion, no format assertions. A dependency would have
 * been more capable and less honest, because the interesting property here is that
 * the checks are the ones the model does NOT perform (see LOCAL_ONLY_KEYWORDS),
 * and those are exactly the boring ones: ranges, lengths, array bounds.
 *
 * Errors name the failing path, because "schema invalid" with no path is the same
 * as no error at all when a fixture is 200 lines long.
 */

import type { JsonSchema, JsonType } from './schemas'

export interface ValidationError {
  /** JSON-path-ish, e.g. `$.tags[2].confidence`. */
  path: string
  /** The keyword that failed, e.g. `maximum`, `enum`, `required`. */
  keyword: string
  message: string
}

export type ValidationResult<T> =
  | { ok: true; value: T; errors: [] }
  | { ok: false; value: undefined; errors: ValidationError[] }

export interface ValidateOptions {
  /** Stop after this many errors. Prevents a wrong-shaped payload producing hundreds. */
  maxErrors?: number
}

/**
 * Validates `value` against `schema`.
 *
 * Returns rather than throws, because on the live path an invalid output is a
 * routine, expected condition with its own UI state, not an exception. Callers
 * turn it into an `AiError('invalid_output')` at the seam where that is the right
 * shape.
 */
export function validate<T = unknown>(
  schema: JsonSchema,
  value: unknown,
  options: ValidateOptions = {},
): ValidationResult<T> {
  const errors: ValidationError[] = []
  const maxErrors = options.maxErrors ?? 40
  check(schema, value, '$', errors, maxErrors)
  if (errors.length > 0) return { ok: false, value: undefined, errors }
  return { ok: true, value: value as T, errors: [] }
}

/** One line per error, for a test message or a diagnostics blob. */
export function formatErrors(errors: readonly ValidationError[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join('\n')
}

function check(
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: ValidationError[],
  maxErrors: number,
): void {
  if (errors.length >= maxErrors) return

  // anyOf first: a nullable field is expressed as anyOf, so nothing below it
  // should complain about the branch that did not apply.
  if (schema.anyOf) {
    const branchFailures: ValidationError[][] = []
    for (const branch of schema.anyOf) {
      const branchErrors: ValidationError[] = []
      check(branch, value, path, branchErrors, maxErrors)
      if (branchErrors.length === 0) return
      branchFailures.push(branchErrors)
    }
    errors.push({
      path,
      keyword: 'anyOf',
      message:
        `matches none of the ${schema.anyOf.length} allowed shapes ` +
        `(${branchFailures.map((f) => f[0]?.keyword ?? 'unknown').join(', ')})`,
    })
    return
  }

  if (schema.const !== undefined) {
    if (value !== schema.const) {
      errors.push({ path, keyword: 'const', message: `must be ${JSON.stringify(schema.const)}` })
      return
    }
  }

  if (schema.type && !matchesType(schema.type, value)) {
    errors.push({
      path,
      keyword: 'type',
      message: `expected ${schema.type}, got ${describe(value)}`,
    })
    // Nothing below can be meaningful once the type is wrong.
    return
  }

  if (schema.enum) {
    if (!schema.enum.includes(value as string)) {
      errors.push({
        path,
        keyword: 'enum',
        message: `${JSON.stringify(value)} is not one of the ${schema.enum.length} allowed values`,
      })
      return
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, keyword: 'minimum', message: `${value} is below the minimum ${schema.minimum}` })
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, keyword: 'maximum', message: `${value} is above the maximum ${schema.maximum}` })
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({
        path,
        keyword: 'minLength',
        message: `length ${value.length} is below the minimum ${schema.minLength}`,
      })
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({
        path,
        keyword: 'maxLength',
        message: `length ${value.length} exceeds the maximum ${schema.maxLength}`,
      })
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({
        path,
        keyword: 'minItems',
        message: `${value.length} items is below the minimum ${schema.minItems}`,
      })
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({
        path,
        keyword: 'maxItems',
        message: `${value.length} items exceeds the maximum ${schema.maxItems}`,
      })
    }
    if (schema.uniqueItems === true) {
      const seen = new Set<string>()
      for (const item of value) {
        const key = stableKey(item)
        if (seen.has(key)) {
          errors.push({ path, keyword: 'uniqueItems', message: `duplicate item ${key}` })
          break
        }
        seen.add(key)
      }
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i += 1) {
        if (errors.length >= maxErrors) return
        check(schema.items, value[i], `${path}[${i}]`, errors, maxErrors)
      }
    }
    return
  }

  if (isPlainObject(value)) {
    const record = value as Record<string, unknown>

    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        errors.push({
          path: `${path}.${key}`,
          keyword: 'required',
          message: 'is required and absent. Optionality is expressed as an explicit null in this contract.',
        })
      }
    }

    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) {
          errors.push({
            path: `${path}.${key}`,
            keyword: 'additionalProperties',
            message: 'is not declared in the schema',
          })
        }
      }
    }

    if (schema.properties) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (errors.length >= maxErrors) return
        if (!(key in record)) continue // already reported by required
        check(child, record[key], `${path}.${key}`, errors, maxErrors)
      }
    }
  }
}

function matchesType(type: JsonType, value: unknown): boolean {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return isPlainObject(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'string') return typeof value === 'string'
  return typeof value === 'boolean'
}

/**
 * `null` is not an object here, and neither is an array.
 *
 * Both distinctions matter: `typeof null === 'object'` would let a null satisfy an
 * object schema and skip every required check underneath it, which is precisely
 * the failure that lets a truncated response look valid.
 */
function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number' && !Number.isInteger(value)) return 'number'
  return typeof value
}

function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(JSON.stringify(value))
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${k}:${stableKey(record[k])}`)
    .join(',')}}`
}
