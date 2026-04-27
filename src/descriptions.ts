/**
 * Tool titles and descriptions optimized for reliable LLM tool selection.
 *
 * Each description follows a four-part structure:
 *   1. One-line action — what the tool does.
 *   2. Use when — concrete user-intent phrases that should trigger this tool.
 *   3. Do NOT use when — explicit disambiguation against sibling tools.
 *   4. Returns — the output shape.
 *
 * Keeping these as exported constants (rather than inline strings) lets us
 * snapshot-test them and tune wording without touching handler logic.
 */

export const URL_TO_PDF_TITLE = "Convert URL to PDF";
export const URL_TO_PDF_DESCRIPTION = `Render a live web page at the given URL as a PDF document and return a download URL.

Use when: the user wants to save a webpage as PDF, archive an article, export a receipt or invoice, generate a print-ready file from a URL, or preserve a page's exact visual layout.

Do NOT use when: converting a local .html file on disk (use convert_document); the user only wants to read, summarize, or quote the text (use convert_url_to_markdown — far cheaper on tokens); the user wants an image snapshot (use convert_url_to_screenshot).

Returns a presigned PDF download URL and metadata (filename, file size, conversion time). Optionally saves the PDF to a local path.`;

export const URL_TO_SCREENSHOT_TITLE = "Capture URL Screenshot";
export const URL_TO_SCREENSHOT_DESCRIPTION = `Capture a full-page PNG screenshot of a live web page.

Use when: the user asks for a screenshot, visual preview, page image, bug or layout snapshot, or social-share preview of a website.

Do NOT use when: the user wants the page's text content (use convert_url_to_markdown); the user wants a paginated printable document (use convert_url_to_pdf); the input is a local image file needing format conversion (use convert_image).

Returns a presigned PNG download URL and metadata.`;

export const URL_TO_MARKDOWN_TITLE = "Extract URL as Markdown";
export const URL_TO_MARKDOWN_DESCRIPTION = `Extract the main article content of a web page as clean GitHub-Flavored Markdown with a YAML frontmatter block (title, description, url, links, images). Strips navigation, footers, ads, scripts, and boilerplate.

Use when: the user wants to read, summarize, quote, translate, or analyze the textual content of a page; ingest a page into an LLM context window, RAG index, or notes app; cite a source with clean text. This is the most token-efficient URL conversion — prefer it over convert_url_to_pdf or convert_url_to_screenshot whenever the user's goal involves the page's text rather than its visuals.

Do NOT use when: the exact visual layout must be preserved (use convert_url_to_pdf); the user wants an image of the page (use convert_url_to_screenshot); the source is a local document file (use convert_document).

Returns the extracted Markdown inline in the response (when under ~256 KB) plus a presigned .md download URL and metadata.`;

export const CONVERT_DOCUMENT_TITLE = "Convert Document";
export const CONVERT_DOCUMENT_DESCRIPTION = `Convert a document file between formats. Accepted input formats: .doc, .docx, .xls, .xlsx, .ppt, .pptx, .odt, .ods, .odp, .pages, .numbers, .epub, .html, .htm, .md, .csv, .json, .xml, .yaml, .yml, .toml. Output defaults to pdf.

The file input is either an absolute local filesystem path OR an http(s) URL. With an http(s) URL, this server fetches the bytes and uploads them. Local paths are resolved on the machine running this MCP server.

Use when: the user wants to convert Word, Excel, PowerPoint, Keynote, Pages, Numbers, OpenDocument, or EPUB files to PDF; turn a local .html file into PDF; convert between structured-text formats (JSON↔YAML, CSV↔JSON, etc.).

Do NOT use when: the source is a live web page (use convert_url_to_pdf or convert_url_to_markdown); the source is an image file (use convert_image).

Returns a presigned download URL of the converted file and metadata. Accepts optional PDF rendering options (page size, orientation, margins, scale, grayscale).`;

export const CONVERT_IMAGE_TITLE = "Convert Image";
export const CONVERT_IMAGE_DESCRIPTION = `Convert an image file between formats. Supported formats: jpeg, png, svg, heic, webp.

The file input is either an absolute local filesystem path OR an http(s) URL. The target output_format is required.

Use when: the user wants to convert iPhone HEIC photos to WebP, PNG, or JPEG; re-encode for compression; modernize PNG or JPEG to WebP; rasterize SVG; or batch-convert image assets.

Do NOT use when: the source is a document (use convert_document); the source is a live web page (use convert_url_to_screenshot); the user wants to resize, crop, or edit the image (not supported here — only format conversion).

Returns a presigned download URL of the converted image and metadata.`;
