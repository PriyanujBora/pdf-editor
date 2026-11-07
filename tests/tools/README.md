# PDF tools for tests (dev only)

The edit-stability harness checks exports with PDFium (Chrome's PDF engine) and pypdf. Set up once:

```
python -m venv tests/.venv
tests/.venv/Scripts/python -m pip install -r tests/tools/requirements.txt   # Windows
tests/.venv/bin/python -m pip install -r tests/tools/requirements.txt       # macOS / Linux
```

Or point `PDF_TOOLS_PY` at another Python with the same packages. Nothing here ships with the app.
