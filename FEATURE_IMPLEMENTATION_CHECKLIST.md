# Multiformat image decomposition checklist

Branch: `feat/decompose-multiformat-inputs`

## Documentation and API

- [x] Document supported formats, metadata precedence, explicit fallback, HDR
      transfers, Apple gain maps, ACES2065-1 working space, and tolerance
      reporting in `IMAGE_DECOMPOSITION.md`.
- [x] Create this implementation checklist before code changes.
- [x] Add an explicit source gamut/transfer representation while retaining the
      existing combined OpenEXR input-space API.
- [x] Record input format, source interpretation, metadata provenance, and
      overrides in decomposition results and output EXR metadata.

## Decoding and color management

- [x] Add JPEG and PNG decoding with ICC, cICP, sRGB, gAMA, chromaticity, and
      EXIF metadata handling.
- [x] Add HEIC/HEIF decoding with `pillow-heif`, including 10/12-bit samples,
      ICC/nclx metadata, and clear dependency errors.
- [x] Add Apple HDR gain-map decoding through `apple-hdr-heic` and document
      the `exiftool` runtime requirement.
- [x] Add `Linear P3-D65` to OpenEXR detection and explicit fallback choices.
- [x] Decode SDR, linear, PQ, and HLG transfers and convert all sources to
      ACES2065-1 before decomposition.
- [x] Ensure missing or unsupported metadata never silently selects sRGB.

## Decomposition behavior

- [ ] Preserve the existing ACES 2.0 and ACEScg output contract.
- [x] Continue after J_HK, inverse round-trip, and reconstruction tolerance
      exceedances, retaining maximum-error and pixel-count diagnostics.
- [ ] Keep invalid/non-finite data and fundamentally unavailable inverse/root
      cases as hard errors.

## Tests and validation

- [x] Test P3-D65 EXR metadata and control-prefix normalization.
- [x] Test JPEG/PNG metadata and explicit fallback behavior.
- [x] Test PQ/HLG transfer decoding and ACES conversion.
- [x] Test HEIF nclx and Apple gain-map paths (including the real
      `IMG_9536.HEIC` sample with `exiftool`).
- [x] Test successful completion with tolerance exceedances and diagnostics.
- [x] Run focused decomposition tests, then the full test suite.
- [x] Review branch status and preserve unrelated user files.

## Real-file validation

`IMG_9536.HEIC` was decoded successfully as an Apple HDR gain-map image:
Display P3 / P3-D65, linearized by `apple-hdr-heic`, with values normalized to
the project's 100-nit ACES reference scale. A complete one-worker
`p3-hdr1000` decomposition also completed and wrote both EXR outputs. It
reported 23,820 inverse round-trip tolerance exceedances and 7 J_HK tolerance
exceedances while continuing to completion, as required.
