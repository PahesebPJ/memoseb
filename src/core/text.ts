// Shared text normalization for FTS queries and the lexical embedder.
// Both sides must tokenize identically, otherwise accented words
// ("sincronización") never match what SQLite's unicode61 tokenizer indexed.

const STOPWORDS_ES = [
  'a', 'al', 'algo', 'ante', 'aqui', 'asi', 'cada', 'como', 'con', 'cual', 'cuales',
  'cuando', 'de', 'del', 'desde', 'donde', 'e', 'el', 'ella', 'ellos', 'en', 'entre',
  'era', 'es', 'esa', 'ese', 'eso', 'esta', 'estan', 'este', 'esto', 'estos', 'estas',
  'fue', 'ha', 'han', 'hay', 'la', 'las', 'le', 'les', 'lo', 'los', 'mas', 'me', 'mi',
  'muy', 'no', 'nos', 'o', 'para', 'pero', 'por', 'porque', 'que', 'quien', 'se', 'ser',
  'si', 'sin', 'sobre', 'son', 'su', 'sus', 'tambien', 'te', 'tu', 'u', 'un', 'una',
  'unas', 'uno', 'unos', 'y', 'ya', 'yo'
]

const STOPWORDS_EN = [
  'about', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'did', 'do', 'does', 'for',
  'from', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'my', 'of', 'on', 'or', 'our',
  'should', 'so', 'that', 'the', 'their', 'there', 'these', 'they', 'this', 'those', 'to',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'would', 'you', 'your'
]

export const STOPWORDS: ReadonlySet<string> = new Set([...STOPWORDS_ES, ...STOPWORDS_EN])

/** Lowercase and strip diacritics: "Sincronización" -> "sincronizacion". */
export function normalizeText(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '')
}

export function tokenizeWords(text: string): string[] {
  // Same separators as FTS5 unicode61: "_" splits "sync_groups" into two tokens.
  return normalizeText(text).match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * Tokens without stopwords. Falls back to every token when the text is made
 * only of stopwords, so a query like "how" still matches something.
 */
export function contentTokens(text: string): string[] {
  const tokens = tokenizeWords(text)
  const meaningful = tokens.filter((token) => !STOPWORDS.has(token))
  return meaningful.length > 0 ? meaningful : tokens
}
