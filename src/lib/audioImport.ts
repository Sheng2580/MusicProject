export const MP3_FILE_ACCEPT = '.mp3,audio/mpeg,audio/mp3';

export function isMp3FileName(fileName: string): boolean {
  return /\.mp3$/i.test(fileName);
}
