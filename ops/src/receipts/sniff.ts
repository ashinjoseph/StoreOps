// What a receipt original is, decided by its first bytes (card P5-12a; ADR-0026). The name it was sent
// with and the Content-Type header are never used to decide: a phone may name a JPEG ".HEIC", and a
// hostile page may call an SVG "image/png". Five kinds are accepted, by these signatures:
//
//   JPEG  FF D8 FF                                         (bytes 0-2)
//   PNG   89 50 4E 47 0D 0A 1A 0A                          (bytes 0-7)
//   WebP  "RIFF" (0-3), any length (4-7), "WEBP" (8-11)
//   HEIC  an ISO-BMFF "ftyp" box first: its size (0-3) at least 16 and within the file, "ftyp" (4-7),
//         and a major brand (8-11) of heic, heix, hevc, hevx, heim or heis; or a major brand of mif1 or
//         msf1 (plain HEIF) with one of those six among the compatible brands (16 to the box's end).
//         AVIF (also mif1, brand avif) is not one of them and is refused. Stored as image/heic.
//   PDF   "%PDF-" (0-4), then a digit, ".", a digit        ("%PDF-1.7", bytes 0-7)
//
// Anything else is refused: an empty file, a signature cut short, SVG, HTML, a zip or any archive, a
// text file. Nothing is converted.

export const CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/** Short words for a person: "a JPEG photo". */
export const KIND_WORDS: Readonly<Record<ContentType, string>> = {
  "image/jpeg": "a JPEG photo",
  "image/png": "a PNG image",
  "image/webp": "a WebP image",
  "image/heic": "a HEIC photo",
  "application/pdf": "a PDF",
};

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);
const HEIF_MAJOR = new Set(["mif1", "msf1"]);

const ascii = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.subarray(from, to));
const starts = (b: Uint8Array, sig: readonly number[]): boolean => b.length >= sig.length && sig.every((x, i) => b[i] === x);
const isDigit = (c: number | undefined): boolean => c !== undefined && c >= 0x30 && c <= 0x39;

function isHeic(b: Uint8Array): boolean {
  if (b.length < 16 || ascii(b, 4, 8) !== "ftyp") return false;
  const size = ((b[0] ?? 0) << 24 >>> 0) + ((b[1] ?? 0) << 16) + ((b[2] ?? 0) << 8) + (b[3] ?? 0);
  if (size < 16 || size > b.length || size % 4 !== 0) return false;
  const major = ascii(b, 8, 12);
  if (HEIC_BRANDS.has(major)) return true;
  if (!HEIF_MAJOR.has(major)) return false;
  for (let at = 16; at + 4 <= size; at += 4) if (HEIC_BRANDS.has(ascii(b, at, at + 4))) return true;
  return false;
}

/** The kind of file `bytes` is, or null when it is none of the five. */
export function sniff(bytes: Uint8Array): ContentType | null {
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 8 && ascii(bytes, 0, 5) === "%PDF-" && isDigit(bytes[5]) && bytes[6] === 0x2e && isDigit(bytes[7])) return "application/pdf";
  if (isHeic(bytes)) return "image/heic";
  return null;
}

/** The message for a file that is none of the five. */
export const NOT_ACCEPTED = "This file is not a photo or a PDF the app can keep. Send a JPEG, PNG, WebP or HEIC photo, or a PDF.";
