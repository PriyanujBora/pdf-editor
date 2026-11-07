"""Scores tests/fidelity.mjs runs. Usage: fidelity.py runs.json"""
import hashlib
import json
import re
import subprocess
import sys
import warnings

import pikepdf
import pypdf
import pypdfium2 as pdfium

sys.stdout.reconfigure(encoding='utf-8')
OWNER = 'owner'


def dest_page(pdf, d, named):
    if d is None:
        return None
    if isinstance(d, (pikepdf.String, pikepdf.Name)):
        return named.get(str(d))
    if isinstance(d, pikepdf.Dictionary) and '/D' in d:
        return dest_page(pdf, d.D, named)
    if isinstance(d, pikepdf.Array) and len(d):
        try:
            return pdf.pages.index(pikepdf.Page(d[0]))
        except Exception:
            return None
    return None


def inventory(path, pw=''):
    pdf = pikepdf.open(path, password=pw)
    R = pdf.Root
    named = {}
    names = R.get('/Names')
    if names is not None and '/Dests' in names:
        def walk(node):
            for k in node.get('/Kids', []):
                walk(k)
            arr = node.get('/Names', [])
            for i in range(0, len(arr) - 1, 2):
                named[str(arr[i])] = arr[i + 1]
        walk(names.Dests)
    named = {k: dest_page(pdf, v, {}) for k, v in named.items()}
    outline = []
    try:
        with pdf.open_outline() as ol:
            def rec(items, depth):
                for it in items:
                    outline.append((depth, it.title, dest_page(pdf, it.destination if it.destination is not None else (it.action.D if it.action is not None and '/D' in it.action else None), named)))
                    rec(it.children, depth + 1)
            rec(ol.root, 0)
    except Exception:
        pass
    fields = {}
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        r = pypdf.PdfReader(path, password=pw or None)
        for k, f in (r.get_fields() or {}).items():
            fields[k] = str(f.get('/V'))
        labels = list(r.page_labels)
    struct = 0
    if '/StructTreeRoot' in R:
        stack = [R.StructTreeRoot]
        while stack:
            n = stack.pop()
            if isinstance(n, pikepdf.Dictionary):
                if '/S' in n:
                    struct += 1
                k = n.get('/K')
                if k is not None:
                    stack.extend(k if isinstance(k, pikepdf.Array) else [k])
    info = {k: str(v) for k, v in pdf.docinfo.items() if k in ('/Title', '/Author', '/Subject', '/Keywords')}
    return {
        'pages': len(pdf.pages),
        'info': info,
        'xmp': '/Metadata' in R,
        'lang': str(R.get('/Lang', '')),
        'markinfo': '/MarkInfo' in R,
        'struct_elems': struct,
        'outline': outline,
        'named': named,
        'labels': labels,
        'pagemode': str(R.get('/PageMode', '')),
        'viewerprefs': '/ViewerPreferences' in R,
        'fields': fields,
        'calc_order': len(R.get('/AcroForm', {}).get('/CO', [])),
        'attachments': sorted(pdf.attachments.keys()),
        'annots': [len(p.get('/Annots', [])) for p in pdf.pages],
        'encryption': (pdf.encryption.V, pdf.encryption.R, int(pdf.trailer.Encrypt.P)) if pdf.is_encrypted else None,
    }


def unreachable(path, pw=''):
    pdf = pikepdf.open(path, password=pw)
    seen = set()
    stack = [pdf.trailer]
    while stack:
        o = stack.pop()
        if isinstance(o, pikepdf.Object) and o.is_indirect:
            if o.objgen in seen:
                continue
            seen.add(o.objgen)
        if isinstance(o, pikepdf.Stream):
            stack.extend(o.stream_dict.values())
        elif isinstance(o, pikepdf.Dictionary):
            stack.extend(o.values())
        elif isinstance(o, pikepdf.Array):
            stack.extend(list(o))
    return [o.objgen for o in pdf.objects if isinstance(o, pikepdf.Object) and o.objgen != (0, 0) and o.objgen not in seen and not (isinstance(o, pikepdf.Stream) and o.stream_dict.get('/Type') in ('/XRef', '/ObjStm'))]


def contains_marker(path, pw, marker):
    pdf = pikepdf.open(path, password=pw)
    for o in pdf.objects:
        if isinstance(o, pikepdf.Stream):
            try:
                data = o.read_bytes()
            except Exception:
                continue
            if marker.encode('latin-1') in data or marker.encode('latin-1').hex().upper().encode() in data.upper():
                return True
    return False


def renders(path, pw=''):
    doc = pdfium.PdfDocument(path, password=pw or None)
    for i in range(len(doc)):
        doc[i].render(scale=0.5)
    return len(doc)


def ghostscript(path, pw=''):
    exe = 'gswin64c' if sys.platform == 'win32' else 'gs'
    args = [exe, '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=nullpage'] + ([f'-sPDFPassword={pw}'] if pw else []) + [path]
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        return 'not installed'
    msgs = (r.stdout + r.stderr).strip()
    return 'ok' if r.returncode == 0 and not re.search(r'error', msgs, re.I) else msgs[:200]


