// Maps a country *name* (as start.gg's API returns it, e.g. "United States")
// to a flag emoji, so providers can auto-populate the `flag` field.
//
// start.gg's location API gives a full English country name and its own
// numeric id — not an ISO code. Themes accept an emoji (or ISO-2) and can
// resolve it to an SVG, so we map name → ISO-2 → emoji.
//
// Adapted verbatim from the Tally / StreamScoreboard roster importer; aliases
// cover the spots where start.gg's naming differs (e.g. "Korea, Republic of").

// label -> ISO-3166 alpha-2.
const PICKER_CODES = {
  'canada': 'CA', 'cuba': 'CU', 'dominican republic': 'DO', 'haiti': 'HT',
  'jamaica': 'JM', 'mexico': 'MX', 'puerto rico': 'PR', 'trinidad & tobago': 'TT',
  'united states': 'US', 'argentina': 'AR', 'bolivia': 'BO', 'brazil': 'BR',
  'chile': 'CL', 'colombia': 'CO', 'costa rica': 'CR', 'ecuador': 'EC',
  'el salvador': 'SV', 'guatemala': 'GT', 'honduras': 'HN', 'nicaragua': 'NI',
  'panama': 'PA', 'paraguay': 'PY', 'peru': 'PE', 'uruguay': 'UY',
  'venezuela': 'VE', 'albania': 'AL', 'austria': 'AT', 'belarus': 'BY',
  'belgium': 'BE', 'bosnia & herzegovina': 'BA', 'bulgaria': 'BG', 'croatia': 'HR',
  'cyprus': 'CY', 'czechia': 'CZ', 'denmark': 'DK', 'estonia': 'EE',
  'finland': 'FI', 'france': 'FR', 'germany': 'DE', 'greece': 'GR',
  'hungary': 'HU', 'iceland': 'IS', 'ireland': 'IE', 'italy': 'IT',
  'latvia': 'LV', 'lithuania': 'LT', 'luxembourg': 'LU', 'malta': 'MT',
  'montenegro': 'ME', 'netherlands': 'NL', 'north macedonia': 'MK', 'norway': 'NO',
  'poland': 'PL', 'portugal': 'PT', 'romania': 'RO', 'russia': 'RU',
  'serbia': 'RS', 'slovakia': 'SK', 'slovenia': 'SI', 'spain': 'ES',
  'sweden': 'SE', 'switzerland': 'CH', 'ukraine': 'UA', 'united kingdom': 'GB',
  'china': 'CN', 'hong kong': 'HK', 'japan': 'JP', 'macau': 'MO',
  'mongolia': 'MN', 'south korea': 'KR', 'taiwan': 'TW', 'brunei': 'BN',
  'cambodia': 'KH', 'indonesia': 'ID', 'laos': 'LA', 'malaysia': 'MY',
  'myanmar': 'MM', 'philippines': 'PH', 'singapore': 'SG', 'thailand': 'TH',
  'vietnam': 'VN', 'bahrain': 'BH', 'bangladesh': 'BD', 'india': 'IN',
  'iran': 'IR', 'iraq': 'IQ', 'israel': 'IL', 'jordan': 'JO',
  'kuwait': 'KW', 'lebanon': 'LB', 'nepal': 'NP', 'oman': 'OM',
  'pakistan': 'PK', 'palestine': 'PS', 'qatar': 'QA', 'saudi arabia': 'SA',
  'sri lanka': 'LK', 'turkey': 'TR', 'uae': 'AE', 'kazakhstan': 'KZ',
  'kyrgyzstan': 'KG', 'tajikistan': 'TJ', 'turkmenistan': 'TM', 'uzbekistan': 'UZ',
  'australia': 'AU', 'fiji': 'FJ', 'new zealand': 'NZ', 'papua new guinea': 'PG',
  'algeria': 'DZ', 'angola': 'AO', 'cameroon': 'CM', 'egypt': 'EG',
  'ethiopia': 'ET', 'ghana': 'GH', 'ivory coast': 'CI', 'kenya': 'KE',
  'morocco': 'MA', 'nigeria': 'NG', 'senegal': 'SN', 'south africa': 'ZA',
  'sudan': 'SD', 'tanzania': 'TZ', 'tunisia': 'TN', 'uganda': 'UG',
  'zimbabwe': 'ZW',
};

// Alternate spellings start.gg (or other sources) may emit.
const ALIASES = {
  'united states of america': 'US', 'usa': 'US', 'u.s.a.': 'US',
  'united kingdom of great britain and northern ireland': 'GB', 'great britain': 'GB',
  'england': 'GB', 'scotland': 'GB', 'wales': 'GB', 'uk': 'GB',
  'korea, republic of': 'KR', 'republic of korea': 'KR', 'korea': 'KR',
  'russian federation': 'RU', 'viet nam': 'VN', 'czech republic': 'CZ',
  'united arab emirates': 'AE', 'trinidad and tobago': 'TT',
  'bosnia and herzegovina': 'BA', "cote d'ivoire": 'CI', 'côte d’ivoire': 'CI',
  "côte d'ivoire": 'CI', 'taiwan, province of china': 'TW', 'chinese taipei': 'TW',
  'hong kong sar': 'HK', 'macao': 'MO', 'macao sar': 'MO',
  'iran, islamic republic of': 'IR', 'syrian arab republic': 'SY',
  'venezuela, bolivarian republic of': 'VE', 'bolivia, plurinational state of': 'BO',
  'the netherlands': 'NL', 'holland': 'NL', 'türkiye': 'TR', 'turkiye': 'TR',
};

const NAME_TO_CODE = { ...PICKER_CODES, ...ALIASES };

// ISO-2 → regional-indicator flag emoji.
export function codeToFlagEmoji(code) {
  const cc = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return null;
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// Country name → ISO-2 (or null if we don't recognize it).
export function countryNameToCode(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  return NAME_TO_CODE[key] || null;
}

// Country name → flag emoji (or null). Main entry point for providers.
export function flagEmojiForCountry(name) {
  return codeToFlagEmoji(countryNameToCode(name));
}
