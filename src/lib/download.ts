/**
 * Hand the browser a file to save, from data the page already has.
 *
 * An object URL rather than a `data:` URI — exports here can run to several
 * megabytes, which is past what some browsers accept in a URL — and it is
 * revoked on the next tick so the blob does not sit in memory for the life
 * of the tab.
 */
export function downloadTextFile(filename: string, mimeType: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: `${mimeType};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
