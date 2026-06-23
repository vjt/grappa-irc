// Long-press variation tables. Each entry lists variants for a base key,
// WITHOUT the base — `variantsFor` prepends the base so it is always
// index 0. Ordering mirrors stock iOS US-English long-press menus.

const TABLE: Record<string, string[]> = {
  // vowels
  a: ["à", "á", "â", "ä", "æ", "ã", "å", "ā"],
  e: ["è", "é", "ê", "ë", "ē", "ė", "ę", "ə"],
  i: ["î", "ï", "í", "ī", "į", "ì"],
  o: ["ô", "ö", "ò", "ó", "œ", "ø", "ō", "õ"],
  u: ["û", "ü", "ù", "ú", "ū"],
  // consonants
  c: ["ç", "ć", "č"],
  n: ["ñ", "ń"],
  s: ["ś", "š", "ß"],
  z: ["ž", "ź", "ż"],
  y: ["ÿ"],
  l: ["ł"],
  g: [],
  // punctuation / symbols (iOS long-press extras)
  "-": ["–", "—", "•"],
  "/": ["\\"],
  "?": ["¿"],
  "!": ["¡"],
  "'": ["‘", "’", "`"],
  '"': ["“", "”", "„", "»", "«"],
  ".": ["…"],
  $: ["€", "£", "¥", "₩", "₽", "¢"],
  "&": ["§"],
  "%": ["‰"],
  "=": ["≠", "≈"],
};

// Returns [base, ...variants] when the key has variants, else []. An
// empty result means "no long-press menu for this key".
export function variantsFor(base: string): string[] {
  const v = TABLE[base];
  if (v === undefined || v.length === 0) return [];
  return [base, ...v];
}
