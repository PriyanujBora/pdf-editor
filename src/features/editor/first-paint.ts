/** Resolves once a page canvas is on screen (thumbnails wait for it: pdf.js has one worker). */
export const firstPaint = (() => {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => (resolve = r))
  const state = {
    promise,
    painted: false,
    done: () => {
      state.painted = true
      resolve()
    },
  }
  return state
})()
