/**
 * `Map.prototype.getOrInsert[Computed]` / `WeakMap.prototype.getOrInsert[Computed]`
 * are a very new (2024/2025, TC39) addition — recent enough that plenty of
 * real iOS Safari installs still in use (confirmed on iPhone 15/15 Plus)
 * don't have them natively yet, even though Android Chrome does. pdf.js
 * (pdfjs-dist) calls `.getOrInsertComputed` internally in its own
 * message-handler/transport caching, which is what actually crashes —
 * see components/PdfPageSelector.tsx's pdfjs-dist import for the real fix
 * (the "legacy" build, which bundles its own core-js polyfill for exactly
 * this). This file is the defense-in-depth half of that fix, not the
 * primary one: cheap, feature-detected (a strict no-op wherever the legacy
 * build's own polyfill — or genuine native support — already covers it),
 * and here in case anything else ever calls these methods before pdf.js's
 * own polyfill has had a chance to run.
 *
 * Side-effect-only module — import it, don't call anything from it.
 * Must be imported before pdfjs-dist, since the crash happens the moment
 * pdf.js's own code calls the missing method, not at module-load time.
 */
function polyfillGetOrInsert(prototype: { getOrInsert?: unknown; getOrInsertComputed?: unknown }): void {
  if (typeof prototype.getOrInsert !== "function") {
    Object.defineProperty(prototype, "getOrInsert", {
      configurable: true,
      writable: true,
      value: function getOrInsert(this: Map<unknown, unknown>, key: unknown, value: unknown) {
        if (!this.has(key)) this.set(key, value);
        return this.get(key);
      },
    });
  }
  if (typeof prototype.getOrInsertComputed !== "function") {
    Object.defineProperty(prototype, "getOrInsertComputed", {
      configurable: true,
      writable: true,
      value: function getOrInsertComputed(this: Map<unknown, unknown>, key: unknown, callback: (key: unknown) => unknown) {
        if (!this.has(key)) this.set(key, callback(key));
        return this.get(key);
      },
    });
  }
}

type PatchableMapPrototype = { getOrInsert?: unknown; getOrInsertComputed?: unknown };

if (typeof Map !== "undefined") polyfillGetOrInsert(Map.prototype as unknown as PatchableMapPrototype);
if (typeof WeakMap !== "undefined") polyfillGetOrInsert(WeakMap.prototype as unknown as PatchableMapPrototype);
