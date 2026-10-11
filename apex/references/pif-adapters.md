# PIF normalization adapters

Each adapter receives a raw source and emits a single unified object that the deterministic scanner (Tier 0) reads. No adapter depends on external npm packages; CLI tools are invoked with `execFileSync` (no shell) using verified absolute binary paths.

### Unified output shape

```typescript
{
  text: string,
  provenance_zones: [
    {
      start: number,
      end: number,
      source: 'direct' | 'retrieved' | 'hidden' | 'metadata' | 'alt_text' | 'comment' | 'header',
      trust: 'trusted' | 'untrusted'
    }
  ],
  hidden_text_flags: [
    {
      kind:
        | 'html_comment' | 'white_on_white' | 'zero_width' | 'tag_chars'
        | 'off_screen_css' | 'metadata_field' | 'pdf_hidden_layer'
        | 'docx_hidden_text' | 'docx_track_changes' | 'docx_comment'
        | 'alt_text' | 'email_header' | 'base64_blob'
        | 'homoglyph' | 'ocr_invisible' | 'comment',
      excerpt: string,
      note: string
    }
  ],
  source_type: string,
  degraded: boolean,
  extraction: 'complete' | 'partial' | 'failed',
  extraction_notes: string[]
}
```

`degraded` is always `true` when `extraction !== 'complete'`.

### No-shell rule

Every external binary call uses `child_process.execFileSync(binaryPath, argsArray, { timeout, maxBuffer })`. No shell interpolation ever occurs. Binary paths are found by checking `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin` with `fs.existsSync`. Before any tool runs, the path must: be a string without NUL bytes, pass `fs.statSync(path).isFile()`, and have size <= 25 MB (20 MB for images). A failure at any stage returns `extraction: 'failed'` with a note; the adapter never throws.

### Buffer and string inputs for path-based adapters

`pdf`, `word_doc`, and `image_via_ocr` accept:
- A `Buffer` — written to a private temp dir, processed, then cleaned up.
- A string starting with `%PDF` (pdf) or `PK` magic bytes (word_doc) — same temp-dir treatment.
- A string that is a valid existing file path — used directly.
- Any other string — `extraction: 'failed'` with a note; the content is not passed through to prevent shell-injection-style false positives.

---

## user_message

Receives the raw string typed or pasted by the end user.

### Decoding steps

1. Accept the raw string; no stripping of visible content.
2. Unicode-normalize to NFKC. Flag zero-width characters (U+200B, U+200C, U+200D, U+FEFF) and Unicode tag codepoints (U+E0000..U+E007F) as `kind: 'zero_width'` or `kind: 'tag_chars'`.
3. Scan for homoglyph substitutions (Cyrillic/Greek lookalikes mixed into Latin runs). Flag each as `kind: 'homoglyph'`.
4. Collapse runs of 3+ blank lines to a single blank line.

### Risk-elevating signals

- Zero-width or tag characters surrounding instruction phrases.
- Homoglyph substitution inside words that would otherwise match injection patterns.

### Fallback behavior

Unicode detection requires no external tool. If NFKC normalization fails, skip it and emit `note: 'nfkc_skipped'`.

---

## web_page

Receives an HTML string fetched from a URL. Delegates to the `html` adapter and sets `source_type: 'web_page'`.

---

## pdf

Receives a file path, Buffer, or `%PDF`-prefixed string for a PDF document.

### Decoding steps

1. Normalize input: Buffer or `%PDF` strings are written to a private temp dir. Non-file strings return `extraction: 'failed'`.
2. Validate the path (NUL check, `isFile()`, size <= 25 MB).
3. Run `pdftotext -layout -enc UTF-8 <file> -` with `execFileSync`. On failure, fall back to a byte-string scan and set `extraction: 'partial'`.
4. Run `pdfinfo <file>` with `execFileSync`. Extract `Title`, `Subject`, `Keywords`, `Author`, `Creator`, `Producer` metadata fields as `kind: 'metadata_field'` flags.
5. Read the raw file bytes. Scan annotation `/Contents` strings as `kind: 'metadata_field'` flags.
6. Hidden text stream scan (bounded: at most 200 streams, 5 MB inflated total):
   - Inflate `FlateDecode` streams with `zlib.inflateSync`.
   - Also scan uncompressed streams.
   - For each `BT...ET` block, detect invisible render mode (`3 Tr`) → `kind: 'pdf_hidden_layer'`, white fill (`1 1 1 rg` or `1 g`) → `kind: 'white_on_white'`, zero font size (`/F.. 0 Tf`) → `kind: 'pdf_hidden_layer'`. Extract `Tj`/`TJ` string operands from those blocks as the excerpt.
7. Unicode-normalize NFKC, zero-width/tag-char scan.
8. Collapse whitespace. All zones `source: 'retrieved', trust: 'untrusted'`.

### Flag kinds produced

