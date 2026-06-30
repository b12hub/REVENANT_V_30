// privacy-proxy.ts
//
// The synchronous security gate every uploaded image passes through
// BEFORE it ever leaves the bank's network boundary toward an external
// Vision API. Three steps, run in a strict, load-bearing order — see the
// conversational note above for why step 1 cannot be reordered after
// steps 2 or 3.

// ---------------------------------------------------------------------------
// Step 1: file signature validation — REAL, not mocked. Verifying magic
// bytes against a known-good allowlist is legitimate, implementable
// without faking it, and is a meaningfully different defense from the
// EXIF-stripping and PII-redaction steps, which genuinely do require a
// real image-processing library / ML model to implement for real and are
// mocked accordingly below.
//
// Honest limitation, stated plainly rather than implied: this confirms
// the buffer's leading bytes match a real container format for one of the
// allowed image types. It does NOT guarantee the rest of the file is free
// of a crafted payload designed to exploit a specific decoder's parsing
// logic deeper in the file — that would require a hardened, sandboxed
// decode step (e.g. re-encoding through a trusted library before anything
// touches the bytes), which is a real next layer of defense, not
// something this signature check claims to provide on its own.
// ---------------------------------------------------------------------------

export class MaliciousFileSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaliciousFileSignatureError';
  }
}

interface FileSignature {
  readonly label: string;
  readonly offset: number;
  readonly bytes: readonly number[];
}

/**
 * Deliberately JPEG / PNG / WEBP only — the three realistic formats for a
 * photographed receipt or a screenshot. SVG is deliberately excluded: it
 * is not a raster format at all, it's an XML document capable of
 * embedding `<script>` tags and XML entity-expansion payloads — allowing
 * it through a layer whose entire job is sanitization would be exactly
 * backwards. Animated GIF is excluded too: there is no legitimate reason
 * a financial document upload needs to be an animation.
 */
const ALLOWED_SIGNATURES: readonly FileSignature[] = [
  { label: 'JPEG_JFIF', offset: 0, bytes: [0xff, 0xd8, 0xff, 0xe0] },
  { label: 'JPEG_EXIF', offset: 0, bytes: [0xff, 0xd8, 0xff, 0xe1] },
  { label: 'JPEG_SPIFF', offset: 0, bytes: [0xff, 0xd8, 0xff, 0xe8] },
  { label: 'PNG', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

const WEBP_RIFF_MARKER = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_FORMAT_MARKER = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
const WEBP_FORMAT_MARKER_OFFSET = 8;

function bytesMatchAt(buffer: Buffer, offset: number, expected: readonly number[]): boolean {
  if (buffer.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (buffer[offset + i] !== expected[i]) return false;
  }
  return true;
}

function matchesAllowedSignature(buffer: Buffer): boolean {
  for (const signature of ALLOWED_SIGNATURES) {
    if (bytesMatchAt(buffer, signature.offset, signature.bytes)) return true;
  }
  if (bytesMatchAt(buffer, 0, WEBP_RIFF_MARKER) && bytesMatchAt(buffer, WEBP_FORMAT_MARKER_OFFSET, WEBP_FORMAT_MARKER)) {
    return true;
  }
  return false;
}

const MAX_UPLOAD_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB — a generous bound for a phone photo, while still bounding worst-case memory/processing cost per upload

export class DocumentPrivacyProxy {
  async sanitizeImage(rawBuffer: Buffer): Promise<Buffer> {
    // Step 0 — size bound, checked before anything else touches the bytes.
    if (rawBuffer.length === 0 || rawBuffer.length > MAX_UPLOAD_SIZE_BYTES) {
      throw new MaliciousFileSignatureError(
        `Upload size ${rawBuffer.length} bytes is outside the accepted range (0 < size <= ${MAX_UPLOAD_SIZE_BYTES}).`,
      );
    }

    // Step 1 — signature validation. MUST run before steps 2/3 — see file header.
    if (!matchesAllowedSignature(rawBuffer)) {
      throw new MaliciousFileSignatureError(
        'Uploaded file does not match any allowed image signature (JPEG, PNG, WEBP). Rejecting before any further processing.',
      );
    }

    // Step 2 — EXIF/metadata stripping. MOCKED per task scope — a real
    // implementation uses an image-processing library (e.g. `sharp`,
    // which can re-encode an image while deliberately omitting its EXIF/
    // GPS/ICC segments) rather than hand-parsing binary metadata segments
    // here. This mock returns the buffer unchanged but is structured as
    // its own named step specifically so swapping in the real
    // implementation later touches only this one method.
    const metadataStripped = await this.mockStripMetadata(rawBuffer);

    // Step 3 — PII redaction. MOCKED per task scope — a real
    // implementation needs its own specialized detection model (signature
    // box detection, PAN-card digit-region OCR + blur), not something
    // reasonable to fake convincingly here. Same swap-in-place structure
    // as step 2.
    const piiRedacted = await this.mockRedactSensitivePii(metadataStripped);

    return piiRedacted;
  }

  private async mockStripMetadata(buffer: Buffer): Promise<Buffer> {
    // Real implementation will use sharp(buffer).withMetadata({}).toBuffer()
    // For the mock phase, we allocate a clean detached buffer clone to prevent
    // V8 slab allocation memory retention leaks.
    return Buffer.from(buffer);
  }

  private async mockRedactSensitivePii(buffer: Buffer): Promise<Buffer> {
    // Real implementation will execute computer vision masking on bounding boxes.
    // Detaching memory space ensures the parent chunk pool can be instantly garbage collected.
    return Buffer.from(buffer);
  }
}