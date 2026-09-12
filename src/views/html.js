class Raw {
  constructor(value) {
    this.value = value
  }
  toString() {
    return this.value
  }
}

export const esc = (value) =>
  String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })

export const raw = (value) => new Raw(value)

const render = (value) => {
  if (value === null || value === undefined || value === false) return ''
  if (Array.isArray(value)) return value.map(render).join('')
  if (value instanceof Raw) return value.value
  return esc(value)
}

/** Tagged template that escapes every interpolation unless it is wrapped in raw(). */
export const html = (strings, ...values) =>
  raw(strings.reduce((out, str, i) => out + render(values[i - 1]) + str))
