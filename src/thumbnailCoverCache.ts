const maxEntries = 128;
const maxStringBytes = 16 * 1024 * 1024;

const covers = new Map<string, { dataUrl: string; bytes: number }>();
let stringBytes = 0;

export function getThumbnailCover(paperId: string): string | null {
  const cover = covers.get(paperId);
  if (!cover) return null;
  covers.delete(paperId);
  covers.set(paperId, cover);
  return cover.dataUrl;
}

export function saveThumbnailCover(paperId: string, dataUrl: string) {
  const bytes = dataUrl.length * 2;
  removeThumbnailCover(paperId);
  if (bytes > maxStringBytes) return;
  covers.set(paperId, { dataUrl, bytes });
  stringBytes += bytes;
  while (covers.size > maxEntries || stringBytes > maxStringBytes) {
    const oldest = covers.keys().next().value;
    if (oldest === undefined) break;
    removeThumbnailCover(oldest);
  }
}

export function removeThumbnailCover(paperId: string) {
  const cover = covers.get(paperId);
  if (!cover) return;
  covers.delete(paperId);
  stringBytes -= cover.bytes;
}
