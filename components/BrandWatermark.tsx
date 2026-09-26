import Image from "next/image";

/**
 * Purely decorative bull-head watermark for the main upload page — per
 * ROADMAP.md's brand guidelines, `oxway-icon-full.jpeg`'s icon is the
 * canonical mark (its wordmark font is not, see BrandWordmark.tsx), so only
 * the icon is used here, never that file's lettering.
 *
 * Renders `oxway-icon-cropped.jpeg`, a straight crop of the original
 * reference photo's icon region only — the "OXWAY / PRIVATE LIMITED" text
 * band beneath the icon in that file is cut off, nothing within the icon's
 * own bounding box is redrawn, stretched, or recolored. The untouched
 * original stays in public/brand/ as the reference asset.
 *
 * Placed in normal document flow, right after PdfPageSelector's <main> grid
 * and right-aligned within the same max-w-6xl column the rest of the page
 * uses — NOT `fixed`/gutter-positioned (an earlier version needed a
 * >1536px-wide browser to ever be visible at all, which is useless on an
 * ordinary laptop window). Being flow content directly below the grid is
 * what guarantees it never overlaps the header, dropzone, or print-settings
 * card: those are earlier siblings, so by definition nothing below them
 * can render on top of them. It sits above the root div's own bottom
 * padding (reserved for the fixed payment bar — see PdfPageSelector), so it
 * can't end up hidden under that bar either.
 *
 * The blend mode (a rendering-only CSS property, not a file edit) is what
 * keeps this from looking like a stray grey box instead of a watermark:
 * `mix-blend-multiply` makes the source photo's plain white background
 * multiply out to fully transparent, leaving only the dark silhouette to
 * tint the page — but multiply can only ever darken, so against the dark
 * theme's near-black background it made the (already dark) silhouette
 * disappear along with the background. `invert` + `mix-blend-screen` is the
 * lighten-only mirror of that same trick: inverting first turns the
 * silhouette white and the background black, and screen with a black source
 * is a no-op (still fully transparent) while a white source gently lightens
 * whatever's underneath — so the icon still reads on a dark page instead of
 * vanishing into it.
 */
export default function BrandWatermark({ isDark }: { isDark: boolean }) {
  return (
    <div aria-hidden="true" className="mx-auto flex max-w-6xl justify-end px-5 pb-2 pt-8 lg:px-8">
      <Image
        src="/brand/oxway-icon-cropped.jpeg"
        alt=""
        width={726}
        height={751}
        className={`pointer-events-none h-auto w-28 select-none opacity-[0.07] sm:w-36 lg:w-44 ${isDark ? "invert mix-blend-screen" : "mix-blend-multiply"}`}
      />
    </div>
  );
}
