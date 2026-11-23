/** Removes personal data before any text leaves the computer. */
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[cpf]')
    .replace(/\b\d{5}-?\d{3}\b/g, '[cep]')
    .replace(/(\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}/g, '[phone]')
    .replace(/\b(rua|avenida|av\.|travessa|alameda)\s[^\n,]{2,60}(,\s?\d+)?/gi, '[address]');
}
