declare module "mammoth/mammoth.browser" {
  type ConversionResult = { value: string; messages: unknown[] };
  export function convertToHtml(options: { arrayBuffer: ArrayBuffer }): Promise<ConversionResult>;
  export function extractRawText(options: { arrayBuffer: ArrayBuffer }): Promise<ConversionResult>;
  const mammoth: {
    convertToHtml: typeof convertToHtml;
    extractRawText: typeof extractRawText;
  };
  export default mammoth;
}