| kind | trigger |
|---|---|
| `pdf_hidden_layer` | `3 Tr` invisible render mode or `0 Tf` zero font size |
| `white_on_white` | `1 1 1 rg` or `1 g` white fill in a BT block |
| `metadata_field` | pdfinfo fields, annotation /Contents, pdftotext unavailable note |
| `zero_width` | zero-width characters in extracted text |

### Fallback behavior

If `pdftotext` is absent, extraction falls back to raw byte-string scan. `extraction: 'partial'`, `degraded: true`. The hidden text stream scan still runs.

---

## email

Receives a raw RFC 2822 email string (headers + body).

### Decoding steps

1. Split on the first blank line (header / body). Unfold folded headers.
2. Parse `From` and `Reply-To` domains; flag domain mismatch as `kind: 'email_header'`.
3. Include the `Subject` header value in the output text with `[Subject]` prefix.
4. Walk the MIME tree recursively (depth cap: 2; total decoded bytes cap: 10 MB):
   - Detect `multipart/*` boundaries; split and recurse each part.
   - Decode `quoted-printable` (soft-line splicing + hex decode).
   - Decode `base64` parts; flag each as `kind: 'base64_blob'` with first 80 decoded chars.
   - `text/html` parts pass through the `html` adapter; flags are merged with the attachment filename in `note`.
   - `application/pdf` and DOCX attachments are decoded to a temp file and passed through their respective adapters (recursion depth counted).
5. Quoted-thread lines (starting with `>`) are annotated as `[quoted-thread]`.
6. Scan `mailto:` URIs with `body=` or `subject=` params; flag as `kind: 'metadata_field'`.
7. Unicode-normalize NFKC, zero-width scan. All body content is `source: 'retrieved', trust: 'untrusted'`.

### Fallback behavior

If MIME parsing throws, strip headers at the first blank line and emit the raw body with `kind: 'metadata_field', note: 'mime_parse_failed — raw body only'`.

---

## markdown

Receives a Markdown string (CommonMark or GFM).

### Decoding steps

1. Extract HTML comments `<!-- ... -->` → `kind: 'html_comment'`.
2. Extract link-reference comments: `[//]: # (text)` and `[comment]: <> (text)` → `kind: 'html_comment'`.
3. Extract inline image alt text `![alt](url)` and reference-style `![alt][ref]`; append as `[ALT]` in text. Flag alt text with injection phrases as `kind: 'alt_text'`.
4. Extract reference-style link definitions `[label]: url`; flag suspicious schemes (`javascript:`, `data:`) as `kind: 'metadata_field'`.
5. Pass raw HTML blocks through the `html` adapter; merge resulting flags with `raw-html-block:` prefix.
6. Strip inline links (keep text), emphasis markers, heading markers.
7. Unicode-normalize NFKC, zero-width scan.

### Fallback behavior

If inline HTML blocks cannot be parsed, treat those spans as plain text and flag `kind: 'metadata_field', note: 'inline_html_parse_skipped'`.

---

## html

Receives an HTML string (also used by `web_page`).

### Decoding steps

1. Extract HTML comments `<!-- ... -->` → `kind: 'html_comment'`.
2. Strip `<script>` and `<style>` blocks.
3. Extract `<template>` content → `kind: 'off_screen_css'` (template content is never rendered).
4. Extract `<input type="hidden" value="...">` values → `kind: 'metadata_field'`.
5. Extract `iframe srcdoc` attribute value → `kind: 'html_comment'`.
6. Flag `<meta http-equiv="refresh">` → `kind: 'metadata_field'`.
7. Detect CSS-hidden elements (via `style="..."` attribute):
   - `display:none`, `visibility:hidden`
   - `color:#fff`, `color:#ffffff`, `color:white`
   - `font-size:0`, `font-size:0px`, `font-size:1px`
   - `opacity:0`
   - `top:-NNNpx`, `left:-NNNpx` (off-screen positioning)
   All produce `kind: 'off_screen_css'` with the element's text in `excerpt`.
8. Detect elements with `hidden` attribute or `aria-hidden="true"` → `kind: 'off_screen_css'`.
9. Extract `<meta name="..." content="...">` → `kind: 'metadata_field'`.
10. Extract `alt`, `title`, `aria-label` attribute values; append to text.
11. Decode HTML entities, Unicode-normalize NFKC, zero-width scan.
12. Collapse whitespace. All zones `source: 'retrieved', trust: 'untrusted'`.

### Flag kinds produced

| kind | trigger |
|---|---|
| `html_comment` | `<!-- -->` comments, `iframe srcdoc` |
| `off_screen_css` | CSS hiding, `hidden` attr, `aria-hidden="true"`, `<template>` |
| `metadata_field` | `<meta>` content, `input[type=hidden]`, `meta refresh` |
| `zero_width` | zero-width characters in text |

### Fallback behavior

If the HTML is too malformed for regex tag stripping, perform a plain `<[^>]+>` strip and add `kind: 'metadata_field', note: 'html_regex_strip_fallback — css_hidden and comment detection skipped'`.

---

## word_doc

Receives a `.docx` file path (ZIP/XML), Buffer, or `PK`-magic Buffer. Legacy `.doc` files (OLE magic `D0 CF 11 E0`) return `extraction: 'failed'`.

