# HEIC/HEIF high bit-depth and Apple HDR behavior

The web worker must decode HEIC/HEIF locally and preserve the source precision
needed by the decomposition pipeline. The browser bridge uses the low-level
exports in the pinned `libheif-js` WASM bundle instead of its 8-bit
`display()` convenience method. Primary and auxiliary images are decoded as
16-bit interleaved RGB/RGBA storage, with the meaningful bit depth reported
separately (8, 10, or 12 when supported by the bundled HEVC decoder).

The bridge extracts the primary image dimensions, actual decoded bit depth,
ICC or nclx color profile, Exif, XMP, and all auxiliary-image relationships.
Apple gain maps are identified only by the exact auxiliary type
`urn:com:apple:photo:2020:aux:hdrgainmap`. A gain-map image is decoded rather
than ignored. Its lower-resolution samples and metadata are passed to the Rust
worker, where `ultrahdr-core` parses the Apple MakerNote and the worker applies
the Apple headroom/gain-map reconstruction into linear RGB before source color
conversion.

Color interpretation follows the existing no-guessing rule. A manual gamut and
transfer override wins. Otherwise a usable embedded ICC profile is applied
directly, even when it cannot be named as a standard gamut/transfer pair.
Recognized nclx values are used when no ICC is available. If neither an
override nor usable embedded color information exists, the page requires both
source controls and reports the reason.

An unsupported or malformed high-bit-depth stream is an explicit decoding
error. The worker never silently converts a 10/12-bit source through an 8-bit
display buffer. Files without a gain map continue through the ordinary native
HEIF path. If a gain-map auxiliary or required Apple metadata is present but
cannot be decoded, the worker reports that failure instead of silently
substituting the SDR base.

All expensive decoding, gain-map reconstruction, color conversion, and
decomposition remain in local workers. The static page does not upload image
bytes or require a server endpoint.
