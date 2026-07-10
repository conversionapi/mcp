/**
 * Tool titles and descriptions optimized for reliable LLM tool selection.
 *
 * Each description follows a four-part structure:
 *   1. One-line action — what the tool does, stated as INPUT -> OUTPUT.
 *   2. Use when — concrete user-intent phrases that should trigger this tool.
 *   3. Do NOT use when — explicit disambiguation against sibling tools.
 *   4. Returns — the output shape plus operational notes.
 *
 * Only the FILE conversion tools live here; every URL/browser tool is V2
 * (see descriptions-v2.ts — perceive_url and friends).
 *
 * Keeping these as exported constants (rather than inline strings) lets us
 * snapshot-test them and tune wording without touching handler logic.
 */

export const CONVERT_DOCUMENT_TITLE = "Convert Document";
export const CONVERT_DOCUMENT_DESCRIPTION = `Convert a document FILE between formats. Input is an absolute local filesystem path OR an http(s) URL pointing at the file itself (the server downloads the bytes — it does NOT render web pages). Implemented pairs, exactly:
- To PDF: doc/docx, xls/xlsx, ppt/pptx, odt, ods, odp, ots, pages, numbers, epub, html/htm, md/markdown.
- markdown -> html.
- Structured data: json <-> xml, json <-> yaml, json <-> toml, json <-> csv, csv <-> xml.
No other pairs exist (no pdf -> docx, no yaml -> toml, no html -> markdown). Unsupported pairs fail instantly with the list of valid outputs for that input. output_format defaults to "pdf".

Use when: "convert this file to PDF" for Word, Excel, PowerPoint, OpenDocument, Apple Pages/Numbers, or EPUB files; turning a local .html or .md file into a PDF; markdown to HTML; JSON/CSV/XML/YAML/TOML data-format conversions.

Do NOT use when: the source is a LIVE web page to render or read (use perceive_url — it produces markdown, PDF, screenshots, and structured data from URLs); the file is an image or the output should be an image (use convert_image — including pdf -> jpeg).

Returns: a presigned download URL of the converted file plus metadata and a jobId; pass save_to (absolute path) to also write it locally. pdf_options (page size, orientation, margins, scale, grayscale) shape PDF outputs.`;

export const CONVERT_IMAGE_TITLE = "Convert Image";
export const CONVERT_IMAGE_DESCRIPTION = `Convert an image FILE between formats: any pair among jpeg, png, svg, heic, webp (all 20 combinations), plus pdf -> jpeg rasterization. Input is an absolute local filesystem path OR an http(s) URL pointing at the file itself. A multi-page PDF returns a ZIP containing one JPEG per page; a single-page PDF returns one JPEG.

Use when: converting iPhone HEIC photos to WebP/PNG/JPEG, re-encoding or modernizing images to WebP, rasterizing an SVG, turning PDF pages into JPEG images, batch-converting image assets.

Do NOT use when: the file is a document format (use convert_document); the source is a LIVE web page (use perceive_url with outputs ['screenshot']); resizing, cropping, or editing is wanted (not supported — format conversion only); PDF as OUTPUT is wanted (pdf is input-only here; images cannot be converted to PDF).

Returns: a presigned download URL of the converted image plus metadata and a jobId; pass save_to (absolute path) to also write it locally. PDF input supports output_format "jpeg" only — other outputs fail instantly with a clear error.`;

export const JOB_STATUS_TITLE = "Get Job Status";
export const JOB_STATUS_DESCRIPTION = `Check the status of ONE file-conversion job by job_id (every successful convert_document / convert_image result includes a "Job ID" in its text and a jobId in structuredContent).

Use when: a conversion timed out or the connection dropped mid-call and you need to recover its result; confirming whether a slow conversion actually finished server-side.

Do NOT use when: tracking a perceive batch (use get_perceive_batch) or an ingest job (use get_ingest_job); no jobId is at hand.

Returns: "processing" (poll again shortly), "success" with the presigned download URL and object key, or "failed" with the error message.`;
