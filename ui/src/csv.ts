export type CsvEncoding = 'utf-8' | 'gb18030';

export interface DecodedCsv {
  text: string;
  encoding: CsvEncoding;
  warning?: string;
}

/**
 * Broker exports are usually UTF-8, but mainland brokers often emit GB18030.
 * Decode strictly first so mojibake never reaches the preview, then fall back.
 */
export async function decodeCsvFile(file: File): Promise<DecodedCsv> {
  const buffer = await file.arrayBuffer();
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    try {
      return { text: new TextDecoder('gb18030').decode(buffer), encoding: 'gb18030' };
    } catch {
      return {
        text: new TextDecoder('utf-8').decode(buffer),
        encoding: 'utf-8',
        warning: '无法确认文件编码，已按 UTF-8 读取；如果中文乱码，请另存为 UTF-8 后重试。'
      };
    }
  }
}
