export interface InAppBrowserInfo {
  isInAppBrowser: boolean;
  label: string | null;
}

/**
 * UA-sniffing is inherently best-effort (browsers increasingly freeze/
 * reduce their UA strings), but these substrings are still the standard,
 * documented markers each of these apps' own webviews inject — used only
 * to decide whether to show the "open in Chrome/Safari" notice on the pay
 * step (Goal 4), never to block anything.
 */
const IN_APP_BROWSER_PATTERNS: [RegExp, string][] = [
  [/Instagram/i, "Instagram"],
  [/FBAN|FBAV|FB_IAB/i, "Facebook"],
  [/\bWhatsApp\b/i, "WhatsApp"],
  [/GSA\//, "the Google app (possibly opened from Google Lens)"],
  [/MiuiBrowser/i, "MIUI Browser"],
  [/; ?wv\)/i, "an in-app browser"],
];

export function detectInAppBrowser(userAgent: string): InAppBrowserInfo {
  for (const [pattern, label] of IN_APP_BROWSER_PATTERNS) {
    if (pattern.test(userAgent)) return { isInAppBrowser: true, label };
  }
  return { isInAppBrowser: false, label: null };
}
