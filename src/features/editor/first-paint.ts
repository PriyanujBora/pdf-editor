/** Resolves once a page canvas is on screen (thumbnails wait for it: pdf.js has one worker). */
export const firstPaint = (() => {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, done: () => resolve() }
})()