runs = json.load(open(sys.argv[1], encoding='utf-8'))
results = []
for run in runs:
    name, sc, pw = run['name'], run['scenario'], run['password'] or ''
    problems = []
    if run.get('error'):
        results.append((name, sc, [run['error']]))
        continue
    if run['errors']:
        problems.append(f'page errors: {run["errors"][:2]}')
    src = inventory(run['file'], pw)
    out_pw = '' if sc == 'removed' else pw
    try:
        out = inventory(run['out'], out_pw)
    except Exception as e:
        results.append((name, sc, [f'cannot open output: {e}']))
        continue
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        try:
            pypdf.PdfReader(run['out'], strict=True, password=out_pw or None).pages[0].mediabox
        except Exception as e:
            problems.append(f'pypdf strict: {e}')
    try:
        renders(run['out'], out_pw)
    except Exception as e:
        problems.append(f'PDFium: {e}')
    gs = ghostscript(run['out'], out_pw)
    if gs not in ('ok', 'not installed'):
        problems.append(f'Ghostscript: {gs}')

    if sc == 'noedit':
        same = hashlib.sha256(open(run['file'], 'rb').read()).digest() == hashlib.sha256(open(run['out'], 'rb').read()).digest()
        if not same:
            problems.append('no-edit download is not the original file')
    expected = dict(src)
    if sc == 'removed':
        expected['encryption'] = None
    if sc == 'pages':
        order = run['order']
        old_pages = src['pages']
        deleted = [i for i in range(old_pages) if i not in order]
        remap = {old: new for new, old in enumerate(order)}
        expected['pages'] = len(order)
        # Files without /PageLabels are numbered 1, 2, 3 by viewers; real labels follow their pages.
        src_pdf = pikepdf.open(run['file'], password=pw)
        if '/PageLabels' in src_pdf.Root:
            expected['labels'] = [src['labels'][i] for i in order]
        else:
            expected['labels'] = [str(i + 1) for i in range(len(order))]
        expected['annots'] = None  # links to deleted pages are removed: checked via outline/named below
        exp_outline = []
        for j, (depth, title, page) in enumerate(src['outline']):
            has_kids = j + 1 < len(src['outline']) and src['outline'][j + 1][0] > depth
            if page in deleted:
                if has_kids:
                    exp_outline.append((depth, title, None))
                continue
            exp_outline.append((depth, title, remap.get(page, page)))
        expected['outline'] = exp_outline
        expected['named'] = {k: remap[v] for k, v in src['named'].items() if v not in deleted and v is not None}
        expected['struct_elems'] = None  # tags of the deleted page are pruned
        expected['fields'] = None
        for i in deleted:
            marker = f'page-{i + 1}-'
            # Every fixture page carries "Unique marker page-N-…": a deleted page must leave the file.
            text_markers = [m for m in ('zq', 'tg') for _ in [0]]
            for m in text_markers:
                if contains_marker(run['out'], out_pw, f'{marker}{m}{i}x'):
                    problems.append(f'deleted page {i + 1} still in the file')
        if src['struct_elems'] and not out['struct_elems']:
            problems.append('structure tree lost')
        if src['fields'] and not out['fields']:
            problems.append('form lost')
    if sc == 'edit':
        expected['annots'] = None
    for k, v in expected.items():
        if v is None and k != 'encryption':
            continue
        if out[k] != v:
            problems.append(f'{k}: {str(src[k])[:90]} -> {str(out[k])[:90]}')
    if pw and sc != 'removed':
        try:
            pikepdf.open(run['out'], password=OWNER)
        except Exception:
            problems.append('owner password no longer opens the file')
        try:
            if pikepdf.open(run['out'], password=pw).allow != pikepdf.open(run['file'], password=pw).allow:
                problems.append('permissions changed')
        except Exception as e:
            problems.append(f'permissions: {e}')
    orphans = unreachable(run['out'], out_pw) if sc != 'noedit' else []  # noedit = the original file
    if orphans:
        problems.append(f'{len(orphans)} unreachable objects in the file')
    results.append((name, sc, problems))

ok = True
print('| Fixture | ' + ' | '.join(['noedit', 'rebuild', 'pages', 'edit', 'removed']) + ' |')
print('|---|---|---|---|---|---|')
for name in dict.fromkeys(r[0] for r in results):
    cells = []
    for sc in ['noedit', 'rebuild', 'pages', 'edit', 'removed']:
        rr = [r for r in results if r[0] == name and r[1] == sc]
        cells.append('–' if not rr else ('ok' if not rr[0][2] else 'FAIL'))
    print(f'| {name} | ' + ' | '.join(cells) + ' |')
for name, sc, problems in results:
    for p in problems:
        ok = False
        print(f'  FAIL {name} / {sc}: {p}')
print('RESULT PASS' if ok else 'RESULT FAIL')
