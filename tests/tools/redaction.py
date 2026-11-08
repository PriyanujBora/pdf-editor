"""Checks a redacted export of tests/fixtures/redaction.pdf with independent readers.

Usage: python tests/tools/redaction.py <redacted.pdf>
Prints one line per check and "RESULT PASS" / "RESULT FAIL".
"""
import re
import subprocess
import sys
import warnings

import pikepdf
import pypdf
import pypdfium2 as pdfium

sys.stdout.reconfigure(encoding='utf-8')
path = sys.argv[1]
GONE = ['John', 'Sample', 'john.sample@example.com', 'ABCDE1234F', '4111', '98765', 'ZEBRA', '7731', 'HIDDEN-LAYER', 'Agent K', 'notes.txt', 'app.alert']
KEPT = {0: ['Case file 2026-114', 'Unrelated paragraph stays exactly as it was.', 'Name:', 'Wire to'], 1: ['Invisible OCR line mentions']}
# Page-space rectangles (top-left origin) that must render black: the "Manafort" box and the image mark.
BLACK = [(120, 228, 270, 248), (130, 298, 196, 366)]
fails = []


def check(name, ok, detail=''):
    print(('ok    ' if ok else 'FAIL  ') + name + (f' — {detail}' if detail and not ok else ''))
    if not ok:
        fails.append(name)


def squash(s):
    return re.sub(r'\s+', '', s).lower()


# 1. Text extraction by three readers.
txt_pdftotext = [subprocess.run(['pdftotext', '-f', str(i + 1), '-l', str(i + 1), path, '-'], capture_output=True).stdout.decode('utf-8', 'replace') for i in range(2)]
with warnings.catch_warnings():
    warnings.simplefilter('ignore')
    txt_pypdf = [p.extract_text() or '' for p in pypdf.PdfReader(path).pages]
doc = pdfium.PdfDocument(path)
txt_pdfium = []
for i in range(len(doc)):
    tp = doc[i].get_textpage()
    txt_pdfium.append(tp.get_text_range())
for tool, pages in (('pdftotext', txt_pdftotext), ('pypdf', txt_pypdf), ('PDFium', txt_pdfium)):
    all_text = squash(''.join(pages))
    left = [g for g in GONE if squash(g) in all_text]
    check(f'{tool}: marked text gone', not left, f'still found: {left}')
    for i, want in KEPT.items():
        missing = [k for k in want if squash(k) not in squash(pages[i] if i < len(pages) else '')]
        check(f'{tool}: page {i + 1} unmarked text kept', not missing, f'missing: {missing}')

# 2. Raw scan of every object in the file (reachable or not): strings and decoded streams.
pdf = pikepdf.open(path)
hits = set()
needles = [(g, [g.encode('latin-1'), g.encode('utf-16-be'), g.encode('latin-1').hex().encode()]) for g in GONE]


def scan_bytes(b, where):
    low = b.lower()
    for g, forms in needles:
        if any(f.lower() in low for f in forms):
            hits.add((g, where))


def walk(o, where, depth=0):
    if depth > 40:
        return
    if isinstance(o, pikepdf.String):
        scan_bytes(bytes(o), where)
    elif isinstance(o, pikepdf.Dictionary) or isinstance(o, pikepdf.Stream):
        d = o.stream_dict if isinstance(o, pikepdf.Stream) else o
        for k, v in d.items():
            if not (isinstance(v, pikepdf.Object) and v.is_indirect):
                walk(v, where, depth + 1)
    elif isinstance(o, pikepdf.Array):
        for v in o:
            if not (isinstance(v, pikepdf.Object) and v.is_indirect):
                walk(v, where, depth + 1)


for o in pdf.objects:
    if not isinstance(o, pikepdf.Object) or o.objgen == (0, 0):
        continue
    walk(o, f'obj {o.objgen[0]}')
    if isinstance(o, pikepdf.Stream) and o.stream_dict.get('/Subtype') != '/Image':
        try:
            scan_bytes(o.read_bytes(), f'stream {o.objgen[0]}')
        except Exception:
            pass
walk(pdf.trailer, 'trailer')
check('raw objects: no marked string anywhere', not hits, f'{sorted(hits)[:8]}')

# 3. Images: the red half is gone from every image object; the vector signature's coordinates too.
red = 0
for o in pdf.objects:
    if isinstance(o, pikepdf.Stream) and o.stream_dict.get('/Subtype') == '/Image':
        try:
            im = pikepdf.PdfImage(o).as_pil_image().convert('RGB')
        except Exception:
            continue
        red += sum(1 for r, g, b in im.getdata() if r > 200 and g < 80 and b < 80)
check('images: no red pixel survives', red == 0, f'{red} red pixels')
sig = any(b'301.37' in o.read_bytes() for o in pdf.objects if isinstance(o, pikepdf.Stream) and o.stream_dict.get('/Subtype') != '/Image')
check('vector path under a mark removed', not sig)

# 4. Document-level clean-up.
root = pdf.Root
names = root.get('/Names', pikepdf.Dictionary())
check('no JavaScript', '/JavaScript' not in names and '/OpenAction' not in root)
check('no attachments', '/EmbeddedFiles' not in names and '/AF' not in root)
check('no hidden layers', '/OCProperties' not in root)
check('no metadata', '/Metadata' not in root and not any(k in pdf.trailer.get('/Info', {}) for k in ('/Title', '/Author')))
annots = [a for p in pdf.pages for a in p.get('/Annots', [])]
check('no comments, no mailto link', not any(a.get('/Subtype') in ('/Text', '/Popup') for a in annots) and not any('/A' in a and 'mailto' in str(a.A.get('/URI', '')) for a in annots))
fields = list(root.get('/AcroForm', {}).get('/Fields', []))
check('form values cleared', all('/V' not in f or str(f.V) in ('', '/Off') for f in fields))
outline = root.get('/Outlines')
title = str(outline.First.Title) if outline is not None and '/First' in outline else ''
check('bookmark kept, name scrubbed', bool(title) and 'John' not in title, title)

# 5. Renders, black boxes in place, Ghostscript parses it.
page = doc[0]
bmp = page.render(scale=1).to_pil().convert('L')
h = bmp.height
for (x0, y0, x1, y1) in BLACK:
    box = bmp.crop((int(x0) + 2, int(y0) + 2, int(x1) - 2, int(y1) - 2))
    px = list(box.getdata())
    check(f'black box at {x0},{y0} rendered', sum(px) / len(px) < 20, f'mean {sum(px) / len(px):.0f}')
exe = 'gswin64c' if sys.platform == 'win32' else 'gs'
try:
    r = subprocess.run([exe, '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=nullpage', path], capture_output=True, text=True, timeout=120)
    msgs = (r.stdout + r.stderr).strip()
    check('Ghostscript parses it', r.returncode == 0 and not re.search(r'error', msgs, re.I), msgs[:200])
except FileNotFoundError:
    print('skip  Ghostscript not installed')

print('RESULT ' + ('PASS' if not fails else f'FAIL ({len(fails)})'))
sys.exit(1 if fails else 0)