### Decoding steps

1. Normalize input: Buffer with `PK` magic → write to temp dir. Non-file strings → `extraction: 'failed'`.
2. Validate path (NUL, `isFile()`, size <= 25 MB).
3. Check file header: OLE magic → return `extraction: 'failed'` with note `'legacy .doc held: no isolated converter'`.
4. List ZIP parts with `unzip -Z1` (execFileSync, no shell). Flag `word/vbaProject.bin` presence as `kind: 'metadata_field', note: 'macro-enabled document; macros never executed'`.
5. Extract `word/document.xml` with `unzip -p`. Parse `<w:r>` runs:
   - Runs with `<w:vanish/>` → `kind: 'docx_hidden_text'` flag (excerpt from `<w:t>` content).
   - All other runs contribute to body text.
6. Extract tracked deletions (`<w:del>/<w:delText>`) → `kind: 'docx_track_changes'`.
7. Extract tracked insertions (`<w:ins>`) → `kind: 'docx_track_changes'`.
8. Extract `word/comments.xml` comment bodies → `kind: 'docx_comment'`.
9. Extract `word/header*.xml` and `word/footer*.xml` text; append to output text with provenance label.
10. Extract `word/footnotes.xml` text; append to output.
11. Extract `docProps/core.xml` fields (title, subject, creator, keywords, description) → `kind: 'metadata_field'`.
12. Extract `docProps/custom.xml` property values → `kind: 'metadata_field'`.
13. Unicode-normalize NFKC, zero-width scan, collapse whitespace.

### Flag kinds produced

| kind | trigger |
|---|---|
| `docx_hidden_text` | `<w:vanish/>` run property |
| `docx_track_changes` | `<w:del>/<w:delText>` deletions and `<w:ins>` insertions |
| `docx_comment` | `word/comments.xml` comment bodies |
| `metadata_field` | core/custom properties, VBA macro presence, extraction errors |

### Fallback behavior

If `word/document.xml` cannot be extracted, return `extraction: 'failed'` with a note.

---

## api_response

Receives a JSON string (or plain text) from an external API call.

### Decoding steps

1. Attempt `JSON.parse`. On success, walk the parsed value recursively (depth limit 20).
2. For every string value: append to text; flag strings over 500 chars as `kind: 'metadata_field'`, base64-like strings as `kind: 'base64_blob'`, suspicious key names + injection phrases as `kind: 'metadata_field'`.
3. On JSON parse failure: treat the raw string as `user_message` with `trust: 'untrusted'`.
4. Unicode-normalize NFKC, zero-width scan. All zones `source: 'retrieved', trust: 'untrusted'`.

---

## ocr_text

Receives a string already extracted by an OCR engine.

### Decoding steps

1. Prepend an `kind: 'ocr_invisible'` flag noting `'ocr_extracted — source image fidelity unknown'`.
2. Unicode-normalize NFKC. Run homoglyph scan (elevated sensitivity for OCR errors).
3. Flag zero-width characters, control characters, base64 blobs > 40 chars.
4. Collapse whitespace. Single provenance zone `source: 'retrieved', trust: 'untrusted'`.

---

## source_code

Receives source code as a string (any language).

### Decoding steps

1. Extract multi-line comments (`/* */`, `<!-- -->`), docstrings (`"""`, `'''`) → `kind: 'comment'`.
2. Extract single-line comments (`//`, `#`, `--`) → `kind: 'comment'`.
3. Scan string literals for base64 patterns → `kind: 'base64_blob'`; long strings with injection phrases → `kind: 'metadata_field'`.
4. Preserve remaining code as `source: 'direct', trust: 'trusted'`.

---

## image_via_ocr

Receives an image file path or Buffer (PNG, JPEG, TIFF, etc.).

### Decoding steps

1. Resolve `tesseract` binary from known paths. If absent: return `text: ''`, `extraction: 'failed'`, `degraded: true`.
2. Normalize input: Buffer → temp dir; non-file strings → `extraction: 'failed'`.
3. Validate path (NUL, `isFile()`, size <= 20 MB).
4. Run `tesseract <file> stdout tsv` with `execFileSync`. Parse TSV output (level 5 = word rows). Rebuild text by grouping words into lines.
5. Compute mean word confidence from the `conf` column. Mean < 60 adds `kind: 'ocr_invisible'` flag with note `'low OCR confidence <n>'`.
6. Pass extracted text through the `ocr_text` adapter for further scanning.
7. `extraction: 'complete'` on success; `extraction: 'failed'` on tesseract error.

### Flag kinds produced

| kind | trigger |
|---|---|
| `ocr_invisible` | tesseract absent, low confidence, no path, tesseract error |
| All `ocr_text` kinds | low-confidence chars, homoglyphs, control chars, base64 |

### Fallback behavior

If `tesseract` is absent: emit `text: ''`, `extraction: 'failed'`, `degraded: true`. The caller should route the image to a vision model tier.
