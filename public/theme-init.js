// Applies the saved/OS theme before first paint (no flash). Kept as a file so
// the Content-Security-Policy needs no inline-script hashes.
try {
  var t = localStorage.getItem('theme')
  if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark')
} catch (e) {}
