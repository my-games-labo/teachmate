import { extractText, getDocumentProxy } from "unpdf";

/** PDF バッファからテキストを抽出する（unpdf = 最新 pdfjs ベース）。 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}
