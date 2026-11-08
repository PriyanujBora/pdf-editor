"""Checks a filled export of tests/fixtures/form.pdf.  python forms.py <pdf> filled|flattened"""
import re
import subprocess
import sys

import pikepdf
import pypdf
import pypdfium2 as pdfium

sys.stdout.reconfigure(encoding='utf-8')
path, mode = sys.argv[1], sys.argv[2]
fails = []


def check(name, ok, detail=''):
    print(('ok    ' if ok else 'FAIL  ') + name + (f' — {detail}' if detail and not ok else ''))
    if not ok:
        fails.append(name)


want = {'name': 'Grace Hopper ₹', 'notes': 'Line one\nLine two edited', 'agree': '/Off', 'size': '/L', 'country': 'Kenya', 'languages': 'Hindi'}
pdfium.PdfDocument(path)[0].render(scale=1)  # renders
if mode == 'filled':
    r = pypdf.PdfReader(path)
    fields = r.get_fields() or {}
    pdf0 = pikepdf.open(path)
    opts = {str(f.get('/T')): [str(o) for o in f.Opt] for f in pdf0.Root.AcroForm.Fields if '/Opt' in f}
    for k, v in want.items():
        got = fields.get(k, {}).get('/V')
        got = got[0] if isinstance(got, list) else got
        # Buttons with /Opt name their states by index: /2 means /Opt[2].
        if k in opts and re.fullmatch(r'/\d+', str(got)) and str(fields[k].get('/FT')) == '/Btn':
            got = '/' + opts[k][int(str(got)[1:])]
        check(f'value of {k}', str(got) == v, f'{got!r}')
    # Untouched fields keep their values and the calculation script.
    check('untouched fields kept', str(fields.get('a', {}).get('/V')) == '2' and str(fields.get('total', {}).get('/V')) == '5')
    pdf = pikepdf.open(path)
    calc = [f for f in pdf.Root.AcroForm.Fields if str(f.get('/T')) == 'total']
    check('calculation script kept', bool(calc) and '/AA' in calc[0])
    # The name field's appearance shows the new value (₹ needs an embedded font).
    w = [f for f in pdf.Root.AcroForm.Fields if str(f.get('/T')) == 'name'][0]
    w = w.Kids[0] if '/Kids' in w else w  # the widget carries the appearance
    ap = w.AP.N.read_bytes()
    fonts = list(w.AP.N.Resources.Font.values())
    check('appearance redrawn', b'Tj' in ap or b'TJ' in ap)
    check('₹ drawn with an embedded font', any('/FontFile2' in (f.get('/FontDescriptor') or {}) or '/DescendantFonts' in f for f in fonts), str([f.get('/BaseFont') for f in fonts]))
else:
    r = pypdf.PdfReader(path)
    check('no fields after flatten', not r.get_fields())
    txt = subprocess.run(['pdftotext', '-f', '1', '-l', '1', path, '-'], capture_output=True).stdout.decode('utf-8', 'replace')
    check('flattened values are page text', 'Grace Hopper' in txt and 'Kenya' in txt and 'edited' in txt, txt[:200])
print('RESULT ' + ('PASS' if not fails else 'FAIL'))
sys.exit(1 if fails else 0)
