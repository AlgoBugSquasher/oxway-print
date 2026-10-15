import type { NextConfig } from "next";

// Pins pdf-lib to its own pre-bundled, single-file browser build
// (dist/pdf-lib.esm.js) everywhere it's imported, for both bundlers.
//
// Root cause of the "PDFHeader_1.default.forVersion is not a function"
// production bug: pdf-lib ships its code across many small per-module
// files (es/core/document/PDFHeader.js, es/core/writers/PDFWriter.js,
// etc.), with BOTH a CJS build (cjs/) and an ESM build (es/) of each one.
// Nothing in this app ever imports those submodules directly — every file
// does `import { PDFDocument } from "pdf-lib"` — but internally pdf-lib's
// own code is still made of many files. When a bundler's module graph ends
// up resolving pdf-lib's internals through two different paths (one
// correctly ESM, one via the CJS build's tslib interop wrapper,
// `PDFHeader_1 = tslib.__importDefault(require("../document/PDFHeader"))`
// then `PDFHeader_1.default.forVersion(...)`), the two can end up
// inconsistent — a classic "dual package hazard." dist/pdf-lib.esm.js is
// pdf-lib's own pre-rolled-up, single-file build: PDFHeader (and
// everything else) lives inside that ONE file with no module boundary of
// its own left to resolve inconsistently, which removes the mechanism for
// this bug entirely rather than just hiding a symptom. Verified directly:
// the named exports this app actually uses (PDFDocument, StandardFonts,
// rgb, degrees, ...) all resolve correctly from this file, including a
// full create -> embed font -> draw -> save round trip.
// A plain module specifier (resolved the normal node_modules way by
// whichever bundler is active), not an absolute filesystem path — Turbopack
// doesn't support resolving an absolute Windows-style path via
// resolveAlias ("windows imports are not implemented yet"), and a bare
// specifier works for both bundlers anyway.
const pdfLibDistEntry = "pdf-lib/dist/pdf-lib.esm.js";

const nextConfig: NextConfig = {
  // pdf-lib also runs server-side (app/api/create-order, app/api/staff-print
  // -> lib/print/pdf.ts) — this tells Next's server bundler to leave it as a
  // plain `require()` from node_modules instead of bundling/transforming it,
  // which is the officially recommended fix for a CJS package that doesn't
  // need (and shouldn't get) bundler-level rewriting on the server. Cheap
  // insurance even though the confirmed crash was client-side.
  serverExternalPackages: ["pdf-lib"],
  turbopack: {
    resolveAlias: {
      "pdf-lib": pdfLibDistEntry,
    },
  },
  webpack: (config) => {
    config.resolve ??= {};
    config.resolve.alias = {
      ...config.resolve.alias,
      "pdf-lib": pdfLibDistEntry,
    };
    return config;
  },
};

export default nextConfig;
