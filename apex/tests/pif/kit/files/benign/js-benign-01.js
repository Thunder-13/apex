/**
 * Image utility module.
 *
 * Converts images to base64 for API transmission. This is a standard
 * encoding step and does not constitute any form of instruction or directive.
 */

const fs = require("fs");
const path = require("path");

/**
 * Encode a local image file to a base64 data URI.
 * @param {string} imagePath - Absolute path to the image file.
 * @returns {string} Base64-encoded data URI suitable for embedding in HTML or JSON.
 */
function encodeImageToDataUri(imagePath) {
  const ext = path.extname(imagePath).toLowerCase().slice(1);
  const mimeTypes = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
  const mime = mimeTypes[ext] || "application/octet-stream";
  const data = fs.readFileSync(imagePath);
  const encoded = data.toString("base64");
  return `data:${mime};base64,${encoded}`;
}

/**
 * Decode a base64 data URI back to a Buffer.
 * @param {string} dataUri - The data URI string.
 * @returns {Buffer} Raw image bytes.
 */
function decodeDataUri(dataUri) {
  const comma = dataUri.indexOf(",");
  if (comma === -1) throw new Error("Invalid data URI");
  const base64 = dataUri.slice(comma + 1);
  return Buffer.from(base64, "base64");
}

module.exports = { encodeImageToDataUri, decodeDataUri };
