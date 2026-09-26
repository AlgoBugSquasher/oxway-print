import Image from "next/image";

/**
 * The OXWAY wordmark — per ROADMAP.md's brand guidelines, `oxway-wordmark.jpeg`
 * has the canonical lettering style (horns integrated into the "W", split
 * black/red "X"); `oxway-icon-full.jpeg`'s plain bold wordmark font is NOT
 * the correct style, so that file is never used for wordmark text.
 *
 * Renders `oxway-wordmark-cropped.jpeg` rather than the original reference
 * file — that source image has a huge baked-in white margin (the actual
 * lettering is a ~224px-tall band inside an 853px-tall photo), which made
 * the logo render tiny and cramped in a compact header slot. The cropped
 * file is a straight whitespace trim (sharp's trim(), threshold 10) plus a
 * small even padding around all four sides — no part of the artwork itself
 * is cropped, redrawn, stretched, or recolored, only the surrounding blank
 * margin is removed. The untouched original stays in public/brand/ as the
 * reference asset.
 *
 * Sized by height with width left to scale automatically (never stretched
 * off its native ~4.3:1 aspect ratio), on its own small white plate so it
 * reads cleanly regardless of the surrounding page's background color or
 * theme (the source image has a plain white background, not transparent).
 */
export default function BrandWordmark({ className = "h-10" }: { className?: string }) {
  return (
    <span className="inline-flex w-fit items-center rounded-lg bg-white px-2.5 py-1.5">
      <Image src="/brand/oxway-wordmark-cropped.jpeg" alt="OXWAY" width={1127} height={260} className={`w-auto ${className}`} priority />
    </span>
  );
}
